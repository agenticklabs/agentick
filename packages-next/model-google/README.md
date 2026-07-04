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

## Verified by

- `src/__tests__/google-executor.spec.ts` — dialect behavior (schema
  sanitization, thought routing, thoughtSignature carry, block
  synthesis, stop-reason mapping).
- `src/__tests__/conformance.spec.ts` — `runExecutorConformance`
  against `LanguageModelExecutor` + this adapter.
