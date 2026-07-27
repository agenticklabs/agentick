# @agentick/model-executor

**There is exactly one model executor. A provider ships a dialect, not an executor.** `LanguageModelExecutor` owns every hard part of talking to a model — the Effect stream pipeline with bounded-queue backpressure, fiber-interrupt cancellation, in-flight tracking, journaling, the interceptor cascade — and consumes a `LanguageModelAdapter` that is plain Promise and `AsyncIterable` code.

The split is `executor : adapter :: timeline : store`. A new provider is roughly six functions with no Effect in them, and it inherits conformance, lifecycle hooks, admission guards, telemetry, last-mile request rewriting, and structured abort for free. There is no subclass tier and no callback factory to choose between, because there is nothing left to subclass.

## Install

```bash
npm install @agentick/model-executor
```

## Quick start

An adapter is an object. Here is a complete one — an echo provider — driven end to end:

```ts
import { LanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model";
import type {
  AdapterDelta,
  ExecuteInput,
  LanguageModelExecutionResult,
  LanguageModelInput,
  RenderedTree,
} from "@agentick/spec";
import { SPEC_VERSION } from "@agentick/spec";

interface EchoRequest {
  readonly prompt: string;
}
interface EchoResponse {
  readonly text: string;
}

const echo: LanguageModelAdapter<EchoResponse, string, EchoRequest> = {
  provider: "echo",
  target: { kind: "language-model", provider: "echo", modelId: "echo-v1" },
  streamByDefault: true,

  // Canonical projected input → the provider-native request. Pure.
  prepareRequest: (input: ExecuteInput<LanguageModelInput>): EchoRequest => ({
    prompt: input.targetInput.messages
      .flatMap((m) => m.content)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(" "),
  }),

  // Non-streaming call.
  send: async (request) => ({ text: request.prompt.toUpperCase() }),

  // Streaming call — whatever your SDK hands you.
  openStream: async function* (request) {
    for (const word of request.prompt.toUpperCase().split(" ")) yield `${word} `;
  },

  // Provider chunk → canonical deltas.
  mapChunk: (chunk: string, accum: StreamAccumulatorView): readonly AdapterDelta[] => [
    ...(accum.textByBlock.has(0)
      ? []
      : ([{ type: "content-start", blockIndex: 0, blockType: "text" }] as const)),
    { type: "content-delta", blockIndex: 0, delta: chunk },
  ],

  // End-of-stream state → the response shape `normalize` expects.
  reconstructRaw: (accum: StreamAccumulatorView): EchoResponse => ({ text: accum.totalText() }),

  // Provider response → the canonical result.
  normalize: (raw: EchoResponse): LanguageModelExecutionResult => ({
    specVersion: SPEC_VERSION,
    output: [{ type: "text", text: raw.text }],
    stopReason: "end",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }),
};

async function main(compiled: RenderedTree) {
  const exec = new LanguageModelExecutor<EchoResponse, string>(
    "model:echo",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    { adapter: echo },
  );
  await exec.ready;

  const terminal = await exec.run({ compiled, target: exec.target, tools: [] });
  if (terminal.outcome === "succeeded") console.log(terminal.result.output);

  await exec.close();
}
```

Nothing about that object is special-cased. `defineLanguageModelAdapter` in [@agentick/model](../model) is sugar for filling in derivable defaults; a plain object satisfying the interface works identically.

Most apps never construct the executor at all — `createApp({ model: openai("gpt-4o") })` wraps the adapter on the app's substrate. Reach for this package when you need the executor itself: a standalone instance, a test, or an interceptor on the provider call.

## Streaming

`executeStream` returns an `ExecutorStream<TRaw>` — the streaming dual of a `Promise`. Iterate deltas as the provider emits them, `await .result` for the assembled raw output, `abort()` to cancel:

```ts
import type { LanguageModelExecutor } from "@agentick/model-executor";
import type { ExecuteInput, LanguageModelInput } from "@agentick/spec";

declare const exec: LanguageModelExecutor;
declare const input: ExecuteInput<LanguageModelInput>;

const stream = exec.executeStream(input);

for await (const delta of stream) {
  if (delta.type === "content-delta") process.stdout.write(delta.delta);
}

const raw = await stream.result; // reconstructed by the adapter from final stream state
```

The queue behind that iterator is bounded, and `Queue.offer` blocking at capacity is what propagates real backpressure up through `Effect.Stream` into the provider SDK's own iterator. A slow consumer paces the producer rather than buffering the whole generation.

Breaking out of the `for await` calls the iterator's `return()`, which interrupts the producer fiber and tears the provider stream down with it.

## The `.fx` twins

Every operation has a Promise facade and an Effect-native twin. The facade is exactly the twin plus a terminal `runPromise`; neither is second-class. The loop composes the twins so an entire execution is one fiber, which is what makes spans nest and interruption propagate:

```ts
import { Effect } from "effect";
import type { AdapterDelta, ExecutionTarget, RenderedTree } from "@agentick/spec";
import type { LanguageModelExecutor } from "@agentick/model-executor";

declare const exec: LanguageModelExecutor;
declare const compiled: RenderedTree;
declare const target: ExecutionTarget;

const result = await Effect.runPromise(
  Effect.gen(function* () {
    const deltas: AdapterDelta[] = [];
    const projected = yield* exec.fx.project({ compiled, target, tools: [] });
    // The streaming twin is a SINK FOLD — no queue, no fork, same fiber.
    const raw = yield* exec.fx.executeStream({ targetInput: projected, target }, (delta) =>
      Effect.sync(() => deltas.push(delta)),
    );
    return yield* exec.fx.normalize({ targetOutput: raw, target });
  }),
);

result.output;
```

`fx.run` is the non-streaming equivalent of that whole block: project → generate → normalize, one span per tick.

## The provider call is a command

`execute()` is the `model:generate` command; `executeStream()` is the `model:generate_stream` streaming command. Declaring them mints the full operation machinery on the model call itself:

```ts
import type { LanguageModelExecutor } from "@agentick/model-executor";

declare const exec: LanguageModelExecutor;

const offHooks = exec.hook({
  onBeforeModelGenerate: (input) => {
    console.log(`calling ${input.target.modelId}`);
  },
  onAfterModelGenerate: (raw) => {
    console.log("raw provider response", raw);
  },
});

// Admission: deny before any provider I/O happens.
const offGuard = exec.guard({
  modelGenerate: (input) =>
    input.targetInput.messages.length > 200 ? { kind: "veto", reason: "too long" } : undefined,
});

offHooks();
offGuard();
```

A veto rejects `execute()` outright. On `run()` it folds into a `vetoed` **terminal** instead, because `run`'s contract is to return a terminal rather than throw — the loop pattern-matches the non-success outcome and stops.

| Verb                     | Hooks                                                                                          | Guard key              |
| ------------------------ | ---------------------------------------------------------------------------------------------- | ---------------------- |
| `model:project`          | `onBeforeModelProject` · `onAfterModelProject`                                                 | `modelProject`         |
| `model:generate`         | `onBeforeModelGenerate` · `onAfterModelGenerate`                                               | `modelGenerate`        |
| `model:generate_stream`  | `onBeforeModelGenerateStream` · `onAfterModelGenerateStream` · `onModelGenerateStreamChunk`    | `modelGenerateStream`  |
| `model:provider-request` | `onBeforeModelProviderRequest` · `onAfterModelProviderRequest` · `onModelProviderRequestChunk` | `modelProviderRequest` |
| `model:normalize`        | `onBeforeModelNormalize` · `onAfterModelNormalize`                                             | `modelNormalize`       |
| `model:run`              | `onBeforeModelRun` · `onAfterModelRun`                                                         | `modelRun`             |

Lifecycle envelopes carry `model:command:*` names on the `model` surface and are journaled like every other operation.

> [!NOTE]
> `run` inlines project and generate beneath its own operation, so their hooks do **not** re-fire per tick. Drive the direct facades (`project()`, `execute()`) when you want those. On the streaming path the loop fires `model:generate_stream` with `project` and `normalize` bracketing it as their own operations.

### Last-mile request rewriting

The SDK round trip is its own nested command, `model:provider-request`, whose input is the **provider-native** request `prepareRequest` produced. That is the hook point for anything the canonical shape cannot express — a header, a beta flag, a provider-specific field:

```ts
import type { LanguageModelExecutor } from "@agentick/model-executor";

declare const exec: LanguageModelExecutor;

const off = exec.hook({
  // `request` is the SDK params object, not the canonical LanguageModelInput.
  onBeforeModelProviderRequest: (request) => ({
    ...(request as Record<string, unknown>),
    metadata: { tenant: "acme" },
  }),
  // `raw` is the untouched provider response, pre-normalize.
  onAfterModelProviderRequest: (raw) => {
    audit(raw);
  },
});

// And the raw provider chunks, BEFORE `mapChunk` turns them canonical.
const offChunks = exec.hooks.onModelProviderRequestChunk({
  observe: (chunk) => audit(chunk),
});

off();
offChunks();

declare function audit(x: unknown): void;
```

The transformed value is what actually reaches `send` / `openStream`. The nested operation journals with `parentOpId` pointing at the enclosing `model:generate`, so causality survives into the trace.

## Cancellation

`abort({ executionId })` fires the in-flight `AbortController`, which is merged with the caller's `signal` and with Effect's own fiber-interrupt signal into one signal the SDK sees. Aborting before a run starts short-circuits it: the next call with that id resolves a `canceled` terminal without touching the provider.

```ts
import type { LanguageModelExecutor } from "@agentick/model-executor";
import type { ExecuteInput, LanguageModelInput } from "@agentick/spec";

declare const exec: LanguageModelExecutor;
declare const input: ExecuteInput<LanguageModelInput>;

const executionId = "exec-1";
const stream = exec.executeStream({ ...input, scope: { executionId } });

setTimeout(() => void exec.abort({ executionId, reason: "user-stop" }), 100);

for await (const delta of stream) void delta; // completes cleanly, does not throw
```

> [!IMPORTANT]
> Cancellation and failure are different shapes at the iterator. An abort **completes** the iterator cleanly — cancellation is an outcome, not an error. A genuine provider failure **throws** the typed error from the iterator, and `.result` rejects with the same one (`StreamFailed`, `ProviderRejected`, or whatever the adapter's `mapProviderError` produced). Do not model one as the other.

Provider errors are mapped before they escape: an abort-shaped error becomes `ProviderAborted`, anything carrying a numeric `status` becomes `ProviderRejected`, and the rest becomes `StreamFailed`. Override `mapProviderError` on the adapter when your SDK surfaces something richer.

## `FakeLanguageModelExecutor`

A working, scripted implementation of the same protocol with no wire underneath. It mints the same commands as the real executor, so it passes the same conformance suite — which is the point: tests exercise the real cascade, not a mock of it.

```ts
import { FakeLanguageModelExecutor } from "@agentick/model-executor";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { SPEC_VERSION } from "@agentick/spec";
import type { RenderedTree } from "@agentick/spec";

async function twoTicks(compiled: RenderedTree) {
  const model = new FakeLanguageModelExecutor(
    "model:fake",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      // One entry per call, consumed in order; the last one repeats.
      scripted: [
        {
          result: {
            specVersion: SPEC_VERSION,
            output: [{ type: "text", text: "checking" }],
            stopReason: "tool_use",
            usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
            toolCalls: [{ id: "call-1", name: "search", input: { q: "agentick" } }],
          },
        },
        {
          result: {
            specVersion: SPEC_VERSION,
            output: [{ type: "text", text: "found it" }],
            stopReason: "end",
            usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 },
          },
        },
      ],
    },
  );
  await model.ready;

  await model.run({ compiled, target: model.target, tools: [] });
  await model.run({ compiled, target: model.target, tools: [] });

  // Every non-streaming run's input, in call order — assert on what the
  // projection actually saw.
  model.seenRuns[0]?.tools;
  model.seenRuns[1]?.compiled.config?.toolChoice;
}
```

| Scripting knob | Effect                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `result`       | The `LanguageModelExecutionResult` this call returns                                                          |
| `deltas`       | Explicit `AdapterDelta` sequence for the streaming path; omitted, a sensible one is synthesized from `result` |
| `outcome`      | `"failed"` / `"vetoed"` / `"canceled"` — drive a consumer's failure paths without a bespoke stub              |
| `holdUntil`    | Park the run on a promise; the timing knob for race tests (mid-run abort, concurrent send)                    |
| `target`       | Override the self-described target (constructor option, not per run)                                          |

`seenRuns` records the non-streaming path only — the streaming path goes through `executeStream`, not `run`, and leaves it empty.

## API

### `@agentick/model-executor`

| Export                                                 | Purpose                                                                     |
| ------------------------------------------------------ | --------------------------------------------------------------------------- |
| `LanguageModelExecutor<TRaw, TChunk>`                  | The executor. `(scopeId, journal, bus, inbox, { adapter })`                 |
| `FakeLanguageModelExecutor`                            | Scripted working implementation of the same protocol                        |
| `ExecutorLifecycle`                                    | In-flight and aborted bookkeeping, shared by both                           |
| `mergeSignals(caller, internal)`                       | Compose two `AbortSignal`s into one that fires on either                    |
| `LanguageModelExecutorOptions`                         | Construction options: `adapter`, inherited interceptors, interceptor parent |
| `FakeLanguageModelExecutorOptions` / `MockScriptedRun` | The scripting shapes                                                        |

### The instance

| Member                                          | Returns                                                              |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `run(input)`                                    | `Promise<ExecutorTerminal<LanguageModelExecutionResult>>`            |
| `project(input)`                                | `Promise<LanguageModelInput>` — the canonical fold                   |
| `execute(input)`                                | `Promise<unknown>` — the raw provider response                       |
| `executeStream(input)`                          | `ExecutorStream<TRaw>` — `AsyncIterable` plus `.result` / `.abort()` |
| `normalize(input)`                              | `Promise<LanguageModelExecutionResult>`                              |
| `abort({ executionId, reason? })`               | Cancels in-flight work for that id                                   |
| `fx.{ run, project, normalize, executeStream }` | Un-run `Effect`s; `executeStream` takes a delta sink                 |
| `target`                                        | The adapter's self-described `ExecutionTarget`                       |
| `hook` / `hooks` / `guard` / `use`              | The interceptor surface every operation rides                        |
| `ready` / `close()`                             | Substrate lifecycle                                                  |

Adapter hooks that override executor defaults: `project`, `adapterTransforms`, `customBlocks`, `postProcessForNormalize`, `extractMetadata`, `finalizeStream`, `isAbortError`, `mapProviderError`. The defaults themselves are executable values in [@agentick/model](../model) (`defaultProject`, `defaultFinalizeStream`).

## Patterns

**Adapters.** [@agentick/model](../model) owns the `LanguageModelAdapter` contract, the delta accumulator, the transform pipeline, the canonical projection, and the standalone `generate()` helpers — zero Effect, usable with no executor at all. Shipped adapters: [@agentick/model-openai](../model-openai), [@agentick/model-anthropic](../model-anthropic), [@agentick/model-google](../model-google), [@agentick/model-ai-sdk](../model-ai-sdk). None of them depends on this package.

**Who drives it.** [@agentick/loop-executor](../loop-executor) makes the per-tick call, composing `fx.run` on the non-streaming path or `fx.project → fx.executeStream → fx.normalize` on the streaming one. [@agentick/app](../app) wraps an adapter passed on the `model` slot into one executor on the app substrate.

**Shapes.** [@agentick/spec](../spec) owns `ExecutorProtocol`, `LanguageModelExecutor`, `ExecuteInput`, `RunInput`, `AdapterDelta`, `ExecutorTerminal`, and the typed error classes.

**Certifying an adapter.** `runExecutorConformance` in [@agentick/spec-conformance](../spec-conformance) runs the whole protocol contract, including the command-ified model call. Every provider package re-runs it against its own adapter.

## Roadmap & known gaps

- **Inbox dispatch is not wired.** `model:generate` and `model:generate_stream` are declared addressable, so `BaseHarness` will route a matching inbox message to them, but nothing exercises that path and the non-command fallthrough (`handleMessage`) rejects with `HandlerError`.
- **Bus delta emission is asserted loosely.** The streaming pipeline's `model` / `delta` envelopes are covered by the conformance suite and the scripted double; the real executor's own bus test only asserts the pipeline survives a concurrent subscriber, because the timing is flaky.
- **The stream queue capacity is fixed at 64 deltas** for the `.stream` facade. There is no adopter knob.
- **`streamByDefault` is set by fixtures but never asserted.** The flag makes `execute()` drive the streaming provider call internally so bus-level deltas still flow; no test in this package pins that behaviour on its own.
- **No cost or pricing concern lives here.** `estimateCost` and the pricing tables are in [@agentick/model](../model); the executor only reports `usage` as the adapter normalized it.

## Verified by

- `src/__tests__/language-model-executor-conformance.spec.ts` — `runExecutorConformance` against the real executor with a synthetic adapter. The suite includes the command block: `model:generate` mints and fires its hooks, a guard veto rejects `execute()` and folds to a `vetoed` terminal on `run()`, the streaming command fires `onAfterModelGenerateStream` at its terminal, and every envelope carries a `model:*` operation name.
- `src/__tests__/base-effect-stream.spec.ts` — delta ordering through the pipeline, synthetic message-start and finalize gap-filling, bounded-queue backpressure under a slow consumer, `abort()` interrupting the stream fiber, iterator `return()` interrupting the producer, a provider failure settling (not hanging) with the typed error on both the iterator and `.result`, and the per-chunk interceptor observing and transforming what the iterator sees.
- `src/__tests__/provider-request.spec.ts` — `onBeforeModelProviderRequest` seeing the native request and a transform on it reaching the SDK; `onAfterModelProviderRequest` seeing the raw response; `onModelProviderRequestChunk` seeing raw chunks pre-`mapChunk`; `parentOpId` threading from generate to provider-request in the journal; a mid-stream abort firing no bogus `onAfter`; a plain-object adapter working with no factory; and the scripted double minting the identical command.
- `src/__tests__/fx-run.spec.ts` + `fx-stream.spec.ts` — the twins are un-run `Effect`s, the Promise methods are their facades, both produce identical output, and `project → executeStream → normalize` composes in one `Effect.gen`.
- `src/__tests__/command-hooks.spec.ts` — `onBeforeModelProject` and `onBeforeModelGenerate` firing on the direct facades; `onAfterModelProject` seeing the projected input.
- `src/__tests__/fake-language-model-executor.spec.ts` + `conformance.spec.ts` — the scripted double's projection (section fold into a system message, tool filtering by `model` exposure), one bus delta per scripted chunk, the lazy path skipping envelope construction with no subscriber, pre-abort short-circuit to `canceled`, journaled `requested` and `terminal` envelopes, and the same protocol conformance as the real executor.
- `src/__tests__/telemetry-parity.spec.ts` — an interceptor on `model:generate` emitting metrics that reach a late-bound meter carrying the ambient labels.
