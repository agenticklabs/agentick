# @agentick/loop-executor-next

**LoopExecutorHarness — one agent execution, run tick by tick.**

The orchestration harness that runs a single execution to terminal. It
composes the four downstream harnesses — compiler, model-executor,
tool-executor, and the session's state applicator — through the
canonical tick loop, emitting a per-phase event stream so the whole
execution is auditable from one subscriber on `surface: "loop"`.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## Purpose

A `LoopExecutorProtocol` implementation owns the answer to "what
happens between `session.send()` and the terminal result?" That is:

1. **render** the JSX tree to a `RenderedTree` (compiler),
2. **execute** it against the model (executor),
3. **dispatch** every `toolCall` the model requested (tool-executor),
4. **apply** the executor result + tool results back into session state
   (the session's `StateApplicator`),
5. **decide** whether to continue (default: `stopReason === "tool_use"`
   with pending tool calls → continue; extended by the session's
   tick-end forward decision), bounded by `maxTicks`,
6. **repeat**.

The loop is a _conduit_: it threads a `RenderContext` envelope into each
render, resolves a per-tick model against the mount's `ModelBridge`, and
bridges lifecycle moments to both the public event stream and the
compiler's hook store — all without knowing what any individual fact
or model _means_.

## Quick Start

Most adopters never touch the loop directly — `createApp(MyAgent, opts)`
wires a `LoopExecutorHarness` in for you and the session drives it.
Reach for this package when you need a _custom_ orchestration topology.

### Use the reference harness

```ts
import { LoopExecutorHarness } from "@agentick/loop-executor-next";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

const loop = new LoopExecutorHarness(
  "loop:my-scope",
  new MemoryJournal(),
  new LocalEventBus(),
  new LocalInbox(),
);

const terminal = await loop.runExecution({
  executionId: "exec:1",
  sessionId: "s:1",
  compiler, // CompilerProtocol
  mountId, // string
  modelExecutor, // ExecutorProtocol
  target, // ExecutionTarget
  toolExecutor, // ToolExecutorProtocol
  stateApplicator, // StateApplicator (see NoopStateApplicator)
  maxTicks: 8,
});
// terminal.outcome: "succeeded" | "canceled" | ...
// terminal.result: ExecutionRunResult (ticks, usage, stopReason, output, toolResults)
```

`loop:run-execution` is a **streaming command** (`commandStream`): its
chunks ARE the `LoopExecutionEvent`s the run produces. The `loop.runExecution(input)`
Promise facade above is its drain-only `run` face — it returns the settled
terminal and drops the events. To consume the events, take the `.fx`
sink-fold face, `loop.fx.runExecution(input, sink)` (what the session does —
see [Event stream](#the-event-stream) below). Either way the run flows
through `runOperation`, so the loop's typed lifecycle
(`loop:command:run-execution`) — and its `onBefore/AfterLoopRunExecution`
boundary hooks + the `onLoopRunExecutionChunk` per-chunk interceptor — flow
onto the shared bus and journal. `abort({ executionId })` terminates an
in-flight run with `outcome: "canceled"`.

### `NoopStateApplicator` — no session present

The loop's contract requires a `StateApplicator` to write results back.
When there is no session (tests, single-shot renders), plug in the noop:

```ts
import { NoopStateApplicator } from "@agentick/loop-executor-next";

await loop.runExecution({ /* ... */, stateApplicator: new NoopStateApplicator() });
```

With the noop, multi-tick runs do **not** reflect prior ticks' tool
results in the next render (nothing writes to the timeline the tree
reads). It is for single-tick and `maxTicks`-bounded scenarios; real
multi-tick feedback needs the session harness's applicator.

### `defineLoop` — a callback loop without subclassing

For a fundamentally different orchestration (single-call no-tool loop,
parallel multi-model, replay-based test harness), satisfy
`LoopExecutorProtocol` with a callback instead of subclassing:

```ts
import { defineLoop } from "@agentick/loop-executor-next";

const myLoop = defineLoop({
  async runExecution(input) {
    const { tree } = await input.compiler.renderTree({
      mountId: input.mountId,
      sessionId: input.sessionId,
    });
    const terminal = await input.modelExecutor.run({
      compiled: tree,
      target: input.target,
      scope: { executionId: input.executionId, sessionId: input.sessionId },
    });
    return { outcome: "succeeded", result: /* assemble ExecutionRunResult */ ... };
  },
});

const app = await createApp(<Agent />, { model: openai("gpt-4o"), loop: myLoop });
```

`defineLoop` returns a `LoopExecutorFactory` (marker
`loopExecutorFactory: true`). Passed to `createApp({ loop })`, the parent
harness invokes it with shared substrate so the callback loop's events
flow onto the same bus/journal. Called standalone (no `deps`), it spins
up its own in-memory substrate. When your `runExecution` doesn't honor
`input.signal`, supply an `abort` override; otherwise the harness layers
an `AbortController` over the input signal and routes `abort()` to it.

Adopters who want to customize a _single tick step_ should subclass
`LoopExecutorHarness` rather than rewrite the whole loop.

## API

| Export                | Kind  | Purpose                                                                            |
| --------------------- | ----- | ---------------------------------------------------------------------------------- |
| `LoopExecutorHarness` | class | Reference `LoopExecutorProtocol` — the canonical tick loop.                        |
| `NoopStateApplicator` | class | No-op `StateApplicator` for session-less runs.                                     |
| `defineLoop`          | fn    | Build a `LoopExecutorFactory` from a `runExecution` (+ optional `abort`) callback. |
| `DefineLoopInput`     | type  | The callback bundle `defineLoop` accepts.                                          |

The protocol contract (`LoopExecutorProtocol`, `RunExecutionInput`,
`ExecutionTerminal`, `ExecutionRunResult`, `LoopExecutionEvent`,
`LoopExecutionSink`, `StateApplicator`, `LoopToolResult`) lives in
`@agentick/spec-next` (`protocol/loop-executor.ts`).

## Patterns

### The render ↔ runtime feedback loop

Each tick, the loop resolves two per-render inputs from the session and
threads them into the render — this is how the tree renders _for the
model it is about to call_ and _within the window it has left_:

- **`resolveRenderContext()`** → a `RenderContext` envelope (ADR 55).
  Threaded into `renderTree({ renderContext })` so `useContextInfo` /
  `useActiveModel` read the active model's window + identity
  **synchronously** while the IR is produced. The loop has no per-slot
  knowledge — it forwards the whole envelope.
- **`resolveModel(modelRef)`** → a `RegisteredModel` (ADR 56). After
  render, if the IR carried `declarations.model`, the loop resolves its
  `modelRef` against the mount's `ModelBridge` and runs _that_
  executor + target for the tick. Precedence: **tick-IR > send >
  session**. `decl.parameters` overlay the compiled tree's `config`
  (temperature, maxOutputTokens, …) for the tick. Absent, or an
  unresolvable ref, falls back to `input.modelExecutor` / `input.target`.

### The tick round is a command (`loop:tick`, ADR 89 §3)

Each iteration of the tick loop is a **declared command on the loop
harness** — `loop:tick`, minted in the constructor via `this.command` and
reached in-fiber via `this.commandEffect` from the `run-execution` body. Its
body is the tick **through SETTLE** (render → model → tool dispatch → state
apply → compiler `tick-end`); its output is the settled `TickResult`.

- **Settle is IN, decide is OUT.** The tick command body settles the tree
  (compiler `tick-end`, running `useOnTickEnd`); the **continuation
  decision** (`notifyTickEnd` fold / `maxTicks`, ADR 67) stays in the
  `run-execution` while-loop, _after_ the command. So the session's
  predicates read settled state.
- **The command terminal IS the tick barrier.** The loop awaits
  `commandEffect("loop:tick", …)`; the next tick starts only after this one
  settles. Because the command runs in the `run-execution` fiber (ADR 77
  one-fiber — `parentOpId` auto-threads), kill/resume interruption
  propagates and tick ordering holds.
- **Hooks.** The command mints `onBeforeLoopTick` (over the `TickInput` —
  reads `tickId` / `tickIndex`) and `onAfterLoopTick` (over the settled
  `TickResult`), alongside the existing `onBefore/AfterLoopRunExecution`.
- **In-process only.** `TickInput` carries live object refs
  (compiler / executor / tool / applicator + the session resolvers), so
  the verb is `exposure: "internal"` — never inbox/wire-addressable (ADR 51
  §1.2). It lives on the LOOP harness (the loop owns tick orchestration),
  not the model executor (which owns the single model call).

### Lifecycle is the projected command-hook system (ADR 89 §4)

**The loop feeds no lifecycle store — `notifyLifecycle` is gone.** The
React `useOn*` family is a PROJECTION the **session** (the composition
root) wires: forwarders registered on this harness's command hooks
route the real command lifecycle into the compiler's per-mount
dispatch. The loop knows nothing about the compiler's observation
layer.

| Moment           | Command hook (the source)              | Lights up             | Timing                                       |
| ---------------- | -------------------------------------- | --------------------- | -------------------------------------------- |
| execution begins | `onBeforeLoopRunExecution`             | `useOnExecutionStart` | fire-and-forget                              |
| tick begins      | `onBeforeLoopTick`                     | `useOnTickStart`      | **awaited in-cascade, before render**        |
| tool dispatched  | `tool:dispatch` around (tool executor) | `useOnToolStart`      | fire-and-forget                              |
| tool finished    | `tool:dispatch` around (tool executor) | `useOnToolEnd`        | fire-and-forget                              |
| tick ends        | `onAfterLoopTick`                      | `useOnTickEnd`        | **awaited in-cascade — THE SETTLE (ADR 67)** |
| execution ends   | `onAfterLoopRunExecution`              | `useOnExecutionEnd`   | fire-and-forget                              |

The tick-end SETTLE runs as an in-cascade `onAfterLoopTick` hook —
awaited BEFORE the `loop:tick` command terminal resolves, hence before
the DECIDE (`notifyTickEnd`) in the run-execution continuation. Hook
throws in fire-and-forget forwarders never fail the run (the compiler's
dispatch isolates per-listener throws); a throw in the AWAITED
tick-start / settle forwarders fails the run, as the retired in-body
bridge did.

<a id="the-event-stream"></a>

### The event stream

The **same** moments flow independently onto the public event stream as the
**chunks of the `loop:run-execution` streaming command** (streaming-up,
ADR 51 §2). Each chunk is a `LoopExecutionEvent`; the body emits it through a
`LoopExecutionSink` (`(event) => Effect<void>`) — the run's bookends
(`execution-start` / `tick-end` / `tick` / `execution-end`) and each
`loop:tick`'s events (threaded down as `TickInput.emit`, the SAME sink), in
emission order, on the run's own fiber. This is the ONE event channel — the
former `RunExecutionInput.onEvent` push-callback is retired.

The session consumes the `.fx` sink-fold face
(`loop.fx.runExecution(input, sink)`), passing
`(ev) => Effect.sync(() => …stamp+push…)` — the events land on the
`SessionExecutionHandle` iterator, in-fiber, with no intermediate queue
(backpressure = the caller's sink). Because the sink IS the command's chunk
pipeline, a `hooks.onLoopRunExecutionChunk` observer/transform taps or
rewrites the stream for free (ADR 80 Phase 2) — even on the drain-only
facade path. Two channels, different questions: the lifecycle bridge is for
in-tree React hooks that must settle before the next operation; the event
sink is the data stream for the caller. Bus envelopes fan out to
observability (devtools, telemetry) in parallel with both.

### Streaming vs non-streaming

The loop takes the streaming path when `input.stream` is set **and** the
tick's executor exposes `executeStream` **and** the target's
`capabilities.supportsStreaming` is not explicitly `false`. On the
streaming path the adapter owns symmetric event emission (`message` /
`content` / `tool-call` / `message-end` deltas drained through the
run-execution sink); on the non-streaming path the loop synthesizes those
summary deltas from the normalized result so subscribers see the same events
either way.

### The fiber spine — `.fx` and the edge-facade (ADR 77)

The loop's `runExecutionBody` is **one `Effect.gen` fiber**. Every
downstream harness call composes in-fiber via its `.fx` twin — `yield*
compiler.fx.renderTree(...)`, `executor.fx.{run,project,executeStream,
normalize}(...)`, `toolExecutor.fx.{replaceCompilerTools,compileForTick,
dispatch}(...)`, `stateApplicator.fx.apply*(...)` — with no `runPromise`
root between boundaries.

**Two first-class public surfaces, one operation.** Every spine harness
exposes both:

- **The Promise edge-facade** (`loop.runExecution(...)`, `executor.run(...)`,
  …) — the ergonomic default. `await` it; it resolves the result. This is
  the entity boundary the gateway/client/wire speak.
- **The `.fx` Effect-native twin** (`loop.fx.runExecution(...)`,
  `executor.fx.run(...)`, …) — the composable surface for adopters who
  work in Effect. `harness.fx.<op>(...)` returns an **un-run** `Effect`;
  `yield*` it inside your own `Effect.gen` to compose it into your fiber
  tree (telemetry, interruption, and `FiberRef` context all propagate).
  The facade is exactly `runHarnessProtocol(harness.fx.<op>(...))` — the
  twin minus the terminal `runPromise`.

Neither is second-class: the facade is the default; `.fx` is the peer for
Effect-native composition. The framework itself composes the spine through
`.fx`.

Because the spine is one fiber, three capabilities fall out:

- **Nested telemetry.** Run the composed execution on a tracer
  `ManagedRuntime` (the session does this automatically when the app has a
  `telemetry` Layer) and the whole trace nests — `loop:command:run-execution`
  > `executor:command:*` + `tool:command:dispatch` + `compiler:command:
render-tree` — with `parentOpId` auto-linked via `FiberRef`. No manual
  > span threading.
- **Structured cancellation.** `loop.abort()` (→ `session.send(...).abort()`)
  tears down the IN-FLIGHT model call / tool handler immediately: a
  per-execution `AbortController`, merged with the caller's `signal`, is
  threaded to `executor.fx.run`/`executeStream` + `toolExecutor.fx.dispatch`.
  The executor turns it into real Effect fiber interruption of the provider
  call. Partial output up to the abort is preserved on the canceled terminal.
- **Parallel tool dispatch.** A tick's tool calls dispatch **concurrently**
  by default (`input.toolConcurrency` / `SendInput.toolConcurrency`,
  `"unbounded"`; set a number to cap, `1` for sequential). `Effect.all`
  keeps results in call-order regardless of concurrency; abort/timeout
  interrupts every in-flight tool fiber.
- **Execution timeout.** Opt-in `input.timeoutMs` / `SendInput.timeoutMs`
  (no default — the framework ships the mechanism, not a policy). On expiry
  the execution structurally aborts and the terminal lands `canceled` with
  `stopReason: "timeout"`.

## Status

- ✅ Canonical tick loop (`LoopExecutorHarness`): render → execute →
  dispatch → apply → continuation, bounded by `maxTicks`.
- ✅ **Fiber spine (ADR 77)** — `runExecutionBody` is one `Effect.gen`
  composing every downstream call via its `.fx` twin. Dual public surface:
  the Promise edge-facade + the `.fx` Effect-native twin.
- ✅ **Nested telemetry** — spans nest under the execution when run on a
  tracer runtime (session-wired); `parentOpId` auto-threads via `FiberRef`.
- ✅ **Structured cancellation** — `abort()` tears down in-flight model/tool
  work immediately (merged `AbortSignal` → executor + dispatch), preserving
  partial output.
- ✅ **Parallel tool dispatch** — concurrent by default, call-order results,
  `toolConcurrency`-configurable.
- ✅ **Execution timeout** — opt-in `timeoutMs`, structured abort,
  `stopReason: "timeout"`.
- ✅ Streaming + non-streaming execution paths with symmetric events.
- ✅ **Streaming-up (ADR 51 §2)** — `loop:run-execution` is a `commandStream`;
  its chunks ARE the `LoopExecutionEvent`s, drained through a `LoopExecutionSink`
  (`.fx` sink-fold for the session, `.run` no-op drain for the facade). The
  `onLoopRunExecutionChunk` per-chunk interceptor is minted for free.
- ✅ Lifecycle bridge to the compiler hook store (ADR 54/55) —
  tick/execution/tool start+end.
- ✅ Per-tick `RenderContext` threading (`resolveRenderContext`, ADR 55).
- ✅ Per-tick model resolution against the `ModelBridge`
  (`resolveModel`, precedence tick-IR > send > session, ADR 56).
- ✅ Tick-end forward decision (ADR 53 steering — new input mid-execution
  keeps the loop ticking).
- ✅ `defineLoop` callback factory; `NoopStateApplicator`.

## Roadmap & known gaps

- **Internal-exposure command.** `loop:run-execution` is declared
  `exposure: "internal"` — its input carries live object refs (compiler,
  executor, tool-executor, `stateApplicator`, the session resolvers + the
  event sink), so it is never inbox/wire-addressable (ADR 51 §1.2). The
  addressable execution surface is the _session's_, not the loop's — see
  the session harness `TODO(adr-51-session-verbs)`.
- **Inbox dispatch not wired.** `handleMessage` rejects with
  `HandlerError` on both `LoopExecutorHarness` and the `defineLoop`
  `CallbackLoopExecutor`. Loop-addressed inbox messages (external
  `halt`, replay control) are a later phase.
- **`resolveModel` precedence is post-render.** Reflecting the IR-declared
  model back into the render-context `activeModel` slot (so the _same_
  render sees the model it will run) needs render → resolve → re-render
  convergence — `TODO(adr-56-slice-2: force-render activeModel)`. The
  per-tick _execution_ model resolves without that (no chicken-and-egg).
- **`<Model model={adapter}>` sugar deferred.** The adopter face that
  derives `{modelExecutor, target}` from a live `@agentick/model-next` adapter
  lands in a binding package depending on both compiler-react +
  model-next — `TODO(adr-56-slice-1)`. Until then, refs register directly
  on the `ModelBridge`.
- **`ExecutionRunResult.outputs`** (Phase 4f `OutputDeclaration`
  extractions) is threaded through the type but not populated by the loop.

## Verified by

- `src/__tests__/conformance.spec.ts` — `LoopExecutorProtocol`
  conformance suite against the reference harness.
- `src/__tests__/define-loop.spec.ts` — `defineLoop` factory wiring,
  substrate sharing, abort routing.
- `src/__tests__/layered-tools.spec.ts` — tool-declaration sync into the
  tool executor + per-tick model-visible compile.
- `src/__tests__/characterization.spec.ts` — 28-test net pinning the tick
  loop's control flow / continuation behavior byte-identical across the
  `Effect.gen` rewrite (ADR 77 Gate 0).
- `src/__tests__/fx-run-execution.spec.ts` — the `.fx.runExecution` twin is
  a composable Effect; the facade is its `runHarnessProtocol` derivation.
- `src/__tests__/cancellation.spec.ts` — structured cancellation (abort
  tears down a hanging model call / tool handler), parallel dispatch
  (rendezvous proof of concurrency + call-order results), execution timeout
  (`stopReason: "timeout"`).
- Cross-harness integration (real compiler + executor + tool-executor,
  lifecycle bridge, per-tick model resolution) lives in
  `@agentick/session-next/__tests__/` (`lifecycle-bridge.spec.tsx`,
  `model-bridge.spec.tsx`) — tests live where their dependencies live
  (ADR 27).

## See also

- [ADR 05 — Loop executor](../../docs/proposals/v2/blueprint/05-loop-executor.md)
- [ADR 77 — Operation spine + dual-typed edge](../../docs/proposals/v2/blueprint/77-operation-spine-and-dual-typed-edge.md)
  · [SPINE-COMPOSE-PLAN](../../docs/proposals/v2/SPINE-COMPOSE-PLAN.md) — the staged tracker
- [ADR 53 — Timeline offsets / steering](../../docs/proposals/v2/blueprint/53-timeline-offsets-not-tiers.md)
- [ADR 55 — Render-context seam](../../docs/proposals/v2/blueprint/55-render-context-seam.md)
- [ADR 56 — Tree-declared model per tick](../../docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md)
- [`@agentick/session-next`](../session/README.md) — the harness that
  drives the loop and produces its render-context + model resolvers.
- [`@agentick/spec-next`](../spec/README.md) — the protocol contracts.
  </content>
