# @agentick/tool-executor-next

**Reference implementation of `ToolExecutorProtocol`** from
`@agentick/spec-next`.

The tool executor is the boundary that turns tool calls into tool
results. It hosts the runtime's tool registry, validates inputs against
declared schemas, runs the confirmation flow when required, invokes
handlers (sync / async / Effect / `TaskHandle`-returning), threads abort
and timeout, and emits the canonical phase-contract envelope sequence
(`requested → before → terminal`) on `surface: "tool"`.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently. The adopter-facing entry point is
`createApp({ tools })` — you rarely construct the harness by hand.

## Mental model

One harness sits between everything that emits a tool call and the
handler that services it. Whether the call comes from the model, from
host code, from the reconciler's per-tick tool set, or across the inbox
from another cluster node, it funnels through the same
validate → authorize → confirm → invoke → emit pipeline so the lifecycle,
exposure rules, and event stream live in exactly one place.

### Two doors

One harness; two callers.

- **Model door** — the loop executor invokes `dispatch({ via: "model" })`
  when the model emits a `tool_use` block.
- **Host door** — the session harness invokes
  `dispatch({ via: "dispatch" })` when application code calls
  `session.dispatch(name, input)`.

Same validation, same confirmation flow, same interceptors. `via` is
observable to middleware so policies can branch on door without
inspecting private fields.

`dispatch` is a **declared command** (`tool:dispatch`, ADR 51/66) on BOTH
executors — the same promotion `abort` got. Two consequences beyond the
plain-method past:

- **Provenance-stamped at the gate (ADR 51 §5/§6).** The public in-process
  `dispatch` maps the DOOR to the operation's `origin`: `via: "model"` →
  `origin: "model"` (a model-originated tool call — inside the process the
  intentionally untrusted capability-policy subject), `via: "dispatch"` →
  `origin: "host"` (a direct in-process call). The origin is stamped on
  every dispatch envelope (`requested` / `before` / `terminal`) and trusted
  downstream — it completes the journal as an authorization audit log (who,
  via which gate, ran what). Inbox-delivered `tool:dispatch` messages are
  stamped by their delivering gate (`origin: "inbox"`) instead, because
  origin names the GATE, not the `via` the payload claims.
- **Inbox/wire dispatch-by-name.** A `tool:dispatch` message (serializable
  `DispatchInput` payload — `name` + `input` + `context`, no `signal`) to
  the harness's `tool:{scopeId}` address routes through the command registry
  via `BaseHarness.dispatchMessage`; `ask` returns the `DispatchResult`. No
  hand-rolled inbox switch.

The dispatch FLOW is byte-identical to the pre-command method — validation,
before-dispatch lifecycle, ctx build (incl. `ctxExtensions`), abort-signal
composition, task-mode Pattern A/B, confirmation, and timeout are unchanged.
Only the declaration mechanism moved from a hand-built `Operation` +
`runOperation` to `this.command({ name: "tool:dispatch", … })`.

### Exposure routing

`ToolDeclaration.exposure` (a `ToolExposure[]` from
`@agentick/spec-next`, values `"model" | "dispatch" | "runtime"`) decides
which door is reachable:

| `exposure`              | Reachable from             |
| ----------------------- | -------------------------- |
| `["model"]`             | model only                 |
| `["dispatch"]`          | host only                  |
| `["model", "dispatch"]` | both doors                 |
| `["runtime"]`           | internal use; neither door |

The harness enforces exposure at dispatch time (`ToolPermissionError`
for the wrong door).

## Quick start

Most adopters never touch this package directly — they hand a tool set
to `createApp` and the AppHarness constructs the executor on the shared
substrate. For a fully custom executor (remote tool service, alternate
registry storage), use the callback factory `defineToolExecutor`:

```ts
import { createApp } from "@agentick/app-next";
import { defineToolExecutor } from "@agentick/tool-executor-next";

const tools = defineToolExecutor({
  async dispatch(input) {
    const result = await remoteToolService.run(input.name, input.input);
    return {
      toolCallId: input.toolCallId,
      name: input.name,
      succeeded: true,
      content: [{ type: "text", text: result.text }],
    };
  },
});

const app = await createApp(<Agent />, { model, tools });
```

`defineToolExecutor` returns a `ToolExecutorFactory` (a callable tagged
with `toolExecutorFactory: true`). `dispatch` is required; `list` /
`register` / `unregister` / `abort` / `compileForTick` /
`replaceReconcilerTools` / `removeBoundTools` are optional — when omitted
they fall through to a bundled `InMemoryToolRegistry`. The MVP factory
does **not** replicate the validation pipeline or confirmation flow;
subclass `ToolExecutorHarness` if you need those.

### Constructing the reference harness directly

`ToolExecutorHarness` is a `BaseHarness<"tool">` — it needs a substrate
(journal / bus / inbox) and its construction options:

```ts
import {
  ToolExecutorHarness,
  InMemoryHandlerResolver,
  fromStandardSchema,
} from "@agentick/tool-executor-next";
import { z } from "zod";

const resolver = new InMemoryHandlerResolver();
resolver.register(
  "h.calc_add",
  async ({ a, b }) => [{ type: "text", text: String(a + b) }],
  fromStandardSchema(z.object({ a: z.number(), b: z.number() })),
);

const exec = new ToolExecutorHarness(scopeId, journal, bus, inbox, {
  handlerResolver: resolver, // required — resolves handlerRef → handler + validator
  elicitation, // required — backs the confirmation gate + ctx.elicit
  // optional: tasks, resources, channelPublisher, initialTools,
  //           defaultTimeoutMs, defaultConfirmationTimeoutMs
  initialTools: [
    { declaration: calcAddDeclaration, handlerRef: "h.calc_add", binding: { scope: "runtime" } },
  ],
});
await exec.ready;

const result = await exec.dispatch({
  toolCallId: "c_1",
  name: "calc_add",
  input: { a: 1, b: 2 },
  context: { via: "dispatch", sessionId: "s_1" },
});
// → { toolCallId: "c_1", name: "calc_add", succeeded: true,
//     content: [{ type: "text", text: "3" }], executedBy: "agentick", durationMs: … }
```

To skip the substrate boilerplate in tests, use `createTestHarness` from
the `/testing` subpath (see [Testing](#testing)).

## Tool handler ctx surface

Tool handlers receive a unified `ToolHandlerCtx` (per ADR 43) — the same
shape whether invoked in-process by this executor OR by an MCP-server
projection. Adopter code is portable across transports.

```ts
import type { ToolHandler } from "@agentick/tool-executor-next";

const handler: ToolHandler = async (input, { ctx, use }) => {
  // Universal fields — every transport populates these
  ctx.toolCallId; // string
  ctx.signal; // AbortSignal (fires on caller abort / timeout / inbox abort)
  ctx.transport; // "in-process" (here) or "mcp" (MCP-server projection)
  ctx.task; // "auto" | "ref" | "inline" — resolved task mode for this dispatch
  ctx.setState("last", input); // stateful-tool render pattern
  ctx.emit(seed); // publish a channel seed (routed when a publisher is wired)

  // Sugar surfaces — cross-transport portable
  await ctx.elicit?.text("Your name?"); // Elicit sugar (= session.elicit + MCP ctx.elicit)
  const task = ctx.tasks?.submit(runLongJob); // Tasks raw protocol
  await ctx.resource?.read(uri); // Resources read-projection (ADR 62)

  // Raw protocol access (power users)
  await ctx.elicitation?.elicit({ message, schema }); // raw ElicitationHarness

  // Runtime signals — out-of-band diagnostics + liveness (ADR 64)
  ctx.log("info", { step: "started" }, "my-tool"); // → tool:signal:log bus event
  ctx.progress("job-1", { progress: 3, total: 10, message: "…" }); // → tool:signal:progress

  // MCP-specific extras — undefined unless transport === "mcp"
  ctx.mcp?.connectionId;
  ctx.mcp?.clientCapabilities;

  return [{ type: "text", text: "ok" }];
};
```

In-process ctx is built once per dispatch in the executor. The
`ctx.elicit` sugar is constructed via `buildSessionElicit({ harness:
this.elicitation })` (see `@agentick/elicitation-next`); identical
factory + interface to the session-level `session.elicit`.

`use` is the second arg's `use` field — render-time deps captured by the
reconciler when the tool was declared via `<Tool use={() => ({…})}>`,
merged over the registration's `useDeps`. `use` is reserved for
genuinely **tree-positional** context; app-/session-scoped harnesses
belong on `ctx` (see below).

### `ctxExtensions` — the dispatch-resolved extension seam (ADR 66)

Optional harnesses that not every deployment mounts (e.g. sandbox) reach
tool handlers as **typed `ctx` slots**, resolved at dispatch from the
live bridge rather than captured at render. The mechanism is one generic
construction option:

```ts
new ToolExecutorHarness(id, journal, bus, inbox, {
  handlerResolver,
  elicitation,
  // Opaque record spread onto every handler's ctx. The executor NEVER
  // imports or inspects the values.
  ctxExtensions: { sandbox: theSandboxBridge },
});
```

Every key becomes a top-level `ctx.<key>`. The executor treats the
record as an opaque `Readonly<Record<string, unknown>>`:

- **The type** of `ctx.sandbox` comes from a `declare module
  "@agentick/spec-next"` augmentation of `ToolHandlerCtxExtensions` in
  the owning harness package (`@agentick/sandbox-next`). Spec seeds an
  empty `ToolHandlerCtxExtensions {}`; each optional harness adds its own
  slot. This executor hardcodes none.
- **The value** is filled by the wiring layer (the AppHarness), which
  resolves the registered namespace and threads it here. Because the
  reference points at the live bridge, reads inside a handler
  (`ctx.sandbox.get("primary")`) hit current harness state — no stale
  render capture.
- **Universal fields always win.** The record is spread FIRST, so a
  colliding key can never shadow `toolCallId`, `transport`, etc.

This is what lets an optional harness be dispatch-resolved on `ctx`
**without this package depending on it** —
`@agentick/tool-executor-next` imports no sandbox (or any other optional
harness); the layering stays clean.

### `ctx.log` / `ctx.progress` — the runtime signal family (ADR 64)

`log` and `progress` are **universal, always-present** slots (like `emit`
/ `setState`) — not optional. Each call emits exactly ONE discrete bus
event (`tool:signal:log` / `tool:signal:progress`, phase `terminal`,
scoped to the dispatch's `{ sessionId, executionId, tickId }`) via
`BaseHarness.emitLog` / `emitProgress`. The emit is **fire-and-forget**
(launched with `Effect.runFork`) — never awaited, never throws into the
handler, never a control path.

Signals are **not sent to any wire directly**. Projections subscribe to
the bus and forward: the MCP-server projection → `notifications/message`

- `notifications/progress`; the agentick client → `subscribe` / `onLog`
  (see `@agentick/client-next`). Emit once (framework), receive everywhere.
  Signals are structurally **bus-only** — never journaled — so diagnostic
  spam can't bloat the recovery spine.

## Task modes — `TaskHandle`-returning handlers

When a handler returns a `TaskHandle` (from `ctx.tasks!.submit(...)`),
the executor branches on the tool's `annotations.taskSupport` combined
with the caller's `DispatchInput.task` option (default `"auto"`):

- **Pattern A (await transparently)** — the executor awaits
  `handle.result` and returns its content blocks. The model never sees a
  task id. This is the default for host dispatch and for any
  `taskSupport !== "required"` tool.
- **Pattern B (return a task-ref)** — the executor returns immediately
  with a first-class `{ type: "task_ref", taskId, status, … }` content
  block. Reached when `task === "ref"`, or when `task === "auto"` on the
  model door for a `taskSupport: "required"` tool. The model then manages
  the task via the `session_tasks_*` tools (see `@agentick/tasks-next`).

Contradictory overrides are rejected **before the handler runs** with
`ToolTaskModeConflictError`: `"ref"` against `taskSupport: "unsupported"`,
and `"inline"` against `taskSupport: "required"`. On Pattern A, a
dispatch abort cancels the in-flight task rather than orphaning it.

## Confirmation flow

Tools whose `annotations.requiresConfirmation` is truthy route through the
`ElicitationHarness` before the handler runs. The annotation is a **seam, not a
flag**:

```ts
requiresConfirmation?: boolean | ((input, ctx) => boolean | Promise<boolean>);
```

`true` always confirms; a **predicate** confirms conditionally on the validated
input + tool ctx (e.g. confirm only when `input.amount > 100`, or when the path
is outside a scratch dir). The predicate is evaluated at the gate and may be
async. (Over-the-wire tool declarations use the `boolean` form — a function can't
serialize; the predicate is a server-declared-tool affordance.)

The wire envelope is the standard elicitation shape
(`session:channel:elicitation`, `hints.kind === "tool_confirmation"`); the reply
is validated against the internal `TOOL_CONFIRMATION_REPLY_SCHEMA`. Approval
requires `accepted` + `reply.approved === true` — every other outcome (declined,
cancelled, aborted, schema-violation, accepted-with-`approved:false`) becomes a
denial-shaped `DispatchResult` (`succeeded: false`). A `reply.always === true`
marks the tool session-allowed so subsequent calls skip the gate; a
`reply.modifiedArguments` payload is re-validated before the handler runs.
Timeout surfaces as `ToolConfirmationTimeoutError`.

## Client-handled tools

A tool whose declaration has **no `handlerRef`** is *client-handled*: there is no
server-side handler, and the executor either relays the call to the client for
execution or resolves it with a canned result — driven entirely by annotations.
(A `handlerRef` that is *present but unresolvable* is still a hard
`ToolHandlerMissing` — a real missing-handler bug, not a client tool.) A
client-handled call still validates its input against the declaration's
`inputSchema` and still runs the confirmation gate.

Two modes, chosen by `annotations.requiresResponse`:

- **`requiresResponse: true` — client-in-the-loop.** The dispatch **suspends**
  and relays the call to the client via the executor's own request/response seam
  (`this.request(TOOL_CALL_CHANNEL, { toolCallId, name, input })`, the same
  Deferred-keyed-by-`correlationId` machinery the confirmation gate uses). The
  client executes the tool (renders UI, runs browser code, …) and relays a
  `ContentBlock[]` result back; the dispatch resumes with it (`executedBy:
  "client"`). Timeout is bounded by `annotations.responseTimeoutMs` (or
  per-dispatch `responseTimeoutMs`); on timeout the executor falls back to
  `defaultResult` if one is set, else fails with `ToolCallTimeoutError`.
- **`requiresResponse` falsy (default) — fire-and-forget.** The dispatch resolves
  *immediately* with `annotations.defaultResult` (or a default
  `[{ type: "text", text: "executed successfully" }]`) and emits a one-way
  notification (`this.notify(TOOL_CALL_CHANNEL, …)` — a `requestType: "notify"`
  envelope with no `correlationId`, the fire-and-forget twin of `request`) so the
  client's tool router still runs/renders the tool. Suits render-only tools that
  the model doesn't need a real result from.

Either way the result re-enters the loop through the unchanged
`DispatchResult → LoopToolResult → tool_result` timeline path. `createTool`'s
`handler` is optional — a handler-less `createTool` is the server-side way to
declare a client tool; the wire path (registering a raw declaration) converges on
the same handler-less shape. `TOOL_CALL_CHANNEL`, `ToolCallRequestPayload`, and
`TOOL_CALL_REQUEST_SCHEMA` are exported as the wire contract the client router
(and the `session/respond_to_tool_call` wire method) build on.

> Not yet wired: the `session/register_tool` + `session/respond_to_tool_call`
> wire methods (stage 2) and the client-side tool router (stage 3). This section
> documents the executor's native handling only.

## Abort

`abort({ toolCallId, reason? })` cancels an in-flight dispatch — the
matching `AbortController` fires and the dispatch rejects with
`ToolAbortedError`. It is a **declared command** (`tool:abort`, ADR 51),
not a plain method, on BOTH the reference `ToolExecutorHarness` AND the
`defineToolExecutor` `CallbackToolExecutor`. Three consequences:

- **In-process** — `await tools.abort({ toolCallId })` works as before.
- **Inbox-abortable** — an external actor (the session on user-escape, or
  another cluster node) cancels a dispatch by `send`-ing the generic
  command-invocation shape (`type: "tool:abort"`, `payload: AbortInput`)
  to the harness's `tool:{scopeId}` address; `BaseHarness.dispatchMessage`
  auto-routes it through the command registry — no hand-rolled inbox
  switch. This closes the gap where a `defineToolExecutor` executor could
  not be inbox-aborted (its `handleMessage` used to reject every message).
- **Immediate** — the command handler fires `controller.abort`
  synchronously; the command wrapper adds journaling AROUND that, never
  latency, so cancellation is not deferred by the phase contract.

Aborting an unknown `toolCallId` is a safe no-op.

## API

Exhaustive detail is in the generated typedoc. Key exports from the
package root:

| Export                                       | What                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ToolExecutorHarness`                        | `BaseHarness<"tool">` reference impl of `ToolExecutorProtocol`                       |
| `defineToolExecutor`                         | Callback-style `ToolExecutorFactory` factory (bring a `dispatch` callback)           |
| `InMemoryToolRegistry`                       | Multi-binding registry with per-tick precedence resolution                           |
| `InMemoryHandlerResolver`                    | `handlerRef → { handler, validator }` lookup table                                   |
| `withScope`                                  | Bind declarations to a scope for the duration of an async body; cleanup in `finally` |
| `permissiveValidator` / `fromStandardSchema` | Validators — accept-anything, and a Standard Schema v1 adapter (Zod/Valibot/…)       |

Types: `ToolExecutorHarnessOptions`, `HandlerResolver`, `HandlerEntry`,
`HandlerChannelSeed`, `ToolHandler`, `ToolHandlerCtx`, `Validator`,
`ValidatorResult` (the handler + validator types are re-exported from
`@agentick/spec-next`, where they live so the authoring layer can consume
them without depending on this runtime package).

The registry also exports the precedence ladder as data —
`PRECEDENCE_RANK`, `precedenceOf`, `bindingKey`, `sameBindingKey` — from
`./registry.js`. Precedence (low → high): `runtime < gateway < app <
session < execution < reconciler`; an `extension` binding takes the rank
of the level at which it was installed.

### Command lifecycle hooks (ADR 80)

`dispatch` is a `command("tool:dispatch", …)`, so it participates in the
framework-wide command-lifecycle hook surface. This package contributes the one
`CommandRegistry` augmentation for the verb (`harness.ts`), which mints two
typed hooks on `CommandHooks`:

| Hook                   | Fires        | Receives / returns                                              |
| ---------------------- | ------------ | -------------------------------------------------------------- |
| `onBeforeToolDispatch` | pre-dispatch | `DispatchInput` — transform the call, or `throw` to veto it    |
| `onAfterToolDispatch`  | post-dispatch | `DispatchResult` — transform the **full** result (not bare `content`), so an after-hook can't strip `isError` / `structuredContent` / metadata |

Register them at any scope that folds down to the dispatch (`createApp({ hooks })`
or `createSession({ hooks })`; composed app-outer). **Distinct from
`guardDispatch`** — the dispatch **guard** (ADR 83; renamed from the old
`onBeforeDispatch` verdict handler), which decides whether a dispatch proceeds
(`proceed` / `veto` / `replace` / `defer`) at the validate → authorize → confirm
gate; the lifecycle hooks transform its input/output. `guardDispatch(handler)` is
the tool-typed name for the universal `BaseHarness.guardEffect(...)` seam — an
op-admission guard, NOT the `gate` package (loop continuation): _guard :
operation :: gate : loop_. Mechanism, naming, and the construction-fold cascade:
[runtime README — Command lifecycle hooks](../runtime/README.md#command-lifecycle-hooks-adr-80--82--83).

## Testing

`/testing` subpath (`@agentick/tool-executor-next/testing`):

- `createTestHarness({ tools?, handlers?, elicitation?, tasks?,
  ctxExtensions?, … })` — wires an in-memory substrate (journal / bus /
  inbox), a real `ElicitationHarness` and `TasksHarness` on the **same**
  substrate (so bus subscriptions see envelopes from all three), and a
  `ToolExecutorHarness`. Pass `ctxExtensions` to exercise the ADR-66
  extension seam (e.g. a stub `ctx.sandbox`). Returns the bundle
  (`harness`, `journal`, `bus`, `inbox`, `resolver`, `elicitation`,
  `tasks`), all `ready`.
- `fakeRegistration({ declaration, handlerRef?, useDeps?, binding? })` —
  build a `ToolRegistration` with sensible defaults (`binding` defaults
  to `{ scope: "runtime" }`).

```ts
import { createTestHarness } from "@agentick/tool-executor-next/testing";

const { harness } = await createTestHarness({
  tools: [{ declaration, handlerRef: "h.echo", binding: { scope: "runtime" } }],
  handlers: [
    { handlerRef: "h.echo", handler: async (i) => [{ type: "text", text: JSON.stringify(i) }] },
  ],
});

const res = await harness.dispatch({
  toolCallId: "c_1",
  name: "echo",
  input: { hi: true },
  context: { via: "dispatch" },
});
```

## Conformance

The reference implementation is driven through
`runToolExecutorConformance` from `@agentick/spec-conformance-next`
(package root — there is no `/tool-executor` subpath export). See
`src/__tests__/conformance.spec.ts` for the factory that translates
fixture behaviors into concrete handlers.

## Verified by

- `src/__tests__/conformance.spec.ts` — drives the shared
  `runToolExecutorConformance` suite against `ToolExecutorHarness`.
- `src/__tests__/harness.spec.ts` — registry + dispatch happy path,
  abort (direct `abort()`, caller-signal, timeout, unknown-id no-op, AND
  inbox `tool:abort` command routing), handler errors, exposure
  enforcement, AND — for `dispatch` as a declared command — provenance
  (`via: "model"` stamps `origin: "model"`, `via: "dispatch"` stamps
  `origin: "host"`, asserted on the journaled `requested` envelope) plus
  inbox dispatch-by-name (a `tool:dispatch` message invokes the tool and
  returns its `DispatchResult`).
- `src/__tests__/confirmation.spec.ts` — the confirmation gate
  (approve / deny / always / modifiedArguments / timeout).
- `src/__tests__/dispatch-task-mode-matrix.spec.ts` — Pattern A vs B and
  the `ToolTaskModeConflictError` pre-flight matrix.
- `src/__tests__/task-handle.spec.ts` — `ctx.tasks` wiring, await-vs-ref,
  abort propagation into the in-flight task.
- `src/__tests__/ctx-extensions.spec.ts` — the ADR-66 `ctxExtensions`
  seam: opaque values spread onto `ctx`, freshness (live-object reads,
  not render capture), absence, and universal-field collision safety.
- `src/__tests__/signals.spec.ts` + `signal-fire-and-forget.spec.ts` —
  `ctx.log` / `ctx.progress` emit shape + scope, and that a dying bus
  never blocks or fails the dispatch.
- `src/__tests__/registry.spec.ts` + `layered-tools.spec.ts` —
  multi-binding storage, precedence resolution, idempotency.
- `src/__tests__/middleware-and-hooks.spec.ts` — `use(middleware)` +
  `guardDispatch(handler)` verdicts (guard admission, ADR 83).
- `src/__tests__/command-hooks-augmentation.spec.ts` — the `tool:dispatch`
  `CommandRegistry` augmentation mints `onBeforeToolDispatch` (← `DispatchInput`)
  / `onAfterToolDispatch` (← `DispatchResult`), and the type-level names agree
  with runtime `deriveHookNames` (lockstep).
- `src/__tests__/define-tool-executor.spec.ts` — the callback factory,
  including inbox `tool:abort` command routing cancelling an in-flight
  dispatch with `ToolAbortedError` (the #31 gap: `CallbackToolExecutor` is
  now inbox-abortable), plus `dispatch`-as-command parity on the callback
  executor (model/host provenance stamping + inbox dispatch-by-name). Plus
  `with-scope.spec.ts`, `validator.spec.ts`, `handler-resolver.spec.ts` —
  scope helper, validators, resolver.

## Status & roadmap

🚧 In active development as part of v2 (`feat/v2`). The core surface —
registry, dispatch (both doors), validation, confirmation gate, abort +
timeout, task-mode branching, lifecycle handlers, runtime signals — has
landed and passes conformance.

Known gaps / deferred:

- **`defineToolExecutor` custom inbox message types** — `abort`
  (`tool:abort`) auto-routes on both executors via the command registry
  (see [Abort](#abort)), so a callback executor IS inbox-abortable. Any
  OTHER inbox message type still routes to `HandlerError` on the callback
  executor — declare it as a command (or add an `onMessage` handler) to
  wire it.
- **`taskSupport: "supported"` capability negotiation** — the "supported"
  branch of the task-mode matrix is resolved conservatively (Pattern A
  outside the model-required path). Phase C (#174) refines it.
- **Custom-registry factory parity** — `defineToolExecutor` replicates
  storage callbacks but not the validation / confirmation pipeline;
  those require subclassing `ToolExecutorHarness`.

## See also

- `@agentick/spec-next` — the protocol definition
  (`protocol/tool-executor.ts`, `data/tool-handler.ts`,
  `data/declarations.ts`).
- `@agentick/reconciler-react-next` — produces `ToolDeclaration[]` and
  captures `use:` deps at render time; the tool executor consumes them.
- `@agentick/tasks-next` — the `TaskHandle` primitive and the
  `session_tasks_*` model tools that manage Pattern B refs.
- `docs/proposals/v2/blueprint/07-tool-executor.md` — full design.
