# @agentick/executor-next

THE executor harness for Agentick v2 (ADR 52). One final
`LanguageModelExecutor` — `BaseHarness<"executor">` plus the entire
Effect execution engine — consuming a `LanguageModelAdapter` part from
[`@agentick/model-next`](../model/README.md).

There is no subclass tier and no callback factory: providers ship
**adapters** (`openai(...)`, `anthropic(...)`, `google(...)`,
`aisdk(...)`), not executor classes. The split:

> executor : adapter :: timeline : store

The executor owns everything Effect — the streaming pipeline
(Effect.Stream + bounded-queue backpressure), fiber-interrupt
cancellation, in-flight tracking, abort, operation journaling, and
delta emission on the bus. The adapter owns exactly the provider
dialect, as plain Promise/AsyncIterable-shaped hooks.

## Quick Start

Most apps never construct this class — pass an adapter to the app's
`executor:` slot and the app wraps it on its own substrate:

```ts
const app = await createApp(<Agent />, { model: openai("gpt-4o") });
```

Hand construction (tests, standalone harness use):

```ts
import { LanguageModelExecutor } from "@agentick/executor-next";
import { openai } from "@agentick/model-openai-next";

const exec = new LanguageModelExecutor("my-exec", journal, bus, inbox, {
  adapter: openai("gpt-4o", { parseThinkTags: true }),
});
await exec.ready;
const terminal = await exec.run({ compiled, target, tools: [] });
```

## The `.fx` edge + streaming (ADR 77)

The executor exposes the dual-typed edge: a Promise facade AND an
Effect-native `.fx` twin for each operation. The loop composes the twins so
the whole execution is ONE fiber (telemetry nests, interruption propagates):

```ts
// Promise facade — await it:
const terminal = await exec.run(input);

// `.fx` twin — compose in your Effect.gen:
const terminal = yield * exec.fx.run(input);
const projected = yield * exec.fx.project(input); // + normalize, executeStream
```

`executeStream` returns an **`ExecutorStream<TRaw>`** — an
`AsyncStream<AdapterDelta, TRaw>` (the streaming dual of `Promise`): iterate
deltas as the provider emits them, `await .result` for the final raw output,
`abort()` to cancel:

```ts
const stream = exec.executeStream(input);
for await (const delta of stream) {
  /* content-delta tokens, tool-call deltas, message-end, … */
}
const raw = await stream.result; // final accumulated output
```

Its `.fx` twin is the **sink-fold** `executeStream(input, sink): Effect<TRaw>`
— the loop composes it with no queue (`yield* exec.fx.executeStream(input, (d)
=> Effect.sync(() => emit(d)))`); the Queue/backpressure machinery lives in the
facade's `runHarnessStream` bridge. Cancellation is real Effect fiber
interruption of the provider call (via `withExternalAbort` + the `tryPromise`
fiber signal), driven by `input.signal` — which the loop wires to
`loop.abort()` / execution timeout.

## API

- `LanguageModelExecutor<TRaw, TChunk>` — the harness. Protocol surface
  per `@agentick/spec-next`: `project` / `execute` / `executeStream` /
  `normalize` / `run` / `abort` (Promise facades) + `fx.{run, project,
normalize, executeStream}` (Effect twins), plus the self-described
  `target` delegated from the adapter.
- `FakeLanguageModelExecutor` — scripted double (no wire) for tests,
  examples, and the substrate proof.
- `ExecutorLifecycle` — in-flight entry tracking shared by both.

Optional adapter hooks (`project`, `adapterTransforms`,
`postProcessForNormalize`, `finalizeStream`, `isAbortError`,
`mapProviderError`) override the executor's defaults; the defaults
themselves live in `@agentick/model-next` as executable values
(`defaultProject`, `defaultFinalizeStream`).

## Verified by

- `src/__tests__/language-model-executor-conformance.spec.ts` —
  `runExecutorConformance` against a synthetic scripted adapter.
- `src/__tests__/base-effect-stream.spec.ts` — streaming pipeline,
  backpressure, abort, transform composition.
- `src/__tests__/fake-language-model-executor.spec.ts` +
  `conformance.spec.ts` — the scripted double satisfies the same
  protocol.
- Every provider package re-runs the conformance suite against its own
  adapter.
