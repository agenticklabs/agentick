# @agentick/model-google-next

Google (Gemini) `LanguageModelAdapter` for Agentick v2 (ADR 52) — the
[`@google/genai`](https://github.com/googleapis/js-genai) SDK as a
provider-normalization part. Supports the Gemini Developer API (apiKey
path) and Vertex AI (project/location/auth path). Zero Effect, zero
substrate.

## Quick Start

```ts
import { google } from "@agentick/model-google-next";

// Gemini Developer API (apiKey path — env fallback GOOGLE_API_KEY / GEMINI_API_KEY)
const app = await createApp(<Agent />, {
  model: google("gemini-2.5-flash"),
});

// Vertex AI path
const app = await createApp(<Agent />, {
  model: google("gemini-2.5-flash", {
    clientOptions: { vertexai: true, project: "my-project", location: "us-central1" },
  }),
});

// Standalone — single-shot, no framework:
import { generate } from "@agentick/model-next";
const result = await generate({ model: google("gemini-2.5-flash"), messages });
```

The SDK client is constructed lazily on first use.

## API

`google(model?, options?)` → `LanguageModelAdapter<GenerateContentResponse, GenerateContentResponse>`

| Option | Purpose |
| --- | --- |
| `clientOptions` | SDK `GoogleGenAIOptions` (apiKey, vertexai, project, location, …) |
| `client` | Inject a pre-built `GoogleGenAI` client |
| `stream` | Stream every execution |
| `parseThinkTags` | Inline `<think>…</think>` extraction (niche — native `part.thought` is preferred) |
| `customBlocks` | Adopter-declared XML tag extraction |
| `target` | Override the self-described `ExecutionTarget` |

## Gemini dialect

- **Schema sanitization**: `sanitizeSchemaForGemini` reduces tool input
  schemas to Gemini's strict JSON-Schema subset (exported for reuse).
- **`thoughtSignature` round-trip**: Gemini 3+ thinking signatures are
  captured per tool call and re-sent on subsequent turns (avoids
  MISSING_THOUGHT_SIGNATURE).
- **Reasoning**: `part.thought === true` text routes to the reasoning
  channel (Gemini 2.5+ thinking models).
- **Synthesized block boundaries**: Gemini chunks carry none — the
  adapter opens/closes blocks on content-kind transitions and composes
  `defaultFinalizeStream` for late stop-reason mapping.
- **Usage**: `thoughtsTokenCount` → `reasoningTokens`,
  `cachedContentTokenCount` → `cachedInputTokens`.

## Multimodal & providerOptions (ADR 57)

Gemini is natively multimodal — the adapter projects `image`,
`document`, `audio`, and `video` parts to Gemini `Part`s:

| Source | Projection |
| --- | --- |
| `base64` | `inlineData` (mimeType + data) |
| `url` | `fileData` (`fileUri` = the URL) |
| `gcs` | `fileData` (`fileUri` = `gs://bucket/object`) |
| `reference` | `fileData` (`fileUri` = the file id) |

`providerOptions` fold via `mergeProviderOptions`:

- **Request-level** — `ProviderOptions["google"]` merges into the
  `GenerateContentConfig` (thinking config, `safetySettings`, seed, …).
  Folded from `target.providerOptions` over `input.providerOptions`
  (#176). Don't set `systemInstruction` / `tools` / `abortSignal` here.
- **Per-tool** — `ProviderToolOptions["google"]` overrides the
  function declaration.
- **Per-part** — the `thoughtSignature` round-trip rides a `tool_use`
  part's `providerOptions.google.thoughtSignature` (projected from the
  block's `providerMetadata`).

**Deferred (`TODO(adr-57-followup)`):**

- **`s3` document/audio/video sources** — no native Gemini `fileData`
  form; stage to GCS or base64 first.
- **Replayed `reasoning` input** — Gemini round-trips thinking via the
  `thoughtSignature` on the `functionCall` part, not a replayed
  reasoning content part; a bare reasoning part is dropped (never
  flattened to a text bomb).
- **Output multimodal** — `normalize` maps `text` / thinking /
  `functionCall` parts; returned `inlineData` (model-generated images)
  is not yet surfaced as a `generated_image` block.

## Verified by

- `src/__tests__/google-executor.spec.ts` — dialect behavior (schema
  sanitization, thought routing, thoughtSignature carry, block
  synthesis, stop-reason mapping).
- `src/__tests__/conformance.spec.ts` — `runExecutorConformance`
  against `LanguageModelExecutor` + this adapter.
