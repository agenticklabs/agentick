# 07 — Tool Executor Harness

**Status:** Synthesized with placeholders
`[SOURCE: executor.md §Tool Executor Harness, harness-principle.md, compiled-spec.md, loop-executor.md]`

The tool executor harness is the boundary that turns tool calls into tool
results. It is invoked by the loop executor (when the model requests an
Agentick-managed tool) and directly by the session harness (when the host
calls `session.dispatch(name, input)`). Both routes converge on the same
harness boundary — the **two doors** of v1, preserved with a unified
implementation.

```
                ┌────────────────────────────────┐
                │       Tool executor            │
                │                                │
   commands ──► │   dispatch · abort             │ ──► events
                │                                │
   interceptors◄┤   tool registry · validators   │ ──► outcomes
                │   confirmation flow            │
                └────────────────────────────────┘
```

`[V1-REPLACED]` of v1's `ToolExecutor` class
(`packages/core/src/tool/executor.ts`-equivalent inside session.ts) plus
the inline confirmation flow plus `ExecutionRunner.executeToolCall`.

## What this harness manages

- The mounted tool registry (resolved from `ToolDeclaration[]` plus tools
  registered by the runtime).
- Input validation against tool input schemas.
- Tool handler invocation (with `use:` dependency injection from the
  React harness's hook context capture).
- Confirmation flow for tools that require it.
- Per-tool timeout and retry hooks.
- Tool result capture and propagation.

It does NOT manage:

- Multi-tick orchestration (loop executor).
- Provider tool definitions in the model call (executor harness, when
  projecting `ToolDeclaration` to provider format).
- Tool handler bodies themselves (user code, beyond the harness boundary).

## The two doors

```
Model door                             Host door
──────────                             ─────────
loop executor sees toolCalls[]         session.dispatch(name, input)
  in ExecutionResult                     │
   │                                     │
   ▼                                     ▼
                  tool executor harness boundary
                   ── dispatch(name, input, ctx) ──►
                                │
                                ▼
                  validate · confirm · invoke handler
                                │
                                ▼
                          ToolResult
```

Same blast radius, same registries, same interceptors — by construction.

The model door reaches tools with `exposure` containing `"model"`. The
host door reaches tools with `exposure` containing `"dispatch"`. A tool
with `exposure: ["model", "dispatch"]` is reachable both ways. A tool
with `exposure: ["runtime"]` is internal and reachable by neither.

`[V1-REPLACED]` of v1's `audience: "model" | "user" | "all"`.

## Commands in

```ts
interface ToolExecutorProtocol {
  dispatch(input: DispatchInput): Effect<ToolResult, ToolExecutorError, ToolExecutorEnv>;

  abort(toolCallId: string): Effect<void, never, ToolExecutorEnv>;
}

interface DispatchInput {
  /** Stable per-call ID. From model: provider's tool-call id. From host: generated. */
  toolCallId: string;
  /** Tool name (or alias resolved by the registry). */
  name: string;
  /** Validated against the tool's inputSchema before handler runs. */
  input: unknown;
  /** Caller context: who invoked, scopes, request metadata. */
  context: DispatchContext;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

interface DispatchContext {
  /** "model" if invoked from a model tool_call; "dispatch" if host-invoked. */
  via: "model" | "dispatch";
  sessionId?: string;
  executionId?: string;
  tickId?: string;
  /** Caller-supplied request context (user, requestId, etc.). */
  request?: Record<string, unknown>;
  /** Captured render-time deps via React harness's use: hook. */
  use?: Record<string, unknown>;
}
```

`ToolResult` `[V1-INHERITED]` from `packages/shared/src/tools.ts`:

```ts
interface ToolResult {
  id?: string;
  toolUseId: string;
  name: string;
  success: boolean;
  content: ContentBlock[];
  error?: string;
  executedBy?: ToolExecutor; // engine | adapter | provider | client
  metadata?: {
    executionTimeMs?: number;
    retryCount?: number;
    cacheHit?: boolean;
    [k: string]: unknown;
  };
}
```

`ToolExecutor` enum is `[V1-INHERITED]` and unchanged.

## Events out

All on `surface: "tool"`.

```
tool:dispatch:requested            tool:dispatch:before
tool:dispatch:terminal             (with ToolResult or error)

tool:validation:terminal           (input validation outcome)
tool:confirmation:requested        (when requiresConfirmation=true)
tool:confirmation:resolved         (after user response)
tool:handler:started               (right before handler invocation)
tool:handler:completed             (handler returned)
tool:handler:errored               (handler threw)
```

`[V1-REPLACED]` of v1's `tool_result_start`, `tool_result`,
`tool_confirmation_required`, `tool_confirmation_result`. Same semantics
in envelope form.

## Lifecycle handlers + middleware

Per the five-surface model:

```ts
// Lifecycle handlers (.onX)
toolExecutor.onConfirmationRequired(handler: (req: ConfirmationRequest) => Promise<HandlerVerdict | void>)
toolExecutor.onValidationError(handler: (err: ToolValidationError) => void)
toolExecutor.onHandlerError(handler: (err: ToolHandlerError) => Promise<HandlerVerdict | void>)

// Middleware (.use, around-style)
toolExecutor.use({
  aroundDispatch: (input, next) => { ... },        // wrap whole dispatch
});
```

Common uses:

| Surface                                      | Use case                             |
| -------------------------------------------- | ------------------------------------ |
| `aroundDispatch` veto                        | Permission denied for this user/tool |
| `aroundDispatch` replace                     | Test fixture, sandbox proxy          |
| `aroundDispatch` (input rewrite before next) | Sanitize input                       |
| `aroundDispatch` (result rewrite after next) | Redact secrets in result             |
| `onConfirmationRequired` replace verdict     | Auto-approve in tests                |
| `onHandlerError` replace verdict             | Retry with adjusted input            |

`[V1-REPLACED]` of v1's `ExecutionRunner.executeToolCall(call, tool, next)` —
that's `aroundDispatch` middleware with around-style replace semantics.

## Inbox messages

The tool executor accepts inbound messages at address
`tool:{sessionId}` (one per session):

| Message type            | Payload                                   | Effect                                  |
| ----------------------- | ----------------------------------------- | --------------------------------------- |
| `abort`                 | `{ toolCallId: string; reason?: string }` | Aborts an in-flight tool dispatch.      |
| `confirmation-response` | `ToolConfirmationReply`                   | Resolves a pending confirmation prompt. |

The `confirmation-response` message is how the gateway / external client
delivers the user's approval/denial for a tool requiring confirmation.
Same handler signature whether routed locally (in-process gateway) or
across the cluster (remote gateway).

## Outcomes and failures

```ts
type ToolExecutorError =
  | ToolNotFoundError
  | ToolValidationError
  | ToolHandlerError
  | ToolPermissionError
  | ToolTimeoutError
  | ToolConfirmationDeniedError
  | ToolConfirmationTimeoutError;

interface ToolNotFoundError {
  _tag: "ToolNotFoundError";
  name: string;
  registered: string[];
}

interface ToolValidationError {
  _tag: "ToolValidationError";
  toolName: string;
  issues: readonly StandardSchemaIssue[];
}

interface ToolHandlerError {
  _tag: "ToolHandlerError";
  toolName: string;
  cause: unknown;
}

interface ToolPermissionError {
  _tag: "ToolPermissionError";
  toolName: string;
  reason?: string;
}

interface ToolTimeoutError {
  _tag: "ToolTimeoutError";
  toolName: string;
  ms: number;
}

interface ToolConfirmationDeniedError {
  _tag: "ToolConfirmationDeniedError";
  toolName: string;
  reason?: string;
}

interface ToolConfirmationTimeoutError {
  _tag: "ToolConfirmationTimeoutError";
  toolName: string;
  ms: number;
}
```

## Dispatch flow

```
1) Resolve tool by name (then by alias) in the registry
   - Not found → ToolNotFoundError → terminal { failed }

2) Validate input against tool.inputSchema (Standard Schema validate)
   - Issues → ToolValidationError → terminal { failed }
   - Emit tool:validation:terminal { succeeded }

3) Run dispatch interceptors (before phase)
   - veto → terminal { vetoed }
   - replace → terminal { replaced, result }
   - defer → terminal { deferred, retryAfter }
   - proceed → continue

4) If tool requires confirmation:
   Emit tool:confirmation:requested
   Run on-confirmation-required interceptors
     - replace { approved: true }  → skip prompt
     - replace { approved: false } → ToolConfirmationDeniedError
   Else: prompt user via session:tool_confirmation channel
   Wait (with tool.timeout fallback)
   Receive ToolConfirmationReply
     - approved: true → continue
     - approved: false → ToolConfirmationDeniedError → terminal { failed }
   Emit tool:confirmation:resolved

5) Resolve use: deps captured at React render time
   (these are the values bound by the createTool({ use: () => ({...}) }))

6) Emit tool:handler:started
   Invoke handler with (validated input, deps)
   - throws → ToolHandlerError
     run on-tool-error interceptors
       - replace { result } → use as result
       - proceed → terminal { failed }
   - returns → ToolResult

7) Run dispatch interceptors (after phase)
   - replace { result } → swap result
   - veto/defer not allowed in after-phase

8) Emit tool:handler:completed
   Emit tool:dispatch:terminal { succeeded, result }
```

## Confirmation flow `[V1-INHERITED, REFINED]`

The framework channel `session:tool_confirmation` is unchanged
(`[SOURCE: shared/src/protocol.ts]`):

The ask carries no type of its own — it is the `metadata` on an elicitation
request (`hints.kind === "tool_confirmation"`), holding `toolUseId` /
`toolName` / `arguments` and an optional `preview` (including
`DiffPreviewMetadata`). The host's answer is validated against
`TOOL_CONFIRMATION_REPLY_SCHEMA`; what the executor reports afterwards is
`ToolConfirmationResolution`:

```ts
interface ToolConfirmationReply {
  approved: boolean;
  always?: boolean;
  reason?: string;
  modifiedArguments?: Record<string, unknown>;
}

interface ToolConfirmationResolution {
  toolUseId: string;
  /** Canonical — the declaration's own name, never the alias dispatched by. */
  toolName: string;
  sessionId: string;
  outcome: "approved" | "denied" | "timeout" | "aborted";
  arguments: Record<string, unknown>;
  reason?: string;
  always?: boolean;
  modifiedArguments?: Record<string, unknown>;
}
```

The resolution is PUBLISHED, not remembered. It rides
`DispatchResult.confirmation` for the three arms that resolve and
`ToolConfirmationTimeoutError.confirmation` for the one that rejects, so an
`onAfterToolDispatch` hook sees every decision. `always: true` is relayed on
that record and nothing more — the executor holds no allow-list, and a
deployment that wants a standing grant writes one from the hook and reads it
back through `confirmationPolicy`. `modifiedArguments` causes a re-validation
pass before handler invocation; an edit that fails it rejects the dispatch, so
no record claims an approval that never ran.

A tool that declares no `requiresConfirmation` gets a verdict derived from its
advisory hints — `destructiveHint: true` asks, `readOnlyHint: true` never does
(read-only wins when both are set, per MCP's own scoping). `withMCP`
materializes the MCP spec's absence-defaults, so a server that annotated
nothing yields a destructive tool and its calls are confirmed with no adopter
policy in the path.

`DiffPreviewMetadata` (file edit tools) is `[V1-INHERITED]`.

## Tool registry

```ts
interface ToolRegistry {
  register(decl: ToolDeclaration, handler: ToolHandler): void;
  resolve(name: string): ResolvedTool | undefined;
  list(filter?: ToolListFilter): ToolDeclaration[];
}

interface ResolvedTool {
  declaration: ToolDeclaration;
  handler: ToolHandler;
  /** Captured at React render time (or undefined for non-React tools). */
  useDeps?: Record<string, unknown>;
  /** Compiled validator. */
  validator: StandardSchemaV1<unknown, unknown>;
}

interface ToolHandler {
  (
    input: unknown,
    deps: { ctx: ToolHandlerCtx; use: Record<string, unknown> },
  ): Promise<ContentBlock[]> | ContentBlock[];
}

interface ToolHandlerCtx {
  toolCallId: string;
  sessionId?: string;
  executionId?: string;
  signal: AbortSignal;
  setState(key: string, value: unknown): void; // [V1-INHERITED] stateful tool pattern
  emit(event: ChannelEvent): void;
}
```

`[PLACEHOLDER]` `ToolHandlerCtx` shape — synthesized from v1 stateful
tool pattern (`[SOURCE: CLAUDE.md §Stateful Tool Pattern]`). Sign-off
needed.

## Use: dependency capture (React-side)

When tools are declared via `<Tool>` JSX or `createTool()`, the React
harness captures `use:` deps at render time:

```tsx
const ShellTool = createTool({
  name: "shell",
  description: "Execute a command",
  inputSchema: z.object({ command: z.string() }),
  use: () => ({ sandbox: useSandbox() }), // captured at render time
  handler: async ({ command }, deps) => {
    const out = await deps!.sandbox.exec(command);
    return [{ type: "text", text: out.stdout }];
  },
});
```

The React harness:

1. Calls `use()` during renderTree (it's a hook function).
2. Stores the returned object in the resolved-tool registry entry,
   keyed by the tool declaration's `id`.
3. The tool executor reads `useDeps` at dispatch time and passes them as
   the `deps.use` parameter.

`[V1-INHERITED]` exactly from v1's `createTool({ use: () => ... })`
pattern. Refined: in v2 the captured deps are part of the registry
entry rather than a closure on the handler.

## Tool exposure routing

```
ToolDeclaration.exposure  has  "model"
  ──► executor.project includes this tool in provider tools[]
  ──► incoming tool_use blocks invoke dispatch(via:"model")

ToolDeclaration.exposure  has  "dispatch"
  ──► reachable from session.dispatch(name, input)
  ──► invokes dispatch(via:"dispatch")

ToolDeclaration.exposure  has  "runtime"
  ──► internal use only (e.g., framework-internal helpers)
  ──► reachable via the runtime's privileged dispatch path
  ──► not exposed via session.dispatch or model tool calls
```

A tool with no exposure entries is invalid (compile error in
`react.renderTree` validation).

## Output tools `[V1-INHERITED]`

Tools with `exposure: ["model"]` and `OutputDeclaration` semantics return
their input as a structured output instead of producing a tool result for
the model. v1 used `ToolExecutionType.OUTPUT`; v2 uses `OutputDeclaration`
plus a tool whose handler captures the input into the
`StateApplicator.applyExecutorResult` outputs map.

```
Author writes:                                  Compiled to:
  <Output id="decide" schema={Decide} />          OutputDeclaration { id, schema }
  <Tool name="decide" output={...} />             ToolDeclaration { exposure: ["model"], ... }

At dispatch:
  validate input
  do not invoke a "user" handler — handler captures input into
    ExecutionRunResult.outputs["decide"] via the state applicator
  return a sentinel ToolResult that the loop ignores
```

`[GAP]` — exact wiring of `OutputDeclaration` to handler is open. Blueprint
position `[PROPOSAL]`: `OutputDeclaration` + a Tool with the same `id`
register a synthetic handler that the tool executor recognizes by id and
routes through `StateApplicator.captureOutput(declId, input)`. Sign-off
needed.

## Provider-side tool execution

Tools where the provider executes the tool body (Google grounding, OpenAI
code interpreter, etc.) appear with `exposure: ["model"]` AND a marker
the executor recognizes. The executor returns `tool_result` blocks in
`output` and OMITS the corresponding entry from `toolCalls[]`. The tool
executor never sees these — they don't reach dispatch.

`[GAP]` — explicit marker shape on `ToolDeclaration` for provider-side
execution is open (carried over from `06-executor-harness.md`).

## Client-executed tools `[V1-INHERITED]`

Some tools execute in the client (browser, TUI). Pattern:

1. `ToolDeclaration` is registered with `exposure: ["model"]` and
   `annotations.intent: "render"` (or similar).
2. The model emits `tool_use`.
3. Loop executor calls `toolExecutor.dispatch(...)`.
4. The handler is a client-bridge handler that:
   - Sends the tool call to the connected client via the
     `session:tool_confirmation` (or a future dedicated client-tools)
     channel.
   - Awaits client response (with `tool.annotations.timeout`).
   - Returns the client's `ToolResult`.
5. If `requiresResponse: false`, returns the tool's `defaultResult`
   immediately and does NOT wait.

Marked `executedBy: "client"` on the result.

`[GAP]` `[SOURCE: spec-package.md]` — client tool definition
(`ClientToolDefinition` from v1) needs a v2 home. Blueprint position
`[PROPOSAL]`: client-side tools register through a dedicated bridge
handler at the gateway/transport layer (see `12-gateway.md`); the spec
shape is the same `ToolDeclaration` with `annotations.intent: "render"`
and a transport-routed handler.

## Parallel dispatch

When the loop executor receives multiple tool calls in one
`ExecutionResult.toolCalls[]`, it MAY invoke `dispatch` in parallel:

```ts
yield* Effect.forEach(
  toolCalls,
  call => toolExecutor.dispatch({ toolCallId: call.id, ... }),
  { concurrency: parallelToolCalls ? "unbounded" : 1 }
);
```

Concurrency policy lives on the loop executor (see `05-loop-executor.md`).
The tool executor handles individual dispatches; it doesn't batch.

## Composition with other harnesses

```
Loop executor                 Tool executor
─────────────                 ─────────────
per ToolCall in result.toolCalls:
  ── dispatch(call) ──────►
                                validate · confirm · invoke
                              ◄── ToolResult
  collect

Session harness (host door)
───────────────
session.dispatch(name, input)
  ── dispatch({ via:"dispatch", ... }) ──►
                                validate · confirm · invoke
                              ◄── ContentBlock[]
                              (host door returns content, not ToolResult,
                               for ergonomics)
```

## Stateful tool render() output

`[V1-INHERITED]` from CLAUDE.md §Stateful Tool Pattern.

```tsx
export const TodoListTool = createTool({
  name: "todo_list",
  input: ...,
  handler: async (input, ctx) => { ctx?.setState("list", ...); return [...]; },
  render: () => (
    <Section id="todo-list" audience="model">
      <H2>Todos</H2>
      <Json data={TodoListService.getState()} />
    </Section>
  ),
});
```

The `render()` output of a stateful tool produces a `SectionEntry` in
`RenderedTree.context.entries` on the next compile. v2 keeps this
pattern; the `audience: "model"` becomes implicit (sections are
model-facing) — the prop is dropped from the API.

## Decisions captured

- Tool executor is its own harness, distinct from executor and loop.
- Two doors (model + host) converge on dispatch.
- Exposure replaces v1's audience.
- `use:` deps captured at React render time, passed to handler at
  dispatch.
- Confirmation flow uses session-scoped framework channel.
- Output tools are `OutputDeclaration` + a Tool of the same id.
- Provider-side tools bypass dispatch (executor handles).
- Client-side tools use bridge handlers routed through gateway.
- Parallel dispatch is a loop-executor concern.

## Open questions

- `ToolHandlerCtx` shape (placeholder synthesized; sign-off).
- `OutputDeclaration` ↔ Tool handler wiring (placeholder; sign-off).
- Provider-side tool execution explicit marker (carried from executor).
- Client tool registration mechanism in v2 (lean: gateway-side bridge).
