# `@agentick/executor-google-next`

Google (Gemini) provider adapter for Agentick v2. Implements
`LanguageModelExecutor` from `@agentick/spec-next` against the
[`@google/genai`](https://github.com/googleapis/js-genai) SDK.

## Quick start

```ts
import { createApp } from "agentick";
import { google } from "@agentick/executor-google-next";

// Gemini Developer API (apiKey path)
const app = await createApp(<Agent />, {
  executor: google("gemini-2.5-flash", {
    apiKey: process.env.GOOGLE_API_KEY,
    stream: true,
  }),
});

// Vertex AI path
const app = await createApp(<Agent />, {
  executor: google("gemini-2.5-flash", {
    vertexai: true,
    project: "my-project",
    location: "us-central1",
  }),
});
```

## Options

See `GoogleExecutorOptions` in `src/google-executor.ts`. Highlights:

- `model`, `apiKey`, `baseURL`, `timeout`
- `vertexai`, `project`, `location`, `googleAuthOptions` — Vertex AI path
- `stream`, `parseThinkTags`, `customBlocks`
- `target` — override capability metadata

Environment variable fallbacks: `GOOGLE_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_GENAI_BASE_URL`.

## Provider-specific knobs (`target.providerOptions.google`)

- `topK`, `responseLogprobs`, `logprobs`, `seed`
- `thinkingConfig: { thinkingBudget, includeThoughts }` — Gemini 2.5+ thinking
- `safetySettings` — per-category harm thresholds
- `cachedContent` — pass a cached-content name to enable prompt caching
- Arbitrary additional fields spread onto the request's `config` object

## Thought signatures (Gemini 3+ thinking)

Gemini 3+ thinking models attach an opaque `thoughtSignature` to each
`functionCall` part. The signature MUST be sent back unchanged on the
next request — otherwise the model returns `MISSING_THOUGHT_SIGNATURE`.

The executor surfaces this via the spec's
`ContentBlock.tool_use.providerMetadata.google.thoughtSignature` and
projects it back when building the next request. Round-trip is
transparent to adopter code — the reconciler-collected
`<message>`/`<content>` blocks carry it automatically.

## Capabilities

| Model            | contextWindow | maxOutputTokens | vision | reasoning |
| ---------------- | ------------- | --------------- | ------ | --------- |
| Gemini 2.5 Pro   | 2M            | 8K              | yes    | yes       |
| Gemini 2.5 Flash | 1M            | 8K              | yes    | yes       |
| Gemini 1.5 Pro   | 2M            | 8K              | yes    | no        |
| Gemini 1.5 Flash | 1M            | 8K              | yes    | no        |

## Limitations

- `frequencyPenalty` / `presencePenalty` are silently dropped — Gemini doesn't expose them.
- Tool/function input schemas pass through `sanitizeSchemaForGemini` which strips
  `$ref`, `$defs`, `additionalItems`, `propertyNames` and simplifies
  mixed-type `anyOf` / `oneOf` — Gemini supports a strict JSON Schema subset.
- Embeddings (`client.models.embedContent`) are not yet exposed — see
  V1-PARITY-TRACKER G10 for the embedding-protocol design.
