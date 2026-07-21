# @agentick/model-executor-next

THE executor harness for Agentick v2 (ADR 52). One final
`LanguageModelExecutor` — `BaseHarness<"model">` plus the entire
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
`modelExecutor:` slot and the app wraps it on its own substrate:

```ts
const app = await createApp(<Agent />, { model: openai("gpt-4o") });
```

Hand construction (tests, standalone harness use):

```ts
import { LanguageModelExecutor } from "@agentick/model-executor-next";
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

## The model call is a command (ADR 89 §1)

The provider call is command-ified: `execute()` is the **`model:generate`**
command (declared via `this.command`), and `executeStream()` is the
**`model:generate_stream`** streaming command (declared via
`this.commandStream`). Declaring them mints the full command machinery on the
model call:

- **Lifecycle hooks** — `onBefore/AfterModelGenerate` and
  `onBefore/AfterModelGenerateStream` on the derived `CommandHooks` surface
  (register via `exec.hook({ onBeforeModelGenerate })` or the `exec.hooks.*`
  proxy). The `onBefore` half reshapes the `ExecuteInput`; the `onAfter` half
  reshapes the returned raw.
- **`guardGenerate`** — a `exec.guard((input, ctx) => …)` verdict gates the
  model call (`proceed` / `veto` / `replace` / `defer`), composed outermost so
  it denies before any provider I/O. For the streaming command the veto lands
  before the first chunk.
- **Journaling + the phase contract** — `model:command:generate[_stream]`
  emits `requested` → `before` → `delta*` → `terminal` envelopes (surface
  `model`) and is idempotency/journal-backed like every other command.
- **Inbox-addressability** — `model:generate[_stream]` is reachable as an inbox
  verb; the streaming command's inbox `run` drains to the final raw.

The streaming command exposes the standard three consumption faces
(`StreamCommand`): `.stream` (the `ExecutorStream` facade), `.fx` (the sink-fold
twin the loop consumes — so the loop's per-tick model call rides the same
cascade + hooks + guard), and `.run` (the inbox drain). The remaining verbs —
`project` / `normalize` / `run` — stay plain `runOperation` operations under the
`model:*` surface (`model:command:project` / `…:normalize` / `…:run`); `run` is
the one op a loop tick fires on the non-streaming path (project/generate inline
beneath it — one span per tick).

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
- `src/__tests__/command-hooks.spec.ts` — the model verbs mint
  `onBefore/AfterModel*` hooks that fire on the direct facades.
- The `runExecutorConformance` "command-ified model call (ADR 89 §1)"
  block (in `@agentick/spec-conformance-next`) — asserts `model:generate`
  mints + fires its hooks, `guardGenerate` vetoes, the streaming command fires
  `onAfterModelGenerateStream` at the terminal, and no `executor:*` op surface
  survives. Run against BOTH the real executor and the fake.
- `src/__tests__/fake-language-model-executor.spec.ts` +
  `conformance.spec.ts` — the scripted double satisfies the same
  protocol.
- Every provider package re-runs the conformance suite against its own
  adapter.
