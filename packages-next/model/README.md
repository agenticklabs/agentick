# @agentick/model-next

The **model layer** for Agentick v2 (ADR 52). Zero Effect, zero
substrate — everything between a provider SDK and the executor harness.

The split, in one analogy: **executor : adapter :: timeline : store.**
The executor (`@agentick/executor-next`) is the harness — orchestration,
streaming pipeline, backpressure, abort, observability. Provider
normalization is a plain Promise/AsyncIterable-shaped **part** this
package defines: `LanguageModelAdapter`.

## Quick Start

### Standalone — one model call, no framework

```ts
import { generate, generateStream } from "@agentick/model-next";
import { openai } from "@agentick/model-openai-next";

const result = await generate({
  model: openai("gpt-4o"),
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
});
// result: LanguageModelExecutionResult — output blocks, stopReason, usage

const handle = generateStream({ model: openai("gpt-4o"), messages });
for await (const delta of handle.stream) {
  if (delta.type === "content-delta") process.stdout.write(delta.delta);
}
const final = await handle.result;
```

`generate` / `generateStream` are normatively **single-shot**: one
provider call in, one normalized result out. Tool calls come back
unexecuted — looped execution belongs to the executor harness + session.

### In an app

```ts
const app = await createApp(<Agent />, { model: openai("gpt-4o") });
```

The app wraps the adapter in the ONE `LanguageModelExecutor` on its own
substrate — executor events flow through `app.events()` automatically.

## API

### `LanguageModelAdapter<TRaw, TChunk>`

The provider-normalization contract. Required members are the round
trip; optional members are provider quirks with executor-supplied
defaults.

| Member | Role |
| --- | --- |
| `provider`, `target` | Identity + self-described capabilities |
| `buildParams(input, target)` | Canonical input → provider request |
| `call(params, signal)` | Non-streaming SDK call |
| `openStream(params, signal)` | Streaming SDK call (Promise-wrapped OK) |
| `mapChunk(chunk, accum)` | Provider chunk → canonical `AdapterDelta[]` |
| `reconstructRaw(accum, modelSeen)` | Final stream state → canonical raw |
| `normalize(raw)` | Raw → `LanguageModelExecutionResult` |
| `project?`, `adapterTransforms?`, `postProcessForNormalize?`, `finalizeStream?`, `isAbortError?`, `mapProviderError?`, `extractMetadata?` | Optional quirk hooks |

**Currencies (the no-double-normalization guardrail):**
`LanguageModelInput`, `AdapterDelta`, and
`LanguageModelExecutionResult` are the ONLY shapes between adapter and
executor.

### Machinery

- `StreamAccumulator` / `StreamAccumulatorView` — the canonical delta
  fold. Adapters read accumulation state, may write `stopReason` /
  `usage` (late finalization) and own the `providerExtra` scratch slot.
- `defaultFinalizeStream(accum)` — the executor's end-of-stream
  finalization as an executable value; compose it when overriding
  `finalizeStream`.
- `DeltaTransform` + `composeTransforms` — stateful delta pipeline.
- `thinkTagTransform` / `customBlockTransform` / `StreamTagParser` —
  XML-tag routing (reasoning extraction, adopter custom blocks).
- `defaultProject` + parts (`buildTools`, `buildMessages`,
  `buildParameters`, …) — canonical RenderedTree projection.
- `isLanguageModelAdapter(value)` — structural guard used by app-level
  slots.

### Combinators

Adapters are plain values — resilience and routing compose:

```ts
model: withFallback(openai("gpt-5"), anthropic("claude-sonnet-5"))  // failover; never on abort
model: withRetry(openai("gpt-4o"), { attempts: 3 })                 // 429/5xx/network, jittered backoff
model: tapModel(adapter, { onCall, onResult, onDelta })             // observability; never alters behavior
```

Streaming semantics: retry/failover apply through the FIRST chunk (a
stream that has produced output is never replayed or switched). Each
fallback adapter builds its own params; the serving adapter's hooks
handle its own chunks/normalize.

## Provider packages

| Package | Factory |
| --- | --- |
| `@agentick/model-openai-next` | `openai(model?, options?)` |
| `@agentick/model-anthropic-next` | `anthropic(model?, options?)` |
| `@agentick/model-google-next` | `google(model?, options?)` |
| `@agentick/model-ai-sdk-next` | `aisdk(model, options?)` |

None of them depend on `@agentick/executor-next` (or Effect) at
runtime — an adapter is usable standalone via `generate()`.

## Verified by

- `src/__tests__/combinators.spec.ts` — retry/failover/tap semantics,
  first-chunk boundary, abort passthrough, composition.

- `src/__tests__/generate.spec.ts` — generate/generateStream fold,
  transform pipeline, synthetic message-start, error propagation.
- `src/__tests__/canonical-projection.spec.ts` — projection parts.
- `src/__tests__/stream-tag-parser.spec.ts` — tag routing.
- Each provider package's conformance suite runs the shared
  `runExecutorConformance` against `LanguageModelExecutor` + its
  adapter.

## Roadmap & known gaps

- `runModelAdapterConformance` — an adapter-level conformance suite
  (today certification happens via the executor conformance suite).
- Modalities beyond text (`embed`, `embedMany`, `transcribe`,
  `generateSpeech`, `generateImage`) as optional adapter capability
  groups (ADR 52 §modalities, #153).
