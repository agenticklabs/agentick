# @agentick/model-google

**The Gemini API as a plain object.** `google()` returns a `LanguageModelAdapter` — six functions and a handful of quirk hooks, zero Effect, zero substrate. The same value drives a full session through the model executor and answers a three-line `generate()` call with no framework in sight. Both serving paths are one option apart: the Gemini Developer API by key, or Vertex AI by project and location.

It is also the adapter that has to invent the most. Gemini's stream carries no block boundaries, its function declarations accept only a subset of JSON Schema, and its thinking signatures must round-trip or the next turn is rejected. Read this one to see what the port's optional hooks are actually for.

## Install

```bash
npm install @agentick/model-google
```

`@agentick/model` arrives with it (a dependency). Add it to your own
manifest only when you import from it directly — combinators, the model
registry, `defineLanguageModelAdapter`.

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { google } from "@agentick/model-google";

const app = await createApp(<Agent />, { model: google("gemini-2.5-flash") });
```

Vertex AI is the same call with a different client config:

```ts
const vertex = google("gemini-2.5-flash", {
  clientOptions: { vertexai: true, project: "my-project", location: "us-central1" },
});
```

Or drive it directly, no app:

```ts
import { generate } from "@agentick/model";
import { google } from "@agentick/model-google";

const result = await generate({
  model: google("gemini-2.5-flash"),
  messages: [{ role: "user", content: [{ type: "text", text: "Explain CRDT convergence." }] }],
});

result.output; // ContentBlock[]
result.usage; // UsageStats — thinking and cached tokens broken out
```

The SDK client is constructed lazily on first use, so declaring an adapter needs no credentials until a call actually happens. Env fallbacks: `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_GENAI_BASE_URL`. Inject `options.client` to bypass construction entirely.

## API

`google(model?, options?)` → `LanguageModelAdapter<GenerateContentResponse, GenerateContentResponse>`

| Option            | Purpose                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `clientOptions`   | Every field the SDK's `GoogleGenAI` constructor takes (apiKey, vertexai, project, location, googleAuthOptions, httpOptions, …). Ignored when `client` is set |
| `client`          | Inject a pre-built `GoogleGenAI` client — tests, custom auth                                                                                                 |
| `stream`          | Stream every execution. Per-call intent on the target still wins                                                                                             |
| `parseThinkTags`  | Route inline `<think>…</think>` to the reasoning channel — niche; native thought parts are better                                                            |
| `customBlocks`    | Adopter-declared XML-ish tags carved out of the text stream as `custom-block-*` deltas                                                                       |
| `target`          | Override the self-described `ExecutionTarget`                                                                                                                |
| `rates`           | A `RateCard` for this model. Lands on `target.rates`; applied over an explicit `target` too                                                                  |
| `providerOptions` | Provider knobs for every call. Lands on `target.providerOptions`; folded over an explicit `target`'s bag too                                                 |

Defaults with no `model` argument: `gemini-2.5-flash`.

### Rates

The framework ships **no prices**. Declare them where the model is declared and they ride the per-tick `<Model>` cascade for free:

```ts
const model = google("gemini-2.5-flash", {
  rates: {
    id: "google:gemini-2.5-flash@2026-07-01", // date it — a price change is a NEW card
    currency: "USD",
    perMTok: {
      input: 300_000, // micro-units per MILLION tokens: $0.30/MTok
      output: 2_500_000,
      cacheRead: 75_000,
    },
  },
});
```

Without a card the tick is _unpriced_, which is recorded as unpriced — never as zero. See [`docs/proposals/v2/usage-cost.md`](../../docs/proposals/v2/usage-cost.md).

## The Gemini dialect

**Schema sanitization.** Gemini's function declarations accept a strict JSON-Schema subset, so `sanitizeSchemaForGemini` recursively reduces a tool's input schema while preserving intent: `$ref` and `$defs` stripped, tuple `items` collapsed to the first item's schema, `anyOf` / `oneOf` entries containing refs filtered out (a single survivor is inlined, an all-ref union falls back to a bare object), `additionalProperties: false` retained and object-valued forms dropped. It is exported, because the same reduction is useful anywhere you hand Gemini a schema you didn't author.

**Thinking signatures round-trip.** Gemini 3 and later return an opaque `thoughtSignature` alongside a function call, and re-sending it on the following turn is mandatory — omit it and the call is rejected. The adapter captures the signature per tool call and replays it, so a multi-turn tool loop works without you touching it.

**Reasoning.** A text part with `thought === true` routes to the reasoning channel, which is how thinking models surface their scratchpad.

**Block boundaries are synthesized.** Gemini's chunks carry no start or stop markers, so the adapter opens and closes canonical blocks on content-kind transitions and composes the shared `defaultFinalizeStream` for the late stop-reason mapping — the finalization that closes open blocks, emits `message-end`, and rolls sources up onto the message summary.

**Usage, with thoughts folded into output.** `cachedContentTokenCount` surfaces as `usage.cachedInputTokens` and is already inside `promptTokenCount`, so input needs no folding. `thoughtsTokenCount` surfaces as `usage.reasoningTokens` **and** is added to `usage.outputTokens`, because Gemini reports `candidatesTokenCount` excluding thoughts while billing thinking at the output rate — and Anthropic and OpenAI both report reasoning inside their output counter. The canonical rule is `reasoningTokens ⊆ outputTokens`, so one adapter reporting them as peers would make "how many tokens did this generate" a question you can only answer by knowing which provider answered it. After the fold, `inputTokens + outputTokens` agrees with Gemini's own `totalTokenCount`, which counts thoughts too. A kind the response does not carry stays `undefined`; absent is not zero.

**Structured output.** The canonical `responseFormat` maps natively, so `generateObject` is a single call here rather than a prompt-and-hope.

## Multimodal

Gemini is natively multimodal, and the adapter projects `image`, `document`, `audio`, and `video` parts alike — the part type barely matters, the _source_ does:

| Source      | Native part                              |
| ----------- | ---------------------------------------- |
| `base64`    | `inlineData` — mimeType plus data        |
| `url`       | `fileData` with `fileUri` set to the URL |
| `reference` | **declined** — see below                 |

A `gs://` URI is just a `url` whose scheme is declared. The `gcs` MediaSource variant this used to require is gone — the adapter's `url` arm was already doing the work, and the framework was only recomposing `gs://${bucket}/${object}` on its behalf.

**But `gs:` is a VERTEX capability, not a Google one, and this adapter fronts both endpoints.** Vertex reads Cloud Storage natively, zero bytes moved; the Gemini / Agent Platform endpoint refuses a bucket URI outright:

```
Referencing Google Cloud Storage files directly is not supported.
Register them using FileService.RegisterFile first.
```

So the declaration is derived from the resolved client config rather than hardcoded — `isVertexConfig` reads the same signal the client is built from (`vertexai: true`, **or** `project` / `location` on their own), so the declaration cannot claim a capability the configured endpoint lacks.

Declared as `capabilities.media`, so the framework screens an unsupported source out _before_ this adapter is asked to project it:

```ts
media: {
  image: ["base64", "url"],
  document: ["base64", "url"],
  audio: ["base64", "url"],
  video: ["base64", "url"],
  // `gs:` ONLY when the client is configured for Vertex.
  urlSchemes: onVertex
    ? ["https", "http", "data", "gs"]
    : ["https", "http", "data"],
}
```

On the API-key endpoint a `gs://` source is therefore **declined with a stated reason** rather than 400-ing the whole request — and a decline is the signal to resolve it first. `ai.files.registerFiles({ uris })` takes the bucket URI itself and returns a handle, so registration moves no bytes either; the returned `File` carries an `expirationTime`, which is what a caching layer needs to know when to re-register.

> [!IMPORTANT]
> A `reference` source is **declined**, not forwarded. Its `fileId` lives in the adopter's namespace and Gemini's `fileUri` accepts only a `gs://` URI or one of its own Files API URIs — so this adapter used to emit the bare id and earn, every single time:
>
> ```
> Unable to submit request because the fileUri parameter must be a Cloud Storage or
> HTTP(S) URI but the entered value was '019faa2c-5506-7000-b8ea-3c63628e4c89'
> ```
>
> A deterministic rejection against a durable timeline entry, so every later turn resent it and failed identically — **one attachment made a conversation permanently unusable.** Resolve a `reference` to a `url` or `base64` source in an `onModelGenerate` hook (that seam runs _before_ the screen, precisely so it gets its chance). On **Vertex**, hand over the `gs://` URI itself — read natively, zero bytes moved. On the **API-key** endpoint, register it first and hand over the resulting file URI, or inline the bytes.

A replayed `reasoning` part is **dropped rather than flattened**, because Gemini round-trips thinking through the `thoughtSignature` on the function-call part, not through a replayed reasoning block. That drop is silent today and pinned by `src/__tests__/silent-drops.spec.ts` so a fix cannot land unnoticed.

## Provider knobs

Four channels, each typed by this package augmenting the shared provider namespaces, so `providerOptions.google` is the shape you would write against the SDK directly:

| Channel                           | Reaches                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `ProviderClientOptions["google"]` | The SDK client, via `clientOptions`                                                    |
| `ProviderOptions["google"]`       | The `GenerateContentConfig` — thinking config, `safetySettings`, seed, `cachedContent` |
| `ProviderToolOptions["google"]`   | One function declaration, overriding what the projection produced                      |
| `providerMetadata.google`         | What came **back**, per content block — including the `thoughtSignature`               |

The direction split is the rule: `providerOptions` is what you send, `providerMetadata` is what returned. That is precisely how the signature replay works — a returned signature lands on the block's `providerMetadata`, and projection maps it back onto the outgoing part's `providerOptions`. Bags fold through `mergeProviderOptions` with the rendered tree winning over the target.

> [!WARNING]
> Don't set `systemInstruction`, `tools`, or `abortSignal` through `providerOptions`. Those are the adapter's to own.

### Where to set them

Turning on thinking is one option on the factory — it does not cost you a restated `ExecutionTarget`:

```ts
const model = google("gemini-2.5-pro", {
  providerOptions: { google: { thinkingConfig: { thinkingBudget: 8192 } } },
});
```

That bag lands on the adapter's own `target.providerOptions`, which is what the app and the per-tick `<Model>` cascade hand the executor, so it applies to every call — streaming and not — and rides a per-tick model swap with no extra plumbing.

Three layers can set the same namespace, most specific winning:

| Layer                                                        | Wins over        |
| ------------------------------------------------------------ | ---------------- |
| `<model providerOptions={…}>` in the tree — this render only | everything below |
| `google(model, { providerOptions })` — this adapter          | the target's bag |
| `google(model, { target })` — the target you declared        | —                |

The fold is `mergeProviderOptions`: per provider namespace, one level deep, the more specific bag winning key by key. A tree-level `{ google: { seed } }` therefore overrides the factory's `seed` and leaves its `thinkingConfig` alone — but a tree-level `thinkingConfig` **replaces** the factory's whole object rather than merging into it. The bag is opaque: nothing in it is read or validated, it is spread onto the request last.

A per-call `SendInput.target` is the exception — it replaces the target outright, bag included, because it replaces the whole target.

### Prompt caching is a deliberate no-op here

The canonical `CacheHint` is **intentionally not translated** for Gemini, because neither of Gemini's two caching modes wants it. Implicit caching on 2.5 models is automatic — nothing to translate. Explicit caching needs a pre-created `CachedContent` **resource name**, which a `{ ttl, scope }` hint cannot synthesize out of thin air.

So the hint's text still projects into `systemInstruction`, only its untranslatable metadata is dropped, and adopters wiring explicit caching pass the resource through the escape hatch:

```ts
providerOptions: {
  google: {
    cachedContent: "projects/p/locations/us/cachedContents/123";
  }
}
```

## Provider-executed tools

Gemini's grounding tools are keyed objects rather than typed entries, and each is a **distinct** `Tool` in the config array riding alongside the single function-declaration `Tool`. The adapter maps each entry from the `provider === "google"` slice of `providerTools` to `{ [type]: config ?? {} }` verbatim:

```ts
providerTools: [
  { provider: "google", type: "googleSearch" },
  { provider: "google", type: "codeExecution" },
];
```

Coming back, grounding is response **metadata**, not a tool result: grounding supports anchor spans of the assistant's text to web chunks. Each support becomes one `Citation` per cited chunk — so every source keeps its own confidence score — attached to the annotated text block by part index, carrying the URL, title, cited text, span, and confidence.

> [!NOTE]
> There is deliberately **no `executedBy` stamp** for grounding. It is metadata, not a `tool_result`, and pretending otherwise would fabricate an execution event that never happened. That is the honest shape of Gemini grounding rather than a gap. Code-execution provenance, which genuinely _would_ be a provider tool result, is not mapped yet.

## Implementing your own

The port is `LanguageModelAdapter`, and `defineLanguageModelAdapter` is how you build one. Six members are the whole round trip; everything else is an optional hook with a supplied default.

| Member                                                                                                    | Required | Role                                                              |
| --------------------------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| `provider`, `target`                                                                                      | yes      | Identity and self-described capabilities                          |
| `prepareRequest(input)`                                                                                   | yes      | Canonical input → the **provider-native** request object. Pure    |
| `send(request, signal)`                                                                                   | yes      | The non-streaming SDK call                                        |
| `mapChunk(chunk, accum)`                                                                                  | yes      | One provider chunk → canonical `AdapterDelta[]`                   |
| `reconstructRaw(accum, modelSeen)`                                                                        | yes      | Final stream state → the provider's own raw response shape        |
| `normalize(raw)`                                                                                          | yes      | Raw → `LanguageModelExecutionResult`                              |
| `openStream(request, signal)`                                                                             | no       | The streaming call. Omit it to declare no streaming surface       |
| `finalizeStream(accum)`                                                                                   | no       | End-of-stream deltas — **composed** by this adapter, not replaced |
| `project(input)`                                                                                          | no       | Replace the canonical projection — not used by this adapter       |
| `adapterTransforms` / `postProcessForNormalize` / `extractMetadata` / `isAbortError` / `mapProviderError` | no       | Other provider quirks, each with a default                        |

Three lessons this adapter teaches better than the others:

**Compose the defaults, don't re-roll them.** `defaultFinalizeStream` is exported as a value precisely so an override can set what it learned late and then delegate:

```ts
import { defaultFinalizeStream, type StreamAccumulatorView } from "@agentick/model";
import type { AdapterDelta } from "@agentick/spec";

function finalizeStream(accum: StreamAccumulatorView): readonly AdapterDelta[] {
  accum.stopReason = "max_tokens"; // a trailer the provider only sends at the end
  return defaultFinalizeStream(accum);
}
```

Re-implementing it means re-implementing block closing, tool-call closing, `message-end`, and the source roll-up — and getting one of them subtly wrong.

**Synthesize what the provider omits.** A stream with no block boundaries is still expected to produce the canonical `content-start` / `content-delta` / `content-end` vocabulary, because everything downstream — the executor's delta envelopes, a client's rendering — is written against that vocabulary and not against Gemini's. Deriving boundaries from content-kind transitions in `mapChunk` is the adapter's job, not the consumer's.

**A provider's schema subset is a translation, not a rejection.** Reducing a schema is friendlier than refusing a tool, as long as the reduction preserves intent and is exported so an adopter can see and reuse it.

Provider-private streaming state goes on `accum.providerExtra`, a scratch slot nothing else touches; `mapChunk` stays pure and derives open-block state from the accumulator, so one adapter instance serves concurrent executions.

### Certify it

There is no standalone adapter conformance suite yet. Adapters are certified by running the executor's suite against the real executor plus your adapter plus a **stubbed SDK client** — which is what `options.client` is for:

```ts
import { runExecutorConformance } from "@agentick/spec-conformance";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { LanguageModelExecutor } from "@agentick/model-executor";
import { google } from "@agentick/model-google";

runExecutorConformance(
  async ({ harnessId, scripted, throws }) => {
    const bus = new LocalEventBus();
    const client = throws !== undefined ? throwingClient(throws) : stubClientFor(scripted);
    const executor = new LanguageModelExecutor(
      harnessId,
      new MemoryJournal(),
      bus,
      new LocalInbox(),
      { adapter: google("gemini-2.5-flash", { client }) },
    );
    await executor.ready;
    return { executor, bus };
  },
  {
    ProviderRejected: [
      new Error('{"error":{"code":400,"message":"…","status":"INVALID_ARGUMENT"}}'),
    ],
    ProviderAborted: [new DOMException("This operation was aborted", "AbortError")],
    StreamFailed: [new Error("socket hang up")],
    // Gemini reports a malformed tool call as a FINISH REASON, not a throw.
    MalformedModelOutput: "not-applicable",
    ProviderTimeout: "not-applicable",
  },
);
```

`stubClientFor` is yours to write: it returns canned SDK payloads shaped so they normalize back to what the suite scripted, which means the round trip through `prepareRequest → send → normalize` is what is actually under test rather than a mock of your own code. Write the dialect tests the same way — assert against the request the stub _received_, and against the canonical result your `normalize` produced.

The second argument is required and total over `ExecuteError["_tag"]`: for each failure class, provider-native errors your classification must resolve to it, or `"not-applicable"` when nothing does. The suite throws each fixture from the client on BOTH seams — `execute()` and `executeStream()` — and asserts the tag on the executor's own rejection each time — so a class added to the taxonomy breaks this file at compile time until you decide.

## Patterns

**The contract and the helpers.** [@agentick/model](../model) owns `LanguageModelAdapter`, `defineLanguageModelAdapter`, `defaultFinalizeStream`, the canonical projection and its parts, the streaming accumulator, `generate` / `generateStream` / `generateObject`, the `withRetry` / `withFallback` / `tapModel` combinators, and the model registry that prices a call.

**Running inside an app.** [@agentick/model-executor](../model-executor) wraps an adapter with orchestration, abort, backpressure, the request-interception command path, and bus-level delta envelopes.

**Sibling providers.** [@agentick/model-anthropic](../model-anthropic), [@agentick/model-openai](../model-openai), [@agentick/model-ai-sdk](../model-ai-sdk). Compose across them with `withFallback` — each adapter runs its own `prepareRequest`, because native requests are not portable.

**Shapes.** [@agentick/spec](../spec) owns `LanguageModelInput`, `AdapterDelta`, `LanguageModelExecutionResult`, `ExecutionTarget`, `MediaSource`, the provider namespaces, and `mergeProviderOptions`.

## Roadmap & known gaps

- **No `s3` sources.** Stage to GCS or base64; there is no native `fileData` form for them.
- **Model-generated media is not surfaced.** `normalize` maps text, thinking, and function-call parts; returned `inlineData` — an image the model produced — does not yet become a `generated_image` block.
- **No replayed reasoning input.** Dropped rather than flattened; the signature path is how Gemini round-trips thinking.
- **`CacheHint` is a no-op.** By design, per the section above. Explicit caching goes through `providerOptions.google.cachedContent`.
- **Code-execution provenance is unmapped.** `executableCode` and `codeExecutionResult` parts would be genuine provider tool results carrying `executedBy`; only grounding citations are mapped today.

## Verified by

- `src/__tests__/google-executor.spec.ts` — the dialect: schema sanitization, thought-part routing to reasoning, `thoughtSignature` capture and carry, synthesized block boundaries, stop-reason mapping, the grounding-tools request projection, grounding citations with no `executedBy` stamp, and the factory `providerOptions` bag reaching the request config on both paths, folding over an explicit target's bag, and losing to a tree-declared one.
- `src/__tests__/multimodal-projection.spec.ts` — wire-native modality projection across all four source kinds, the `thoughtSignature` round trip, and the `CacheHint` no-op alongside the `cachedContent` escape hatch.
- `src/__tests__/usage-normalization.spec.ts` — thoughts folded into `outputTokens` with `reasoningTokens` still reported separately, `inputTokens + outputTokens` agreeing with `totalTokenCount`, cached content treated as a subset of input, unreported kinds left `undefined`, streaming and non-streaming agreeing, and a declared `rates` card landing on `target.rates` — including alongside an explicit `target`.
- `src/__tests__/conformance.spec.ts` — the executor conformance suite against the real executor, this adapter, and a stubbed SDK client.
