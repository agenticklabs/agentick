# ADR 105 — Model modalities: one adapter contract + one executor family per modality

**Status:** DRAFT 2026-08-28 (Fable, for Ryan — direction ratified in design conversation).
**Builds on:** ADR 52 (executors and model adapters: the split), ADR 89 (the model call is
a command on a harness), ADR 42 (harness-slot trichotomy), ADR 66 (tool dependency
resolution — optional harnesses reach `ctx` via `ToolHandlerCtxExtensions`), ADR 26
(everything is a harness).

## TL;DR

1. **Modalities are executor FAMILIES, not methods on the language-model adapter.** The spec
   already says it — `ExecutorProtocol<TInput, TOutput, TResult>` is generic and
   `LanguageModelExecutor` is annotated _"the v2 shipped family"_ — and then only one family was
   ever populated. This ADR populates two more: **`image-model`** and **`embedding-model`**.
2. **One thin adapter contract per family, in the provider package's family factory.**
   `google("gemini-2.5-pro")` stays the `LanguageModelAdapter`; `google.images("imagen-4.0")`
   returns an `ImageModelAdapter`, `google.embeddings("gemini-embedding-001")` an
   `EmbeddingModelAdapter`. The adapter owns the provider call; the executor owns orchestration
   (ADR 52's split, unchanged).
3. **Each family's call is a command** — `model:generate_image`, `model:embed` — on an executor
   harness in `@agentick/model-executor`, beside `model:generate`. Journal, spans, `guard()`
   /`use()` interceptors, retry/fallback, and cost attribution walk the spine the first family
   built; nothing bespoke.
4. **App slots + ctx facets.** `createApp({ images, embeddings })` are ADR 42 slots mirroring
   `model:` (adapter | executor | factory); tool handlers reach them as `ctx.images` /
   `ctx.embeddings` through the ADR 66 augmentation seam — optional harnesses not every deployment
   mounts, exactly like `sandbox`.
5. **Not** done here: `LanguageModelAdapter` grows no optional modality methods (a stub in every
   adapter that isn't the one provider); streaming image generation; video/speech families
   (they follow the same recipe when a consumer appears).

## Context

`@agentick/model` and `LanguageModelAdapter` model exactly one thing: the streaming chat round
trip (`prepareRequest → send/openStream → mapChunk → reconstructRaw → normalize`). There is no
`embed`, no `generateImage`. The consequences in the first adopter:

- Image generation is a hand-rolled Vertex client inside a tool (`generate_image` v1), outside
  every framework seam — no journal, no interceptors, no cost.
- Embeddings ride **`@agentick/google` 0.15 — the v1 lane** — because that adapter shipped an
  `embed()` and the v2 one does not. `@knowify/knowledge`'s embedder is a duck type over it. A
  v1-lane dependency survives in assistant-api for this reason alone.

The framework left the door open in two places: `ExecutionTarget.kind` is
`"language-model" | (string & {})`, and ADR 89 established that a model call is a command on a
harness. Families are the extension axis the design named and never used.

### Why not methods on the language-model adapter

A `generateImage?()` on `LanguageModelAdapter` would be (a) a stub on every adapter that isn't
Google, (b) invisible to the op spine unless the LM executor grew a second command that has
nothing to do with deltas or accumulators, and (c) a signal that modality is an adapter quirk
rather than a first-class kind. Families keep each contract as thin as the LM one is.

## Decision

### 1. Spec contracts (`spec/protocol/executor.ts` — beside the LM family)

```ts
// ── image-model family ──
interface ImageGenerateInput {
  readonly prompt: string;
  /** Reference images — an edit / variation. Provider decides the mechanism. */
  readonly references?: readonly MediaSource[];
  readonly count?: number; // default 1
  readonly aspectRatio?: string; // "1:1", "16:9", …
  readonly mimeType?: "image/png" | "image/jpeg" | "image/webp";
  readonly negativePrompt?: string;
  readonly seed?: number;
  readonly providerOptions?: ProviderOptions;
}
interface GeneratedImage {
  readonly data: string /* base64 */;
  readonly mimeType: string;
  readonly enhancedPrompt?: string;
}
interface ImageGenerateResult extends ExecutionResult {
  readonly images: readonly GeneratedImage[];
}
interface ImageModelAdapter {
  readonly provider: string;
  readonly target: ExecutionTarget; // kind: "image-model"
  generate(input: ImageGenerateInput, signal?: AbortSignal): Promise<ImageGenerateResult>;
  mapProviderError?(cause: unknown): ExecuteErrorChannel;
}
interface ImageModelExecutorProtocol {
  readonly family: "image-model";
  readonly target: ExecutionTarget;
  readonly ready: Promise<void>;
  generate(
    input: ImageGenerateInput,
    opts?: { scope?: EventScope; signal?: AbortSignal },
  ): Promise<ImageGenerateResult>;
}

// ── embedding-model family ──
interface EmbedInput {
  readonly input: readonly string[];
  readonly dimensions?: number;
  readonly task?: "query" | "document";
  readonly providerOptions?: ProviderOptions;
}
interface EmbedResult extends ExecutionResult {
  readonly embeddings: readonly (readonly number[])[];
  readonly dimensions: number;
}
interface EmbeddingModelAdapter {
  provider;
  target /* kind: "embedding-model" */;
  embed(input, signal?): Promise<EmbedResult>;
  mapProviderError?;
}
interface EmbeddingModelExecutorProtocol {
  family: "embedding-model";
  target;
  ready;
  embed(input, opts?): Promise<EmbedResult>;
}
```

`ExecutionResult` is the shared base (`specVersion`, `output` content blocks — the generated
images ride there as image blocks too, so a result is renderable without knowing the family —
`usage`, `finishMetadata`). `ExecutionTarget.pricing` gains optional `perImage` and
`embeddingPerMTok` so cost attribution has a rate card.

### 2. Executors (`@agentick/model-executor`)

`ImageModelExecutor extends BaseHarness<"model">` — `family = "image-model"`, one command
`model:generate_image` whose body calls `adapter.generate`, maps provider errors through the same
`ExecuteErrorChannel` taxonomy (`ProviderRejected` / `ProviderTimeout` / `ProviderAborted`),
stamps `spanAttributes` (`<ns>.image.model`, `<ns>.image.count`). `EmbeddingModelExecutor` is
its twin with `model:embed`. Both take `{ adapter, inheritedInterceptors, interceptorParent }`
like the LM executor, so app-level `guard()`/`use()` cascade in.

Neither streams. `ExecutorFx`'s `executeStream` is the LM family's shape; the new protocols are
Promise-facing and minimal by design (ADR 52: Promise external, Effect internal).

### 3. Provider family factories (`@agentick/model-google`)

```ts
google.images("imagen-4.0-generate-001", options?)   // ImageModelAdapter
google.embeddings("gemini-embedding-001", options?)  // EmbeddingModelAdapter
```

Same `GoogleAdapterOptions` (client / clientOptions / apiKey resolution via
`buildClientOptions`), same memoized `GoogleGenAI`. Images: `models.generateImages` (Imagen) for a
prompt-only call; a call with `references` routes to the Gemini image model
(`generateContent` with `responseModalities: ["IMAGE"]`) — the Developer-API path for edits.
Vertex-only verbs (`upscaleImage`, `outputGcsUri`) are deliberately not modeled. Embeddings:
`models.embedContent` with `outputDimensionality` and `taskType` mapped from `task`.

### 4. App slots + ctx facets

`createApp({ images?: ImageModelAdapter | ImageModelExecutorProtocol | ExecutorFactory,
embeddings?: … })` resolve exactly as `model:`/`modelExecutor:` do (adapter → executor
constructed with the app's substrate + interceptor cascade). The app folds them into
`ctxExtensions` (the `sandbox`/`skills`/`completions` path) and `@agentick/model-executor`
augments:

```ts
declare module "@agentick/spec" {
  interface ToolHandlerCtxExtensions {
    readonly images?: ImageModelExecutorProtocol;
    readonly embeddings?: EmbeddingModelExecutorProtocol;
  }
}
```

Absent slot ⇒ absent facet; a tool guards on `ctx.images` the way it guards on `ctx.sandbox`.

### 5. Adopter migration (knowify)

- `generate_image` becomes a lib tool over `ctx.images` + a media write port for persistence.
- `knowifyEmbedder` takes `google.embeddings(...)` — the `EmbeddingModel` duck type becomes the
  real contract — and **`@agentick/google` (v1) leaves assistant-api**.
- `search_history`'s semantic index reuses the same adapter.

## Consequences

- Two new families, zero changes to the LM adapter contract or its executor.
- Every image/embedding call is on the op spine: journaled, spanned, guardable, costed.
- The recipe for the next modality (speech, video) is mechanical: contract → executor → family
  factory → slot → facet.

## Open questions

1. Should `session.model` (ADR 89 §2 facade) grow sibling facades (`session.images`) for
   per-session swaps? Deferred — no consumer; the app slot covers today's needs.
2. Batch/rate policy for embeddings (chunk the `input` array across calls) — executor-level
   middleware when a consumer needs it; knowledge's `EmbeddingService` already batches.
