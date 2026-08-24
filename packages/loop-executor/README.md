# @agentick/loop-executor

**A tick is a command, not a private step.** The loop executor turns one agent execution into a bounded sequence of ticks — render, model call, tool dispatch, state apply — and each tick is a declared operation whose terminal is the barrier the next tick waits on.

That is the bet. Because the tick is an operation rather than an inner block of a `while` loop, everything you would otherwise hand-plumb falls out of the same machinery every other layer uses: per-tick hooks, admission guards, journal causality, nested spans, structured cancellation, and the execution event stream. The loop itself holds no state and interprets nothing — it composes four protocol surfaces and stops.

## Install

```bash
npm install @agentick/loop-executor
```

## Quick start

Construct it on a substrate and run one execution to terminal. The compiler and tool executor are the ones your app already mounted; the model is scriptable, so this runs with no provider.

```ts
import { LoopExecutorHarness, NoopStateApplicator } from "@agentick/loop-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { SPEC_VERSION } from "@agentick/spec";
import type { CompilerProtocol, ToolExecutorProtocol } from "@agentick/spec";

async function runOnce(compiler: CompilerProtocol, toolExecutor: ToolExecutorProtocol) {
  const journal = new MemoryJournal();
  const bus = new LocalEventBus();
  const inbox = new LocalInbox();

  const loop = new LoopExecutorHarness("loop:demo", journal, bus, inbox);
  const model = new FakeLanguageModelExecutor("model:demo", journal, bus, inbox, {
    scripted: {
      result: {
        specVersion: SPEC_VERSION,
        output: [{ type: "text", text: "done" }],
        stopReason: "end",
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      },
    },
  });
  await Promise.all([loop.ready, model.ready]);

  const terminal = await loop.runExecution({
    executionId: "exec-1",
    sessionId: "session-1",
    mountId: "mount-1",
    compiler,
    modelExecutor: model,
    target: model.target,
    toolExecutor,
    stateApplicator: new NoopStateApplicator(),
    maxTicks: 8,
  });

  console.log(terminal.outcome); // "succeeded"
  console.log(terminal.result?.ticks); // 1
  console.log(terminal.result?.stopReason); // "end"
  console.log(terminal.result?.usage.totalTokens); // 15
}
```

Most apps never write that. `createApp` constructs a `LoopExecutorHarness` on the app substrate and the session drives it. You reach for this package to **observe** a tick, **gate** the loop, **guard** a tick, or **replace** the orchestration outright.

## What one tick does

| Step | Call                                                                | Notes                                                                       |
| ---- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1    | `compiler.fx.renderTree({ mountId, renderContext })`                | Per-render facts are threaded in, read synchronously during render          |
| 2    | `toolExecutor.fx.replaceCompilerTools` → `compileForTick`           | The render's tool slice syncs in; the resolved model-visible set comes back |
| 3    | `modelExecutor.fx.run` **or** `project → executeStream → normalize` | Streaming when asked for and supported                                      |
| 4    | `toolExecutor.fx.dispatch` per `result.toolCalls`                   | Concurrent by default; results stay in call order                           |
| 5    | `stateApplicator.fx.applyExecutorResult` / `applyToolResults`       | Writes land **before** the continuation decision                            |

Steps 1–5 are the body of the `loop:tick` command. Its terminal is the tick barrier: tick _k+1_ never starts before tick _k_ has settled.

> [!IMPORTANT]
> Step 5 precedes the decision by construction, which is what makes a dangling `tool_use` impossible. Even a hard stop at the `maxTicks` cap on a `tool_use` tick has already persisted that tick's `tool_result`s.

Model resolution is per tick, in precedence order **tree-declared `<Model>` > send-level > session default**. When the tree's IR carries a model declaration, the loop resolves it through the caller-supplied `resolveModel` and runs that executor and target for the tick; `decl.parameters` overlay the compiled tree's generation config. A tick that resolves no model at all fails the execution with `NoModelForExecutionError` — model-less sessions are legal, model-less _ticks_ are not.

### Starting partway through — `startTickIndex`

A run normally starts its tick counter at 0. `startTickIndex` starts it somewhere else, which is how a turn that a crash interrupted is finished rather than restarted:

```ts
import type { RunExecutionInput } from "@agentick/spec";

declare const input: RunExecutionInput;

const terminal = await loop.runExecution({
  ...input,
  executionId: "exec-1", // the SAME execution, continued
  startTickIndex: 3, // three ticks are already durable
  maxTicks: 8,
});
```

The next tick stamps `tickIndex: 4`, and `maxTicks` remains the **execution's** total budget rather than a fresh allowance — the run above gets 5 more ticks, not 8. The terminal's `ticks` reports the execution total for the same reason. Absent, it is 0.

Callers do not usually write this: [@agentick/session](../session#re-driving-an-interrupted-execution)'s `resumeExecution` supplies the seed, reading it off the timeline's own execution cursor.

## The continuation gate

The loop's own disposition is intrinsic and dumb: `stopReason === "tool_use"` with pending tool calls means keep ticking, anything else means stop. It rides the settled `TickResult` as `shouldContinue`.

The real decision is a seam. Supply `notifyTickEnd` and you own loop continuation:

```ts
import type { RunExecutionInput } from "@agentick/spec";

type TickEndGate = NonNullable<RunExecutionInput["notifyTickEnd"]>;

const notifyTickEnd: TickEndGate = async ({ result }) => {
  // Hold the loop open even though the model stopped — new input arrived.
  if (hasUnansweredInput()) return { kind: "continue" };
  // Force a stop even though the model asked for more tools.
  if (result !== undefined && result.toolResults.some((r) => !r.succeeded)) {
    return { kind: "stop", reason: "tool failed" };
  }
  return undefined; // abstain — the loop's own disposition stands
};

declare function hasUnansweredInput(): boolean;
```

Resolution is two-tier: **stop-force beats continue-force beats abstain**, all under `maxTicks` as a hard cap that no `continue` can exceed. This is a _gate_ — it decides whether the loop runs another tick. It is not a guard; guards admit or deny a single operation (see below).

A stop-force reports `stopReason: "halted"` with `stopCause: { kind: "halted", reason }` — distinct from the provider's own reason, from `"aborted"` (cancelled from outside) and from `"vetoed"` (a guard refused the model call). The reason string is carried verbatim, so `stopOnTools("done")` in [@agentick/gates](../gates) surfaces as `reason: "gate:done"` and a caller can say WHY the turn ended. `halted` is a normal completion, not a failure.

`notifyTickEnd` runs **after** the tick command's terminal, so every hook registered on `onAfterLoopTick` has already settled. Settle is in the cascade; decide is outside it.

### Failed ticks reach the gate too

A tick whose executor terminal is `failed` goes through the same seam, with `outcome: "failed"` and the failed `TickResult`. The default flips for that outcome: **abstain means stop**, so with no participant the run ends with `stopReason: "executor_failed"` exactly as it always did, and a `continue` is a retry.

Retry is safe by construction: a failed tick persists nothing (the state applicator runs only on the success path), so the next iteration renders the same tree over the same timeline and issues an identical model request — as a new tick with a fresh `tickId`, carrying `retryOfTick` on its `tick-start` event. `canceled` and `vetoed` terminals never reach the gate: an abort is not a failure to recover from, and a veto already decided.

Streaming and `stream: false` behave identically here, and the loop needs no arm of its own for the difference: the streaming path folds the model call's error channel into a terminal, `executor.run` returns one directly, and the gate sees the same shape either way.

`maxConsecutiveFailedTicks` (default 3) is the backstop. It counts consecutive failed terminals, resets on success, and reports the last failure as `stopCause` when it stops the run. `TickResult.consecutiveFailures` carries the same count to every participant, so a policy bounds itself without private state. Which failures are worth re-issuing is policy, and lives above this: see `tickFailurePolicy` in [@agentick/session](../session).

## Hook and guard a tick

The `loop:tick` and `loop:run-execution` commands mint their lifecycle surface. Registering on it is how the session projects React's `useOnTickStart` / `useOnTickEnd` — and it is available to you directly:

```ts
import type { LoopExecutorHarness } from "@agentick/loop-executor";

declare const loop: LoopExecutorHarness;

const off = loop.hook({
  onBeforeLoopTick: (input) => {
    console.log(`tick ${input.tickIndex} starting (${input.tickId})`);
  },
  onAfterLoopTick: async (result) => {
    // Awaited IN the command cascade — the terminal does not resolve until
    // this returns, so the continuation decision reads settled state.
    await persist(result.toolResults);
  },
});

// Admission, not continuation: veto the tick before it renders.
const offGuard = loop.guard({
  loopTick: (input) => (input.tickIndex > 3 ? { kind: "veto", reason: "budget" } : undefined),
});

off();
offGuard();

declare function persist(x: unknown): Promise<void>;
```

> [!WARNING]
> `onBeforeLoopTick` and `onAfterLoopTick` are **awaited in the command cascade**, not fire-and-forget. A throw in either fails the whole execution. That is deliberate — the tick-end settle is load-bearing — but it means your handler owns its own error containment.

| Verb                 | Hooks                                                                              | Guard key          |
| -------------------- | ---------------------------------------------------------------------------------- | ------------------ |
| `loop:run-execution` | `onBeforeLoopRunExecution` · `onAfterLoopRunExecution` · `onLoopRunExecutionChunk` | `loopRunExecution` |
| `loop:tick`          | `onBeforeLoopTick` · `onAfterLoopTick`                                             | `loopTick`         |

Both verbs are `exposure: "internal"` — their inputs carry live object references, so they are never inbox- or wire-addressable. The addressable execution surface belongs to the session.

## The execution event stream

`loop:run-execution` is a streaming command: its chunks **are** the `LoopExecutionEvent`s the run produces. `loop.runExecution(input)` is the drain-only face — it returns the settled terminal and drops the events. To read them, compose the sink-fold twin:

```ts
import { Effect } from "effect";
import type { LoopExecutionEvent, RunExecutionInput } from "@agentick/spec";
import type { LoopExecutorHarness } from "@agentick/loop-executor";

declare const loop: LoopExecutorHarness;
declare const input: RunExecutionInput;

const events: LoopExecutionEvent[] = [];
const terminal = await Effect.runPromise(
  loop.fx.runExecution(input, (event) => Effect.sync(() => events.push(event))),
);

events.map((e) => e.kind);
// ["execution-start", "tick-start", "model", …, "tick-end", "tick", "execution-end"]
```

Events are emitted on the run's own fiber, in order, with no intermediate queue — backpressure is your sink. The run's bookends and each tick's events share the one channel, so `model` deltas and tool-dispatch lifecycle interleave exactly as they happened.

The same stream is tappable without wiring a sink at all, because a streaming command's chunks are interceptable:

```ts
import type { LoopExecutorHarness } from "@agentick/loop-executor";

declare const loop: LoopExecutorHarness;

const off = loop.hook({
  onLoopRunExecutionChunk: {
    observe: (event) => metrics.increment(`loop.event.${event.kind}`),
  },
});

declare const metrics: { increment(name: string): void };
```

That observer fires on the drain-only Promise path too — zero wiring, no sink of your own.

## Cancellation, timeout, and tool concurrency

The whole run is one `Effect.gen` fiber, so cancellation is structural rather than cooperative. `abort()` fires a per-execution `AbortController`, merged with any caller `signal`, threaded to the in-flight model call **and** every in-flight tool dispatch:

```ts
import type { LoopExecutorHarness } from "@agentick/loop-executor";
import type { RunExecutionInput } from "@agentick/spec";

declare const loop: LoopExecutorHarness;
declare const input: RunExecutionInput;

const running = loop.runExecution({
  ...input,
  timeoutMs: 30_000, // opt-in; no default
  toolConcurrency: "unbounded", // the default; a number caps, 1 is sequential
});

await loop.abort({ executionId: input.executionId, reason: "user-stop" });

const terminal = await running;
terminal.outcome; // "canceled"
terminal.reason; // "user-stop"
terminal.result?.output; // partial output up to the abort is preserved
```

A mid-flight abort tears the provider call down immediately, not at the next tick boundary. A `timeoutMs` expiry travels the same path and lands `outcome: "canceled"` with `stopReason: "timeout"`. A tick's tool calls dispatch concurrently by default, and results stay in **call order** regardless of completion order, so persistence and the model's next-tick view are deterministic.

> [!NOTE]
> Every cancellation entry point reports the same way: `abort()`, `timeoutMs`, and a caller-supplied `signal` all land `outcome: "canceled"`, with `stopReason` naming which one fired (`"aborted"` / `"timeout"`). A signal that aborts only _after_ the run finished naturally does not relabel the finished work — that run stays `"succeeded"`.

## Structured output

When the run carries an `outputSpec` — or the rendered tree declares one — the loop is the delivery and validation authority. Per tick it resolves the strategy (`"tool"` injects a synthetic terminal tool at the tail of the model-facing list; `"responseFormat"` folds a `json_schema` directive into the tick's config; `"auto"` picks between them from the tick's tool count and the target's capabilities), captures the terminal call's raw input, validates it against the resolved schema, and surfaces the validated value on `ExecutionRunResult.data`. A schema miss fails the execution with `ResponseValidationError`; a required terminal tool that went uncalled gets one forced wrap-up tick with `toolChoice: { tool }` before failing with `StructuredOutputIncomplete`.

The overlay precedence for the generation directive is explicit-beats-ambient: a send-level `responseFormat` wins over a per-tick `<Model>` parameter patch, which wins over the tree's own config.

## What a run cost

Every tick is priced **once**, when it settles, and never again. The loop is the earliest place where a tick's usage and the model that produced it are both known — the model executor returns a result without knowing which model made it, and the `<Model>` cascade resolves per tick — so the stamp lives here rather than one layer down.

Declare rates on the target and the loop does the arithmetic:

```ts
import type { ExecutionTarget } from "@agentick/spec";

const target: ExecutionTarget = {
  kind: "language-model",
  provider: "anthropic",
  modelId: "claude-sonnet-5",
  rates: {
    // DATE it. A price change is a NEW card, not an edit to this one —
    // an id that survives a repricing defeats the point of stamping.
    id: "anthropic:claude-sonnet-5@2026-07-01",
    currency: "USD",
    // Micro-units per MILLION tokens: $3/MTok is 3_000_000.
    perMTok: { input: 3_000_000, output: 15_000_000, cacheRead: 300_000, cacheWrite: 3_750_000 },
  },
};
```

Rates ride the target through the per-tick cascade, so a tree-declared `<Model>` brings its own card with it. For pricing that is not a table — per-tenant contracts, marketplace markup, a credit system — supply a `costResolver` on the run input:

```ts
import type { CostResolver, RateCard } from "@agentick/spec";

const costResolver: CostResolver = ({ usage, sessionId }) => {
  const contract = contracts.get(sessionId);
  if (contract === undefined) return undefined; // fall through to target.rates
  // Return a Cost to say "I did the arithmetic" — the number billed is
  // not a function of tokens at all (a credit system, a flat per-seat fee).
  if (contract.credits !== undefined) {
    return {
      amountMicros: usage.totalTokens * contract.credits,
      currency: "USD",
      rateRef: contract.id,
    };
  }
  // Return a RateCard to say "here are the rates, you do the arithmetic".
  return contract.card;
};

declare const contracts: Map<string, { id: string; credits?: number; card: RateCard }>;
```

The resolver **wins whenever it returns a value**; `undefined` falls through to the target's declared rates. Discrimination is structural — a `Cost` has `amountMicros`.

The stamp then lands in three places: `cost` and `model` on the tick's `tick` / `tick-end` events, the same pair on the `applyExecutorResult` call so the session can write them onto the generation's timeline entry, and the run-level fold on the terminal:

```ts
terminal.result?.usage; // flat totals — safe to sum, meaningless to price
terminal.result?.byModel; // { "anthropic/claude-sonnet-5": { usage, ticks, cost } }
terminal.result?.cost; // { kind: "complete", amountMicros, currency, ticks, rateRefs }
```

`byModel` exists because a run can change model mid-flight, so the flat `usage` routinely mixes rate tiers and is not a thing you can price. A run that recorded no usage at all has neither `cost` nor `byModel` — absent, not zero.

> [!IMPORTANT]
> **An unpriced tick never rolls up as zero.** A tick with usage and no rate card is _unpriced_, and the run reports `{ kind: "partial", amountMicros, pricedTicks, unpricedTicks }` where `amountMicros` is a **lower bound**, not a total. Zero is a claim — "this cost nothing" — and folding an unpriced tick in as zero produces a number that is confidently, silently low in the direction nobody double-checks. The union forces the two cases to render different words. The framework ships **no prices**: a model with no rates produces no cost, which is true, rather than a seeded guess, which is confidently wrong.

## `defineLoop` — replace the orchestration

Subclass `LoopExecutorHarness` to change one tick step. To change the _topology_ — a single-call loop with no tool round trip, a parallel multi-model fan-out, a replay driver — bring a callback instead:

```ts
import { defineLoop } from "@agentick/loop-executor";
import type { ExecutionTerminal } from "@agentick/spec";

export const singleTickLoop = defineLoop({
  async runExecution(input): Promise<ExecutionTerminal> {
    if (input.modelExecutor === undefined || input.target === undefined) {
      throw new Error("no model resolved for this execution");
    }

    const { tree } = await input.compiler.renderTree({
      mountId: input.mountId,
      sessionId: input.sessionId,
      executionId: input.executionId,
    });
    const tools = await input.toolExecutor.compileForTick({ exposure: "model" });

    const terminal = await input.modelExecutor.run({
      compiled: tree,
      target: input.target,
      tools,
      scope: { sessionId: input.sessionId, executionId: input.executionId },
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    if (terminal.outcome !== "succeeded") return { outcome: terminal.outcome };

    await input.stateApplicator.applyExecutorResult({
      sessionId: input.sessionId,
      executionId: input.executionId,
      tickId: "tick-1",
      result: terminal.result,
    });

    return {
      outcome: "succeeded",
      result: {
        executionId: input.executionId,
        ticks: 1,
        usage: terminal.result.usage ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        stopReason: terminal.result.stopReason,
        output: terminal.result.output,
        toolResults: [],
      },
    };
  },
});
```

`defineLoop` returns a `LoopExecutorFactory`. Pass it as `createApp({ loop: singleTickLoop })` and the app invokes it with the shared journal, bus, and inbox, so the callback loop's operation envelopes land on the same substrate as everything else. Called with no dependencies it builds its own in-memory substrate, which is what makes it usable standalone in a test.

Throw to fail the execution — the wrapper folds an exception into `outcome: "failed"`. If your callback does not honour `input.signal`, supply an `abort` override; otherwise the wrapper layers its own `AbortController` over the input signal and routes `abort()` to it.

## `NoopStateApplicator`

The loop requires somewhere to write results. With no session present, plug in the noop:

```ts
import { NoopStateApplicator } from "@agentick/loop-executor";

const stateApplicator = new NoopStateApplicator();
```

Every apply call is a no-op, on both the Promise facade and the `fx` twins. Nothing writes to the timeline the tree reads, so multi-tick runs will not show prior ticks' tool results in the next render — it is for single-tick and cap-bounded scenarios, not a substitute for the real applicator.

## API

### `@agentick/loop-executor`

| Export                | Purpose                                                                            |
| --------------------- | ---------------------------------------------------------------------------------- |
| `LoopExecutorHarness` | The reference tick loop. Construct with `(scopeId, journal, bus, inbox, options?)` |
| `defineLoop(spec)`    | Build a `LoopExecutorFactory` from a `runExecution` (+ optional `abort`) callback  |
| `NoopStateApplicator` | `StateApplicator` whose every write is a no-op                                     |
| `DefineLoopInput`     | The callback bundle `defineLoop` accepts                                           |

### The instance

| Member                            | Returns                                                                  |
| --------------------------------- | ------------------------------------------------------------------------ |
| `runExecution(input)`             | `Promise<ExecutionTerminal>` — drain-only; events are dropped            |
| `fx.runExecution(input, sink)`    | Un-run `Effect` — composes in your fiber, drains events to `sink`        |
| `abort({ executionId, reason? })` | Cancels the named run; the terminal lands `canceled`                     |
| `hook(config)` / `hooks.*`        | Register command lifecycle hooks; returns an unsubscribe                 |
| `guard(config)`                   | Register an admission verdict (`proceed` / `veto` / `replace` / `defer`) |
| `use(mw)`                         | Register middleware over this instance's operations                      |
| `commands()`                      | Enumerate the declared verbs                                             |
| `ready`                           | Resolves when the substrate is initialized                               |

### Shapes

`RunExecutionInput`, `ExecutionTerminal`, `ExecutionRunResult`, `TickInput`, `TickResult`, `LoopExecutionEvent`, `LoopExecutionSink`, `LoopToolResult`, and `StateApplicator` all live in [@agentick/spec](../spec).

## Patterns

**Who drives it.** [@agentick/app](../app) constructs a `LoopExecutorHarness` on the app substrate (or calls your `LoopExecutorFactory`) and folds the app's resolved interceptors into it, so a later `app.use()` / `app.guard()` / `app.hook()` reaches the loop too. [@agentick/session](../session) supplies the per-tick render context, the model resolver, the state applicator, and the continuation gate, and consumes `fx.runExecution` so the whole execution is one fiber.

**What it composes.** [@agentick/compiler-react](../compiler-react) renders the tree, [@agentick/model-executor](../model-executor) makes the model call, [@agentick/tool-executor](../tool-executor) resolves and dispatches tools.

**Certifying an alternate loop.** `runLoopExecutorConformance` in [@agentick/spec-conformance](../spec-conformance) exercises the `LoopExecutorProtocol` contract against any implementation, including one built with `defineLoop`.

## Roadmap & known gaps

- **Inbox dispatch is not wired.** `handleMessage` rejects with `HandlerError` on both `LoopExecutorHarness` and the `defineLoop` wrapper. Loop-addressed messages (external halt, replay control) are unbuilt.
- **`defineLoop` cannot stream events.** The callback returns a terminal, so the `runExecution` sink it is handed has nothing to drain. Subclass `LoopExecutorHarness` if you need the event stream from custom orchestration.
- **The tree-declared model is resolved post-render.** A `<Model>` in the IR selects the executor for _that_ tick, but the render that declared it did not see it in its own render context. Closing that needs render → resolve → re-render convergence.
- **`ExecutionRunResult.outputs`** is threaded through the type and never populated.
- **A cost rollup carries one currency.** A tick priced in a second currency counts toward `unpricedTicks` rather than being summed in — it stays fully priced in its own `byModel` bucket. Per-currency buckets are unbuilt; summing across currencies is the same class of lie as summing unpriced ticks as zero.
- **No `maxCost` bound.** `maxTicks` caps a run by count, not by spend. The stamped per-tick `Cost` is the input such a bound needs, so it is a small addition rather than a subsystem — but it is not here.
- **`startTickIndex` has no unit coverage here.** The seed is exercised end to end in [@agentick/app](../app) (`execution-resume.spec.tsx`), where a turn whose last durable tick was 1 continues at tick 2 under its original execution id. That a seeded run consumes the _remainder_ of `maxTicks` rather than a fresh allowance follows from the shared counter but is not asserted on its own.
- **No `ctx.log` in the tick body.** The log facet is threaded into the tool executor and the session but not the loop, so decisions like the structured-output strategy fallback are silent rather than warned.

## Verified by

- `src/__tests__/conformance.spec.ts` — the `LoopExecutorProtocol` contract against the reference loop.
- `src/__tests__/characterization.spec.ts` — tick counts and stop reasons for `end` / `tool_use` / `max_ticks`; the two-tier gate resolution including the cap; settle-before-decide and persist-before-decide ordering; executor failure, cancel, and veto paths; soft and hard tool-dispatch errors; usage accumulation across ticks; the event order `execution-start → tick-start → tick-end → tick → execution-end`; streaming and non-streaming parity.
- `src/__tests__/tick-command.spec.ts` — N ticks mint N `loop:tick` commands in order, the tick barrier (tick _k+1_'s `onBefore` only after tick _k_'s `onAfter`), and the async settle completing inside the cascade before the decision.
- `src/__tests__/cancellation.spec.ts` — `abort()` tearing down a hanging model call and a hanging tool handler; concurrent dispatch proven by a rendezvous that would deadlock if sequential, with call-order results; `toolConcurrency: 1`; `timeoutMs` landing `stopReason: "timeout"`.
- `src/__tests__/no-dangling-tool-use.spec.ts` — `applyToolResults` observed even when the loop stops at the cap on a `tool_use` tick.
- `src/__tests__/layered-tools.spec.ts` — the render's tool slice syncing into a real tool executor, precedence over extension-bound tools, model-exposure filtering, and clearing the slice when a tick renders nothing.
- `src/__tests__/run-execution-chunk-hook.spec.ts` — `onLoopRunExecutionChunk` seeing the run's events in order on the drain-only path, and unsubscribing.
- `src/__tests__/fx-run-execution.spec.ts` — `fx.runExecution` is an un-run `Effect`; the Promise method is its facade; both produce the same terminal.
- `src/__tests__/fx-state-applicator.spec.ts` — `NoopStateApplicator`'s twins are composable Effects that nest in one `Effect.gen`.
- `src/__tests__/response-format-overlay.spec.ts` — send-level `responseFormat` beating both the tree config and a per-tick `<Model>` parameter patch.
- `src/__tests__/cost-stamping.spec.ts` — the resolver beating declared rates, `undefined` falling through to them, and a returned `Cost` used verbatim; `rateRef` on every priced tick and de-duplicated in the run's `rateRefs`; the stamp reaching `applyExecutorResult` and both tick events; an unpriced run rolling up `partial` rather than a zero `complete`; a mixed run whose `amountMicros` is only the priced subset; a run with no usage having no cost at all; a two-model run partitioning into two `byModel` keys whose usage sums to the flat total.
- `src/__tests__/define-loop.spec.ts` — the factory marker, callback delegation, default and custom abort routing, and envelopes reaching the supplied bus.
- `src/__tests__/telemetry-parity.spec.ts` — an interceptor on `loop:run-execution` emitting metrics that reach a late-bound meter with the ambient labels.
- Integration against the real compiler and executors (lifecycle projection, per-tick model resolution) and the end-to-end structured-output behaviour live in [@agentick/session](../session), where their dependencies live.
