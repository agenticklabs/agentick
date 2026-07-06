# @agentick/loop-executor-next

**LoopExecutorHarness — one agent execution, run tick by tick.**

The orchestration harness that runs a single execution to terminal. It
composes the four downstream harnesses — reconciler, executor,
tool-executor, and the session's state applicator — through the
canonical tick loop, emitting a per-phase event stream so the whole
execution is auditable from one subscriber on `surface: "loop"`.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## Purpose

A `LoopExecutorProtocol` implementation owns the answer to "what
happens between `session.send()` and the terminal result?" That is:

1. **render** the JSX tree to a `RenderedTree` (reconciler),
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
reconciler's hook store — all without knowing what any individual fact
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
  reconciler, // ReconcilerProtocol
  mountId, // string
  executor, // ExecutorProtocol
  target, // ExecutionTarget
  toolExecutor, // ToolExecutorProtocol
  stateApplicator, // StateApplicator (see NoopStateApplicator)
  maxTicks: 8,
});
// terminal.outcome: "succeeded" | "canceled" | ...
// terminal.result: ExecutionRunResult (ticks, usage, stopReason, output, toolResults)
```

`runExecution` runs through `runOperation`, so the loop's typed
lifecycle (`loop:command:run-execution`) flows onto the shared bus and
journal. `abort({ executionId })` terminates an in-flight run with
`outcome: "canceled"`.

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
    const { tree } = await input.reconciler.renderTree({
      mountId: input.mountId,
      sessionId: input.sessionId,
    });
    const terminal = await input.executor.run({
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
`ExecutionTerminal`, `ExecutionRunResult`, `LoopEmittedEvent`,
`StateApplicator`, `LoopToolResult`) lives in `@agentick/spec-next`
(`protocol/loop-executor.ts`).

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
  unresolvable ref, falls back to `input.executor` / `input.target`.

### The lifecycle bridge

The loop is the producer for the reconciler's `useOn*` hook family
(ADR 54/55). It calls `reconciler.notifyLifecycle` at each boundary:

| Moment           | `LifecycleEvent.kind` | Lights up             | Timing                              |
| ---------------- | --------------------- | --------------------- | ----------------------------------- |
| execution begins | `execution-start`     | `useOnExecutionStart` | fire-and-forget                     |
| tick begins      | `tick-start`          | `useOnTickStart`      | **awaited, before render**          |
| tool dispatched  | `tool-start`          | `useOnToolStart`      | fire-and-forget                     |
| tool finished    | `tool-end`            | `useOnToolEnd`        | fire-and-forget                     |
| tick ends        | `tick-end`            | `useOnTickEnd`        | awaited (carries this tick's usage) |
| execution ends   | `execution-end`       | `useOnExecutionEnd`   | fire-and-forget                     |

`tick-start` is **awaited before render** — without this bridge the
entire `useOn*` family is inert (no producer). Hook throws never fail
the run: the hook store isolates per-listener throws, and fire-and-forget
events use `void`.

The **same** moments flow independently onto the public event stream via
`input.onEvent` (`LoopEmittedEvent`) — the session stamps these into
`StreamEvent`s for the `SessionExecutionHandle` iterator. Two channels,
different questions: the lifecycle bridge is for in-tree React hooks that
must settle before the next operation; `onEvent` is the out-of-band data
stream for the caller. Bus envelopes fan out to observability
(devtools, telemetry) in parallel with both.

### Streaming vs non-streaming

The loop takes the streaming path when `input.stream` is set **and** the
tick's executor exposes `executeStream` **and** the target's
`capabilities.supportsStreaming` is not explicitly `false`. On the
streaming path the adapter owns symmetric event emission (`message` /
`content` / `tool-call` / `message-end` deltas forwarded through
`onEvent`); on the non-streaming path the loop synthesizes those summary
deltas from the normalized result so subscribers see the same events
either way.

## Status

- ✅ Canonical tick loop (`LoopExecutorHarness`): render → execute →
  dispatch → apply → continuation, bounded by `maxTicks`.
- ✅ Streaming + non-streaming execution paths with symmetric events.
- ✅ Per-phase `LoopEmittedEvent` stream via `onEvent`.
- ✅ Lifecycle bridge to the reconciler hook store (ADR 54/55) —
  tick/execution/tool start+end.
- ✅ Per-tick `RenderContext` threading (`resolveRenderContext`, ADR 55).
- ✅ Per-tick model resolution against the `ModelBridge`
  (`resolveModel`, precedence tick-IR > send > session, ADR 56).
- ✅ Tick-end forward decision (ADR 53 steering — new input mid-execution
  keeps the loop ticking).
- ✅ `defineLoop` callback factory; `NoopStateApplicator`.

## Roadmap & known gaps

- **Not a declarable command.** `runExecution` carries live object refs
  (reconciler, executor, tool-executor, `stateApplicator` callbacks,
  `onEvent`) and is in-process-only by ADR 51 §1.2 doctrine. The
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
  derives `{executor, target}` from a live `@agentick/model-next` adapter
  lands in a binding package depending on both reconciler-react +
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
- Cross-harness integration (real reconciler + executor + tool-executor,
  lifecycle bridge, per-tick model resolution) lives in
  `@agentick/session-next/__tests__/` (`lifecycle-bridge.spec.tsx`,
  `model-bridge.spec.tsx`) — tests live where their dependencies live
  (ADR 27).

## See also

- [ADR 05 — Loop executor](../../docs/proposals/v2/blueprint/05-loop-executor.md)
- [ADR 53 — Timeline offsets / steering](../../docs/proposals/v2/blueprint/53-timeline-offsets-not-tiers.md)
- [ADR 55 — Render-context seam](../../docs/proposals/v2/blueprint/55-render-context-seam.md)
- [ADR 56 — Tree-declared model per tick](../../docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md)
- [`@agentick/session-next`](../session/README.md) — the harness that
  drives the loop and produces its render-context + model resolvers.
- [`@agentick/spec-next`](../spec/README.md) — the protocol contracts.
  </content>
