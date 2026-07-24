# @agentick/model-next

The **model layer** for Agentick v2 (ADR 52). Zero Effect, zero
substrate — everything between a provider SDK and the executor harness.

The split, in one analogy: **executor : adapter :: timeline : store.**
The executor (`@agentick/model-executor-next`) is the harness — orchestration,
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

### Structured output — `generateObject` (#184)

```ts
import { generateObject } from "@agentick/model-next";
import { z } from "zod";

const invoice = z.object({ total: z.number(), currency: z.string() });

const { object, result } = await generateObject({
  model: openai("gpt-4o"),
  schema: invoice, // any StandardSchemaV1 — zod, effect/schema, jsonSchema()
  messages: [{ role: "user", content: [{ type: "text", text: "Parse: $42 USD" }] }],
});
// object: { total: 42, currency: "USD" } — parsed + validated
// result: the underlying LanguageModelExecutionResult
```

`generateObject` sets `responseFormat: { type: "json_schema" }` from the
schema, then parses and validates the model's text output (throwing
`GenerateObjectError` on non-JSON or schema-validation failure). The
parse+validate step is the shared `parseJsonWithSchema` helper in
`@agentick/spec-next` — extracted so the eventual session-tier
structured-output path can reuse the exact same text→typed pipeline (the
live-schema `SendInput.output` → validated `SendResult.data` sugar is
deferred pending the multi-tick structured-output design; the declarative
`SendInput.responseFormat` directive landed in `@agentick/session-next`).
`generateObject`'s `GenerateObjectError` shape and messages are unchanged.
`responseFormat` is normative today on **OpenAI + Google** only;
Anthropic and AI SDK are reopened as #184 (they currently drop the
canonical `responseFormat` knob — prompt-engineer the JSON contract for
those providers).

### Multimodal — sending an image / document

```ts
const result = await generate({
  model: openai("gpt-4o"),
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What's in this image, and summarize the PDF." },
        { type: "image", imageUrl: "https://example.com/chart.png" },
        {
          type: "document",
          source: { type: "base64", data: pdfBase64, mimeType: "application/pdf" },
          mediaType: "application/pdf",
        },
      ],
    },
  ],
});
```

`image`/`document`/`audio`/`video` parts are **wire-native** — each
adapter projects the `MediaSource` to its provider's structural
representation (base64 / URL / file-id) with no lossy pre-flattening.
See [Multimodal & the provider-knob split](#multimodal--the-provider-knob-split-adr-57).

## API

### `LanguageModelAdapter<TRaw, TChunk>`

The provider-normalization contract. Required members are the round
trip; optional members are provider quirks with executor-supplied
defaults.

| Member                                                                                                                                    | Role                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `provider`, `target`                                                                                                                      | Identity + self-described capabilities      |
| `buildParams(input, target)`                                                                                                              | Canonical input → provider request          |
| `call(params, signal)`                                                                                                                    | Non-streaming SDK call                      |
| `openStream(params, signal)`                                                                                                              | Streaming SDK call (Promise-wrapped OK)     |
| `mapChunk(chunk, accum)`                                                                                                                  | Provider chunk → canonical `AdapterDelta[]` |
| `reconstructRaw(accum, modelSeen)`                                                                                                        | Final stream state → canonical raw          |
| `normalize(raw)`                                                                                                                          | Raw → `LanguageModelExecutionResult`        |
| `project?`, `adapterTransforms?`, `postProcessForNormalize?`, `finalizeStream?`, `isAbortError?`, `mapProviderError?`, `extractMetadata?` | Optional quirk hooks                        |

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
- `defaultProject` + parts (`buildTools`, `buildProviderTools`,
  `buildMessages`, `buildParameters`, …) — canonical RenderedTree projection.
- `isLanguageModelAdapter(value)` — structural guard used by app-level
  slots.

### Tool-call narration injection (`_summary`)

`buildTools(tools, narrate = true)` injects the reserved
`TOOL_NARRATION_FIELD` (`"_summary"`, from `@agentick/spec-next`) as an
**optional** `string` property into each model-facing tool's JSON schema, so the
model can self-narrate what a call is doing in one short first-person sentence
(the text that lights the `useOnToolStart` spinner). It is **never** added to
`required`, never mutates the source schema (shallow copy — `toJsonSchema` may
return a shared cached object), and is skipped when:

- `narrate === false` (the app-level off-switch, threaded from
  `ProjectInput.narrate`),
- the tool sets `annotations.narrate === false`, or
- the tool's own schema already declares a `_summary` property (implicit
  opt-out — we never clobber an author field).

The tool executor (`@agentick/tool-executor-next`) **strips `_summary` before
validation**, so it never reaches the handler or the `tool_result`; the
executor surfaces the model narration alongside the author's `title`/`summary`
and the raw `name` as **four distinct fields** on the tool lifecycle events (the
client composes them — no precedence is presumed). See that package's "Tool-call
presentation" section.

> **⚠️ Token cost.** Injecting `_summary` into every tool schema AND the extra
> model-emitted sentence per call is real input/output token cost on every
> tool-using tick. It defaults ON; disable app-wide via
> `createApp(Agent, { model, narrate: false })`.

### Provider-executed tools (`buildProviderTools`)

`buildProviderTools(providerTools?)` projects `ProviderToolDeclaration[]`
(OpenAI `web_search` / `code_interpreter`, Anthropic `server_tool_use`,
Google grounding) onto `LanguageModelInput.providerTools` — a **sibling** of
the function `tools` list. Provider tools are run **inside the provider**, so
this projection is deliberately minimal: it resolves `name: decl.name ??
decl.type`, copies `provider` / `type` / `config` verbatim, dedupes by
`provider` + resolved `name` (last-wins), and returns `undefined` when empty
so the slot is dropped.

Provider tools **bypass the tool executor entirely** — they carry no
`inputSchema` (the provider owns the arguments), never receive `_summary`
narration, never enter the function `tools` list, and never flow through
`compileForTick`. The loop sources them from the compiled tree's
`declarations.providerTools` (Pass D foundation; config-level provider tools
and the per-adapter wire mapping land in follow-on passes). A provider-tool
result returns on the model response as a `tool_result` block stamped
`executedBy: "provider:<key>"`.

### Combinators

Adapters are plain values — resilience and routing compose:

```ts
model: withFallback(openai("gpt-5"), anthropic("claude-sonnet-5")); // failover; never on abort
model: withRetry(openai("gpt-4o"), { attempts: 3 }); // 429/5xx/network, jittered backoff
model: tapModel(adapter, { onCall, onResult, onDelta }); // observability; never alters behavior
```

Streaming semantics: retry/failover apply through the FIRST chunk (a
stream that has produced output is never replayed or switched). Each
fallback adapter builds its own params; the serving adapter's hooks
handle its own chunks/normalize.

## Multimodal & the provider-knob split (ADR 57)

### Projection: the IR taxonomy → `LanguageModelMessagePart`

The compiler's content-block taxonomy projects onto the executor's
wire-safe `LanguageModelMessagePart` set at the executor boundary, via
`messagePartFromBlock` (part of `defaultProject`). Two classes of block:

- **Wire-native modalities** get a first-class part variant so adapters
  emit the provider's native structural representation, no lossy
  pre-flatten: `text`, `image`, `document`, `audio`, `video`,
  `reasoning`, `tool_use`, `tool_result`.
- **Textual blocks** (`json` / `xml` / `csv` / `html` / `code` /
  `custom` / event blocks) are flattened to `text` by the **format
  harness** before they ever reach the executor. The executor surface
  never sees them.

`document` / `audio` / `video` carry a canonical `MediaSource`
(`base64` / `url` / `reference` (file-id) / `s3` / `gcs`) rather than a
pre-encoded string, so each adapter chooses the wire form its provider
accepts. Replayed model output round-trips too: `generated_image` →
`image` (data URI), `generated_file` → `document` (URL source).

Support is per-provider — see each adapter README's "Multimodal &
providerOptions" section for the exact matrix and deferred sources.

### The provider-knob split: `providerOptions` vs `providerMetadata`

ADR 57 §2 splits the per-part provider-escape channel by direction:

| Field              | Direction                               | Meaning                                                                                                                                                                                    |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `providerOptions`  | **input — what you send**               | Adopter-stamped per-block knobs (Anthropic `cacheControl`) _and_ model-produced opaque data replayed verbatim (Gemini `thoughtSignature`). Typed/augmentable, keyed by provider namespace. |
| `providerMetadata` | **output — what the provider returned** | Written by `normalize` onto output parts (returned cache/reasoning tokens, `thoughtSignature` as produced).                                                                                |

At the projection boundary a canonical block carries only one knob
channel (`BaseContentBlock.providerMetadata`); `messagePartFromBlock`
projects it onto the **input** part's `providerOptions` (what you send).
Adapters read `part.providerOptions[<ns>]` in `buildParams`.

Four structural escape tiers share the same augmentable provider
namespaces (`ProviderClientOptions` / `ProviderOptions` /
`ProviderToolOptions` in spec, plus per-part `providerMetadata`):

- **`ProviderClientOptions`** — SDK client construction (per-executor).
- **`ProviderOptions`** — per-call request shape; lives on
  `RenderedTree.providerOptions`, `ExecutionTarget.providerOptions`, and
  each message part.
- **`ProviderToolOptions`** — per-tool-definition
  (`ToolDeclaration.providerOptions`).
- **per-part `providerMetadata`** — the output carrier described above.

### `mergeProviderOptions` — the one canonical fold

`ProviderOptions` bags are folded by a single function (imported from
`@agentick/spec-next`): `patch` wins per provider-namespace key,
one-level-deep shallow merge (two adopters decorating the same block
under different namespaces never collide). Four call sites share these
semantics — never hand-roll:

1. the compiler folds multiple `<ProviderOptions>` declarations during
   tree collection;
2. projection folds `RenderedTree.providerOptions` **over**
   `ExecutionTarget.providerOptions` into `LanguageModelInput.providerOptions`
   (#176 — tree / per-render wins), computed at project time;
3. adapters fold `input.providerOptions` over `target.providerOptions`
   defensively in `buildParams`.

```ts
import { mergeProviderOptions } from "@agentick/spec-next";
// what an adapter's buildParams does with the request-level channel:
const overrides = mergeProviderOptions(target.providerOptions, input.providerOptions)?.openai;
```

`LanguageModelInput.providerOptions` (the #176 fold) is the
request-level escape hatch — thinking config, seed, safetySettings,
`cache_control`, response format overrides. It is deliberately separate
from `parameters`, which stays pure canonical generation knobs. As of
#211 `buildParameters` lifts the full cross-provider set off `SpecConfig`
— `temperature`, `maxOutputTokens`, `topP`, `frequencyPenalty`,
`presencePenalty`, `stopSequences`, `responseFormat` — so every adapter
reads them from `parameters` (each drops the knobs its provider lacks:
Anthropic/Gemini ignore the penalties). Message-level provider knobs
carried from `MessageEntry.metadata.providerMetadata` project onto
`LanguageModelMessage.providerOptions` (the send channel, #173),
mirroring the per-block `providerMetadata → providerOptions` rule.

## Model registry — capabilities, pricing, context window (#204)

One table, keyed **`serving-provider → modelId-prefix → ModelInfo`**
(pricing, `contextWindow`, `maxOutputTokens`, `capabilities`,
`tokenEstimator`). `SEED_MODELS` ships approximate defaults; adopters
layer real numbers with `mergeRegistry`. Resolution is longest-prefix,
and `effectiveModelInfo(target, registry?)` folds per field with the
ratified precedence **adopter registry > target self-description
(`target.pricing` / `target.capabilities`) > seed** — `undefined` when
no layer knows the model (never fabricated).

```ts
import { effectiveModelInfo, contextUtilization, estimateTokens } from "@agentick/model-next";

const info = effectiveModelInfo(adapter.target, myRegistry); // { contextWindow, pricing, ... }
contextUtilization(usedTokens, info); // 0..1, or undefined if no window
estimateTokens(input, info); // info.tokenEstimator ?? char/4
```

### The `provider` is the SERVING provider, not the model author

The same underlying model re-served through different providers is
different data — different pricing (markup / cut), different model-id
strings, sometimes a different window. Because the registry keys on the
serving provider, each gets its own row and never collides:

```ts
const registry = mergeRegistry(SEED_MODELS, {
  bedrock: {
    "anthropic.claude-sonnet-4": {
      contextWindow: 200_000,
      pricing: { inputPerMTok: 3.3, outputPerMTok: 16.5 },
    },
  },
  openrouter: {
    "anthropic/claude-sonnet-4": {
      contextWindow: 200_000,
      pricing: { inputPerMTok: 3.15, outputPerMTok: 15.75 },
    },
  },
});
// resolveModelInfo({ provider: "bedrock",    modelId: "anthropic.claude-sonnet-4-v1:0" }) → the Bedrock row
// resolveModelInfo({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4"      }) → the OpenRouter row
```

Vertex, Bedrock, OpenRouter, Azure OpenAI — each is a serving provider
with its own table entries. `pricing.ts` (`estimateCost`,
`SEED_PRICING`) is now a thin projection of this one registry — a single
source of numbers.

## Provider packages

| Package                          | Factory                       |
| -------------------------------- | ----------------------------- |
| `@agentick/model-openai-next`    | `openai(model?, options?)`    |
| `@agentick/model-anthropic-next` | `anthropic(model?, options?)` |
| `@agentick/model-google-next`    | `google(model?, options?)`    |
| `@agentick/model-ai-sdk-next`    | `aisdk(model, options?)`      |

None of them depend on `@agentick/model-executor-next` (or Effect) at
runtime — an adapter is usable standalone via `generate()`.

## Verified by

- `src/__tests__/model-info.spec.ts` — resolution, longest-prefix,
  `effectiveModelInfo` precedence, indirect-provider keying
  (same model, distinct specs per serving provider), utilization,
  token estimation, single-source pricing parity.

- `src/__tests__/combinators.spec.ts` — retry/failover/tap semantics,
  first-chunk boundary, abort passthrough, composition.

- `src/__tests__/generate.spec.ts` — generate/generateStream fold,
  transform pipeline, synthetic message-start, error propagation.
- `src/__tests__/generate-object.spec.ts` — `responseFormat` wiring,
  JSON parse + schema validation, `GenerateObjectError` on failure.
- `src/__tests__/canonical-projection.spec.ts` — projection parts,
  wire-native multimodal variants, `providerMetadata → providerOptions`,
  `SpecConfig` generation params lift (#211), message-level
  `providerMetadata → providerOptions` carry (#173), Pass D
  `buildProviderTools` projection (name resolution, provider+name dedupe,
  empty-slot omission, kept out of the function `tools` list).
- `src/__tests__/narration-injection.spec.ts` — `buildTools` injects the
  reserved `_summary` narration property when enabled, and skips it on
  `narrate=false` (app-level), `annotations.narrate:false` (per-tool), an
  already-present `_summary` (author opt-out); never in `required`; source
  schema not mutated; model-exposure filtering.
- `src/__tests__/cache-hints.spec.ts` — `CacheHint` (#185) threading
  through section boundaries and message parts.
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
