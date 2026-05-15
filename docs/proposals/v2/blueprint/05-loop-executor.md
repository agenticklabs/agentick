# 05 — Loop Executor

**Status:** Synthesized
`[SOURCE: loop-executor.md, runtime.md, harness-principle.md]`

The loop executor is the orchestration harness that runs **one agent
execution**. It sits between the session harness and the lower-level
React, executor, and tool executor harnesses. It is what gets extracted
from v1's `Session.executeTick` (`packages/core/src/app/session.ts:2431`,
~600 lines fused into the Session class).

```
                  ┌───────────────────────────────────┐
                  │          Loop executor            │
                  │                                   │
   commands  ──►  │   runExecution · abort            │  ──► events
                  │                                   │
   interceptors ◄►│   (tick loop, continuation,       │  ──► outcomes
                  │    abort/max-tick policy)         │
                  └─────────────┬─────────────────────┘
                                │
                  ┌─────────────┴─────────────┬─────────────────────┐
                  ▼                           ▼                     ▼
          reconciler harness              Executor harness      Tool executor
          (renderTree)           (run)                  (dispatch)
```

## Why this is its own harness

In v1, the tick loop is fused into `SessionImpl.executeTick`. That
method:

- compiles the JSX tree
- resolves the model
- transforms compiled state via the `ExecutionRunner`
- streams model output and accumulates events
- ingests model output into timeline state
- dispatches tools
- decides whether to continue
- accumulates usage and result

…all in one ~600-line method. Extracting this into a harness:

| Property | v1 | v2 |
| --- | --- | --- |
| Reusable in tests | hard (mock 5 things via Session) | trivial (provide 5 mocks) |
| Reusable from non-Session contexts | impossible | yes (any caller can run a loop) |
| Observable per-phase | partially (DevTools events) | fully (per-phase events + interceptors) |
| Replaceable continuation policy | bake in or override Runner | interceptor on `continuation` |
| Replaceable tool dispatch | `Runner.executeToolCall` | tool executor harness boundary |
| State application | inside Session | injected `StateApplicator` |

`[V1-REPLACED]` of `Session.executeTick` plus `ExecutionRunner` (its
`transformCompiled` and `executeToolCall` hooks become interceptors at
`compile` and `tool-dispatch` boundaries respectively).

## What this harness manages

- One execution run.
- The tick loop.
- Abort and max-tick policy.
- Compilation timing (when to call React's `renderTree`).
- Executor invocation.
- Tool dispatch handoff.
- Executor terminal outcome ingestion.
- Continuation policy.
- Usage/result assembly across ticks.
- Event sequencing for the execution.

It does NOT manage:

- Identity, timeline, or persistence (session harness).
- React tree internals (reconciler harness).
- Provider mechanics (executor harness).
- Tool handler bodies (tool executor harness).

## Commands in

```ts
interface LoopExecutorProtocol {
  runExecution(input: RunExecutionInput):
    Effect<ExecutionTerminal, LoopExecutorError, LoopEnv>;

  abort(executionId: string):
    Effect<void, LoopExecutorError, LoopEnv>;
}
```

```ts
interface RunExecutionInput {
  executionId: string;                  // assigned by session
  sessionId: string;
  parentExecutionId?: string;

  // Where compile commands are sent (direct method calls)
  reactHarness: ReactHarnessProtocol;
  mountId: string;                      // already mounted by session

  // Provider runs (direct method calls)
  executor: ExecutorProtocol;
  target: ExecutionTarget;

  // Tool dispatch (direct method calls)
  toolExecutor: ToolExecutorProtocol;

  // Apply normalized results back to session state
  stateApplicator: StateApplicator;

  // Initial messages / props for the run
  send: SendInput;

  // Policies
  maxTicks: number;
  // NOTE: continuation is NOT a separate policy object.
  // It comes from reconciler harness's notifyLifecycle via the session's
  // .onTickEnd lifecycle handler wiring. See "Continuation" section below.

  // Cancellation
  signal?: AbortSignal;

  // Defaults for compile time
  defaultRenderer?: FormatterRef;
}

interface ExecutionTerminal {
  outcome: CommandOutcome;
  result?: ExecutionRunResult;
  reason?: string;
  error?: LoopExecutorError;
}

interface ExecutionRunResult {
  executionId: string;
  ticks: number;
  usage: UsageStats;
  stopReason: LanguageModelStopReason | "max_ticks" | "aborted" | "vetoed";
  output: ContentBlock[];               // canonical content stream
  outputs: Record<string, unknown>;     // OutputDeclaration extractions
}
```

### StateApplicator

`StateApplicator` is the contract between loop and session for timeline
writes. **Not** a separate object — a structural Pick of the session
harness's apply commands. See `08-session-harness.md` for the methods;
loop calls them directly. Locked in `17-open-questions.md` (A11).

```ts
type StateApplicator = Pick<SessionHarnessProtocol,
  "applyExecutorResult" | "applyToolResults" | "appendEntry">;
```

### Continuation

The loop does NOT have a `ContinuationPolicy` object. Continuation is
decided by **the React tree's `useOnTickEnd` / `useLoopControl` hooks**,
delivered via the reconciler harness's `notifyLifecycle` command.

The loop's job:

1. Emit `loop:tick:terminal` with `phase: "before"` and the tick result.
2. Lifecycle handlers registered via `loop.onTickEnd(fn)` fire here.
3. The session-installed handler calls `react.notifyLifecycle(...)` and
   returns the tree's verdict.
4. The loop reads the (possibly replaced) decision from its terminal
   payload and proceeds.

Default decision when no handlers are installed: derived from
`stopReason`:

```
stopReason === "tool_use" AND pending tool calls → continue
stopReason === "end"                              → stop
ticks + 1 >= maxTicks                             → stop (max_ticks)
otherwise                                         → stop (with reason)
```

See `08-session-harness.md` for the wiring code; see
`03-reconciler-harness.md` for the `notifyLifecycle` command + `useOnTickEnd`
hook.

### Inbox messages

The loop executor accepts inbound messages at address
`loop:{executionId}`:

| Message type | Payload | Effect |
| --- | --- | --- |
| `halt` | `{ reason: string }` | Aborts the execution; emits `loop:execution:halted`. |
| `pause` | `{}` | Pauses at next tick boundary. |

Inbox messages let external callers (gateway, supervisor, scheduled
jobs) influence execution without holding a typed reference to the
loop. In Tier 0/1, messages dispatch via the local inbox; in Tier 2,
across the cluster. Same handler signature.

### Lifecycle handlers exposed

The loop executor exposes typed `.onX(fn)` registrations:

```ts
loop.onExecutionStart(handler: (input: RunExecutionInput) => void | Promise<void>)
loop.onTickStart(handler: (info: TickInfo) => void | Promise<void>)
loop.onTickEnd(handler: (result: TickResult) => Promise<TickEndDecision | void>)
loop.onExecutionEnd(handler: (result: ExecutionRunResult) => void | Promise<void>)
```

`onTickEnd` is the load-bearing one. The session installs a handler at
construction that forwards to `react.notifyLifecycle(...)` and returns
the decision. Multiple handlers register in order; verdicts merge per
the rules in `19-foundation.md`.

### Middleware exposure

```ts
loop.use({
  aroundExecution: (input, next) => { ... },
  aroundTick: (tickInput, next) => { ... },
});
```

Around-style for cross-cutting concerns (rate limit, transformation,
test fixtures).

## Events out

All on `surface: "loop"`.

```
loop:execution:requested        loop:execution:before
loop:execution:terminal         (outcome, with ExecutionRunResult on succeeded)

loop:tick:requested             loop:tick:before
loop:tick:terminal              (per tick, with shouldContinue)

loop:compile:requested          loop:compile:terminal      (delegated to reconciler harness)
loop:executor:requested         loop:executor:delta        loop:executor:terminal
loop:tool-dispatch:requested    loop:tool-dispatch:terminal (per tool call)
loop:ingest:requested           loop:ingest:terminal       (after state apply)
loop:continuation:requested     loop:continuation:terminal (decision)
```

The loop emits per-phase events even though it delegates work to other
harnesses. This makes the execution flow auditable from a single
subscriber (without having to subscribe to four harnesses to reconstruct
what happened).

`[V1-REPLACED]` of v1's tick events (`tick_start`, `tick_end`, `tick`)
which are emitted directly from `Session.executeTick`. v2 consolidates
these as `loop:tick:*` envelope events with phase semantics.

## Interceptors

```
execution    — wraps the whole run
tick         — wraps each tick
compile      — interceptors on the compile step (replace = transform)
executor     — interceptors on the provider run
tool-dispatch — interceptors on tool dispatch
ingest       — wraps state application
continuation — wraps the continue/stop decision
```

Use cases:

| Interceptor | Use case |
| --- | --- |
| `execution` veto | Refuse to start (rate limit hit) |
| `compile` replace | REPL runner replaces tools with command descriptions |
| `executor` replace | Test fixture, golden response |
| `tool-dispatch` veto | Permission check |
| `ingest` defer | Batch persist before applying |
| `continuation` replace | Force stop after N ticks regardless of model |

Replace at `compile` is the v2 equivalent of v1's
`ExecutionRunner.transformCompiled`. Replace at `tool-dispatch` is the
equivalent of `ExecutionRunner.executeToolCall` (and lives more naturally
in the tool executor harness — see `07-tool-executor.md`).

## Outcomes and failures

```ts
type LoopExecutorError =
  | ExecutionError
  | TickError
  | LoopCanceledError
  | MaxTicksExceeded;

interface ExecutionError {
  _tag: "ExecutionError";
  cause: unknown;
}

interface TickError {
  _tag: "TickError";
  tick: number;
  phase: "compile" | "execute" | "tool-dispatch" | "ingest" | "continuation";
  cause: unknown;
}

interface LoopCanceledError {
  _tag: "LoopCanceledError";
  reason?: string;
}

interface MaxTicksExceeded {
  _tag: "MaxTicksExceeded";
  ticks: number;
  maxTicks: number;
}
```

## Execution algorithm

Normative skeleton (from `[SOURCE: loop-executor.md §Execution Algorithm]`):

```
1) Emit loop:execution:requested + loop:execution:before
   Run execution-scope interceptors
   If vetoed → return ExecutionTerminal { vetoed }
   If replaced → return ExecutionTerminal { replaced, result }

2) tick = 0
   while continuation policy allows AND tick < maxTicks:
     2a) Check cancellation; if aborted → MaxTicksExceeded? no, LoopCanceledError
     2b) Emit loop:tick:requested + loop:tick:before
         Run tick-scope interceptors
         If vetoed → break loop with reason "vetoed"

     2c) react.renderTree(mountId)  → RenderedTree (or replaced)
         Emit loop:compile:terminal

     2d) If compiled requests stop (e.g. via diagnostics), break loop

     2e) executor.run(compiled, target)
         Stream loop:executor:delta events
         await ExecutorTerminal
         Emit loop:executor:terminal

     2f) On ExecutorTerminal { outcome: "succeeded" | "replaced" }:
           result = terminal.result   // ExecutionResult / LanguageModelExecutionResult
         Else (failed/canceled/vetoed):
           handle accordingly (break, abort, etc.)

     2g) For each toolCall in result.toolCalls:
           toolExecutor.dispatch(name, input, ctx)  → ToolResult
           (provider-side executed tools are NOT in toolCalls;
            they're already in result.output as tool_result blocks)
         Emit loop:tool-dispatch:* per call

     2h) stateApplicator.applyExecutorResult(sessionId, result)
         stateApplicator.applyToolResults(sessionId, toolResults)
         Emit loop:ingest:terminal

     2i) continuationPolicy.shouldContinue(ctx) → continue | stop
         (interceptors may replace decision)
         Emit loop:continuation:terminal

     2j) Emit loop:tick:terminal
     2k) tick += 1

3) Assemble ExecutionRunResult
4) Emit loop:execution:terminal { outcome: "succeeded", result }
   Return ExecutionTerminal
```

### Key invariants

- The loop reads `ExecutorTerminal` and the `result` field; it does NOT
  inspect provider-native shapes.
- For language-model targets, success carries
  `LanguageModelExecutionResult` (extends `ExecutionResult`).
- Anything in `result.toolCalls` is a request for Agentick to dispatch.
  Provider-side tools come back inside `result.output` as `tool_result`
  blocks (and are NOT in `result.toolCalls`).
- Tool dispatch outcomes feed back into continuation, but **state is
  applied before continuation runs**, so the policy sees the post-ingest
  view.
- The loop does not call `renderTree` between tool dispatch and
  continuation — recompilation happens at the **start** of the next tick.

## Continuation policy

Default policy `[PROPOSAL]`:

```ts
const defaultContinuationPolicy: ContinuationPolicy = {
  shouldContinue: (ctx) => {
    if (ctx.lastStopReason === "tool_use" && ctx.pendingToolCalls.length > 0) {
      return Effect.succeed({ kind: "continue" });
    }
    if (ctx.lastStopReason === "end") {
      return Effect.succeed({ kind: "stop", reason: "natural_completion" });
    }
    if (ctx.ticks + 1 >= ctx.maxTicks) {
      return Effect.succeed({ kind: "stop", reason: "max_ticks" });
    }
    return Effect.succeed({ kind: "stop", reason: ctx.lastStopReason });
  },
};
```

`[V1-INHERITED]` from session's continuation logic in
`packages/core/src/app/session.ts` (around the tick loop's `shouldContinue`
flag).

## Tool execution ownership

`[SOURCE: loop-executor.md §Relationship to Tool Executor]` and
`[SOURCE: executor.md §Tool Call Boundary]`.

```
Tool exposed to model AND tool resides in Agentick:
  → ToolDeclaration with exposure includes "model"
  → executor returns toolCalls[] in result
  → loop dispatches via toolExecutor.dispatch
  → results applied to session state

Tool exposed to model AND provider-side execution:
  → ToolDeclaration with exposure includes "model"
  → executor returns tool_result blocks in result.output
  → executor OMITS the corresponding entries from result.toolCalls
  → loop does NOT dispatch (no double-execution)
  → results are already in result.output, applied to state directly

Tool exposed for dispatch only (audience: "user" in v1):
  → ToolDeclaration with exposure: ["dispatch"]
  → never appears in tool calls from the model
  → invokable only via session.dispatch (a host door, not a model door)
```

The loop executor depends on the executor honoring this contract. If an
executor returns both a `toolCalls[]` entry AND a corresponding
`tool_result` in `output`, the loop will double-dispatch. This is an
executor implementation requirement (`[SOURCE: executor.md §Open Question 7]`
asks for the explicit shape of the opt-out marker; pending).

## Parallel tool dispatch

`[GAP]` `[SOURCE: executor.md §Open Question 3]` — runtime policy only or
executor option.

Blueprint position `[PROPOSAL]`:

- Loop executor exposes `parallelToolCalls?: boolean | "unbounded" | number`
  on `RunExecutionInput`.
- Default: parallel for read-only tools (per `ToolAnnotations.intent`
  hints), serial otherwise.
- Per-tool override via interceptor on `tool-dispatch`.

Sign-off needed.

## Streaming and terminal consistency

The executor harness emits `executor:delta` events as model chunks
arrive. The loop **forwards** these as `loop:executor:delta` (with
loop-scoped envelope metadata) so subscribers see one stream.

On terminal:

> A consumer that ignores all deltas and only reads `loop:execution:terminal`
> SHOULD obtain a complete, correct `ExecutionRunResult`.
> `[SOURCE: executor.md §Streaming Model]`

This is a hard rule: streaming is an optional UX optimization, never a
correctness requirement.

## Composition with reconciler harness

The loop executor uses `mountId` from the session — it does NOT mount the
React tree itself. The session harness is responsible for keeping the
React tree mounted across executions.

```
Session harness                    reconciler harness                Loop executor
───────────────                    ─────────────                ─────────────
mount on activation
  ── react.mount() ──► returns mountId
                                                    ◄── runExecution(mountId, ...)
                                  ◄── renderTree(mountId)
                                  ── RenderedTree ─►
                                                    ── executor.run ─►
                                                                       ...
                                                    ◄── result ──
                                                    ── stateApplicator.apply ─►
                                  ── (optional) rerender(mountId, ...) ─►
                                                    ── (next tick) ──
unmount on close
  ── react.unmount(mountId) ──►
```

## Composition with executor harness

```
LoopExecutor                                Executor (LanguageModelExecutor)
────────────                                ────────────────────────────────
.runExecution
  per tick:
    ── executor.run(compiled, target) ──►
                                            project(compiled, target)
                                            execute(input, target)
                                            normalize(output, target)
                                            ◄── ExecutorTerminal
    consume terminal → state apply
    decide continuation
```

## Composition with tool executor harness

```
LoopExecutor                                ToolExecutor
────────────                                ────────────
per ToolCall in result.toolCalls:
  ── toolExecutor.dispatch(call) ──►
                                            validate input (Standard Schema)
                                            run handler (with use: deps)
                                            ◄── ToolResult
  collect outcome
collect all → stateApplicator.applyToolResults
```

## Public vs internal

`[SOURCE: loop-executor.md §Decision Log]` — the loop executor is an
**internal harness contract, not a public package surface in v2**. The
harness shape gives testability and observability without locking a
public API; promote later if external use cases emerge.

This means:

- The `LoopExecutorProtocol` lives in `@agentick/spec`.
- The default implementation lives inside `@agentick/runtime`.
- It is reachable via `@agentick/runtime`'s test harness exports for
  integration tests.
- It is NOT exported from the runtime's public API.

## Relationship to v1 ExecutionRunner

```
v1 concept                              v2 placement
──────────────────────────────────────────────────────────────────
ExecutionRunner.transformCompiled       loop interceptor on `compile` (replace)
ExecutionRunner.executeToolCall         tool executor interceptor on `dispatch`
ExecutionRunner.onSessionInit           session interceptor on `mount`
ExecutionRunner.onPersist               session interceptor on `hibernate`
ExecutionRunner.onRestore               session interceptor on `restore`
ExecutionRunner.onDestroy               session interceptor on `close`
ExecutionRunner.name                    interceptor registration metadata
```

The "Runner" object disappears as a distinct primitive. Its hooks become
interceptors registered against the appropriate harness boundary. A REPL
runner becomes a small bundle of interceptors registered with `app.use(...)`.

## Decisions captured

- Loop executor is its own harness, distinct from session.
- Session owns identity/timeline/persistence; loop owns tick mechanics.
- Loop consumes `ExecutorTerminal` (no provider-native inspection).
- Continuation is a policy + interceptors, not bake-in logic.
- Default tick max is per-app config (no architectural max).
- Internal harness contract; not a public package surface in v2.
- Tool dispatch is delegated to tool executor; provider-side tools come
  back inside `result.output` and bypass loop dispatch.

## Open questions

- `StateApplicator` shape (placeholder synthesized; sign-off needed).
- `ContinuationPolicy` named-policy type vs interceptor-only (lean: both).
- Parallel tool dispatch policy (lean: per-call hint via interceptor).
- Loop executor package home (lean: `@agentick/runtime` internal).
- Provider-side tool execution opt-out marker shape (open in `executor.md`).
