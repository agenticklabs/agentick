# @agentick/executor-next

Reference `LanguageModelExecutor` harness and tooling for the Agentick v2
substrate. Ships the abstract base class first-party provider adapters
extend, the callback-style factories for adopter integrations, the
streaming primitives (accumulator, delta-transform pipeline, tag
parser), and a scripted `Fake*` for tests.

The base class owns the entire streaming pipeline (Effect.Stream + bounded
queue backpressure + fiber-interrupt cancellation + transform composition

- bus emission); concrete provider executors write **pure callbacks**
  that produce per-chunk deltas and synthesize a final raw response.

## Quick Start

### Option 1 — class-based (full power)

For first-party provider adapters and advanced custom integrations.

```ts
import { BaseLanguageModelExecutor, type StreamAccumulator } from "@agentick/executor-next";
import type {
  AdapterDelta,
  ExecutionTarget,
  LanguageModelInput,
  LanguageModelExecutionResult,
} from "@agentick/spec-next";

interface MyChunk {
  /* SDK chunk */
}
interface MyRaw {
  /* SDK final response */
}

class MyExecutor extends BaseLanguageModelExecutor<MyRaw, MyChunk> {
  readonly target: ExecutionTarget = {
    kind: "language-model",
    provider: "my",
    modelId: "v1",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };

  protected override readonly streamByDefault = true;

  protected buildParams(input: LanguageModelInput) {
    return translateToMyApi(input);
  }

  protected callProvider(params: unknown, signal: AbortSignal | undefined) {
    return mySdk.complete(params, { signal });
  }

  protected openStream(params: unknown, signal: AbortSignal) {
    return mySdk.stream(params, { signal });
  }

  protected mapChunk(chunk: MyChunk, accum: StreamAccumulator): readonly AdapterDelta[] {
    /* pure chunk → delta translation; accum is read-only */
    return chunkToDeltas(chunk, accum);
  }

  protected reconstructRaw(accum: StreamAccumulator, modelSeen: string | undefined): MyRaw {
    /* assemble final raw response from accumulator state */
    return synthesizeMyRaw(accum, modelSeen);
  }

  protected normalizeRaw(raw: MyRaw): LanguageModelExecutionResult {
    return toExecutionResult(raw);
  }
}
```

### Option 2 — `defineLanguageModelExecutor` (callback wrapper)

Same hook surface, no subclassing. For adopters with streaming providers
who want zero boilerplate.

```ts
import { defineLanguageModelExecutor } from "@agentick/executor-next";

const myExec = defineLanguageModelExecutor<MyRaw, MyChunk>({
  target: { kind: "language-model", provider: "my", modelId: "v1" },
  streamByDefault: true,
  buildParams: (input) => translateToMyApi(input),
  callProvider: (params, signal) => mySdk.complete(params, { signal }),
  openStream: (params, signal) => mySdk.stream(params, { signal }),
  mapChunk: (chunk, accum) => chunkToDeltas(chunk, accum),
  reconstructRaw: (accum, modelSeen) => synthesizeMyRaw(accum, modelSeen),
  normalizeRaw: (raw) => toExecutionResult(raw),
});

const app = await createApp(<Agent />, { executor: myExec });
```

### Option 3 — `defineExecutor` (single callback)

For non-streaming providers or one-off integrations where the full hook
surface would be overkill. One async `run` callback that returns the
final `LanguageModelExecutionResult`.

```ts
import { defineExecutor } from "@agentick/executor-next";

const myExec = defineExecutor({
  target: { kind: "language-model", provider: "custom", modelId: "v1" },
  async run(input, ctx) {
    const response = await myProviderApi(input.messages, { signal: ctx.signal });
    return {
      specVersion: "2026-05-08",
      output: [{ type: "text", text: response.text }],
      stopReason: "end",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  },
});
```

## Hook contract — `BaseLanguageModelExecutor`

### Required hooks

| Hook                               | What it does                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `buildParams(input, target)`       | Translate canonical `LanguageModelInput` → provider request shape. Read `target.providerOptions` for per-provider knobs.   |
| `callProvider(params, signal)`     | Non-streaming provider call. Throws on error (base translates to `ProviderRejected` / `ProviderAborted` / `StreamFailed`). |
| `openStream(params, signal)`       | Open the SDK streaming response. Return the async iterable; base owns the loop.                                            |
| `mapChunk(chunk, accum)`           | Pure chunk → `AdapterDelta[]` translation. Read accumulator for derived state; do **not** mutate it.                       |
| `reconstructRaw(accum, modelSeen)` | Synthesize the canonical provider raw response from final accumulator state. Called once at end of stream.                 |
| `normalizeRaw(raw)`                | Convert raw provider response → `LanguageModelExecutionResult`. Throw to fail normalization.                               |

### Optional hooks

| Hook                           | Default                            | When to override                                                                                                                                                 |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projectImpl(input)`           | Canonical fold                     | Anthropic preserves `cache_control` per system section.                                                                                                          |
| `adapterTransforms()`          | `[]`                               | Return `[thinkTagTransform()]` for OpenAI-compatible servers (vLLM, LM Studio) that emit `<think>` tags inline.                                                  |
| `customBlocks`                 | `undefined`                        | Declarative adopter-facing custom XML-tag extraction (citations, semantic markers).                                                                              |
| `postProcessForNormalize(raw)` | identity                           | Apply tag routing to the **non-streaming** path (streaming path's `adapterTransforms` already extracted them).                                                   |
| `extractMetadata(raw)`         | `undefined`                        | Surface provider-specific fields (OpenAI `system_fingerprint`, Google `safetyRatings`, citations) into `result.finishMetadata` without rewriting `normalizeRaw`. |
| `finalizeStream(accum)`        | close blocks + emit summaries      | Provider needs a custom message-end shape (e.g. Google's `finishReasonRaw` → `stopReason` mapping).                                                              |
| `mapProviderError(cause)`      | abort + status code → typed        | Provider surfaces structured errors you can extract more detail from.                                                                                            |
| `isAbortError(cause)`          | `AbortError` + `APIUserAbortError` | SDK throws a non-standard abort error type.                                                                                                                      |

### Streaming pipeline

The base wires up the following pipeline inside `executeBody` (streaming
codepath):

```
openStream (Promise<AsyncIterable<TChunk>>)
  → Stream.fromAsyncIterable
  → Stream.mapConcat(mapChunk)                        // chunk → AdapterDelta[]
  → Stream.mapConcat(pipeline.process)                // adapterTransforms + customBlocks
  → ensureMessageStart                                // synthetic if no provider start
  → Stream.tap(accum.apply)                           // accumulator
  → Stream.tap(emitDeltaLazy)                         // bus envelope
  → Stream.tap(Queue.offer(boundedQueue, …))          // iterator backpressure (executeStream only)
  → Stream.runDrain
  → finalizeStream(accum)                             // close open blocks + message-end + message
  → reconstructRaw(accum, modelSeen) → TRaw
```

**Backpressure**: `Queue.bounded(64)` between the producer fiber and the
iterator means a slow consumer pauses the upstream stream (and through
that, the provider SDK's pull). No unbounded buffering.

**Cancellation**: `Effect.tryPromise({ try: (signal) => … })` provides
a fiber-aware `AbortSignal` to the provider SDK. Calling
`stream.abort(reason)` interrupts the fiber, which propagates as an
abort to the SDK promise. External caller signals merge via
`mergeSignals` so `app.run({ signal })` propagates too.

### `StreamAccumulator`

Centralized streaming-state aggregator. The base creates one per stream
and feeds it from every `AdapterDelta` flowing through the transform
pipeline (after `mapChunk` + `adapterTransforms` + `customBlocks`).

| Field                 | What it holds                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------- |
| `textByBlock`         | `Map<blockIndex, string>` — accumulated text per content block.                               |
| `reasoningByBlock`    | `Map<blockIndex, string>` — accumulated reasoning per block (think-tag / native CoT).         |
| `toolCalls`           | `Map<callId, AccumToolCall>` — per-call name + blockIndex + argsBuffer + input + metadata.    |
| `usage`               | `UsageStats` (last-write-wins; `usage` and `message-end` deltas both update).                 |
| `stopReason`          | `LanguageModelStopReason` (set by `message-end` delta).                                       |
| `modelSeen`           | Model id observed from `message-start` delta.                                                 |
| `openBlocks`          | `Map<blockIndex, "text"                                                                       | "reasoning">` — blocks awaiting close. |
| `highWaterBlockIndex` | Max block index seen (for providers without server-allocated indices).                        |
| `providerExtra`       | Provider-private slot. Stash SDK-specific state (`id`, `created`, etc.) for `reconstructRaw`. |

Helpers: `totalText()`, `totalReasoning()`, `toolCallInput(callId)`,
`toContentBlocks()`.

### Tag transforms

Two flavors, both built on `StreamTagParser`:

- **`thinkTagTransform()`** — extracts inline `<think>...</think>` from
  `content-delta` text and re-routes as `reasoning-*` deltas. For
  OpenAI-compatible servers that don't expose CoT via the standard
  `reasoning_content` field.

  ```ts
  protected override adapterTransforms() {
    return this.parseThinkTags ? [thinkTagTransform()] : [];
  }
  ```

- **`customBlockTransform(defs)`** — extracts adopter-declared XML
  tags from text and emits them as `custom-block-*` deltas. The base
  wires this automatically when the `customBlocks` field is non-empty.

  ```ts
  // Declarative — base compiles this into a transform.
  protected override readonly customBlocks = {
    citation: { onContent: (text, attrs) => persistCitation(text, attrs.source) },
  };
  ```

### Provider-specific state

When `mapChunk` needs to remember provider-specific fields (e.g.
OpenAI's `chunk.id` / `chunk.created`, Anthropic's per-block `cache_control`,
Google's `thoughtSignature`), stash them on `accum.providerExtra`:

```ts
interface MyState { id: string; finishReasonRaw: string | null; }

function getMyState(accum: StreamAccumulator): MyState {
  let s = accum.providerExtra as MyState | undefined;
  if (!s) {
    s = { id: "", finishReasonRaw: null };
    accum.providerExtra = s;
  }
  return s;
}

protected mapChunk(chunk, accum) {
  const state = getMyState(accum);
  if (chunk.id && !state.id) state.id = chunk.id;
  // … emit deltas …
}

protected reconstructRaw(accum, modelSeen) {
  const state = getMyState(accum);
  return { id: state.id, /* … */ };
}
```

The base never touches `providerExtra` — it's a typed escape hatch.

## Testing

### `FakeLanguageModelExecutor`

Scripted executor for tests, examples, and the v2 substrate proof.
Accepts a scripted `LanguageModelExecutionResult` (or sequence) plus
optional scripted streaming deltas; passes the full executor conformance
suite (15 contract tests).

```ts
import { FakeLanguageModelExecutor } from "@agentick/executor-next";

const fake = new FakeLanguageModelExecutor("test-1", journal, bus, inbox, {
  scripted: {
    result: {
      specVersion: "2026-05-08",
      output: [{ type: "text", text: "scripted reply" }],
      stopReason: "end",
      usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    },
  },
});
```

For multi-call test scenarios, pass an array:
`{ scripted: [run1, run2, run3] }`.

## Verified by

- `__tests__/conformance.spec.ts` — 15 spec-conformance contract tests
  (project / execute / executeStream / normalize / run / abort).
- `__tests__/base-effect-stream.spec.ts` — 5 Effect.Stream pipeline
  tests (routing order, bounded backpressure, abort, iterator return,
  bus emit).
- `__tests__/define-executor.spec.ts` — 8 callback-factory tests.
- `__tests__/define-language-model-executor.spec.ts` — 3 streaming
  callback-factory tests.
- `__tests__/fake-language-model-executor.spec.ts` — 6 scripted-fake
  behavior tests.
- `__tests__/stream-tag-parser.spec.ts` — 22 tag-parser unit tests.

Total: **59 tests passing**.

## Roadmap & known gaps

- **`extract `runtime-next`-internal scaffolding into a shared helper**
  — `FakeLanguageModelExecutor` and `CallbackLanguageModelExecutor`
  (the `defineExecutor` backend) still extend `BaseHarness<"executor">`
  directly and reimplement iterator-queue + sink + in-flight tracking.
  ~150 LOC duplicated; planned consolidation. Tracked as task #103.
- **Inbox dispatch on callback executors** — `defineExecutor` and
  `defineLanguageModelExecutor` reject inbox messages with
  `HandlerError`. Custom inbox handling requires the class-based
  subclass path.
- **`extractMetadata` parity with v1's `createAdapter`** — landed:
  optional `extractMetadata(raw)` hook on `BaseLanguageModelExecutor`
  (and the `defineLanguageModelExecutor` callback bundle). Base merges
  the returned record into `result.finishMetadata` post-normalize.
  Per-tool-call `providerMetadata` is preserved separately (Google's
  `thoughtSignature` use case).
