# @agentick/model-anthropic-next

Anthropic `LanguageModelAdapter` for Agentick v2 (ADR 52) — the
Messages API (`@anthropic-ai/sdk`) as a provider-normalization part.
Zero Effect, zero substrate.

## Quick Start

```ts
import { anthropic } from "@agentick/model-anthropic-next";

// In an app — the app wraps it in the ONE LanguageModelExecutor:
const app = await createApp(<Agent />, {
  model: anthropic("claude-sonnet-5"),
});

// Standalone — single-shot, no framework:
import { generate } from "@agentick/model-next";
const result = await generate({ model: anthropic("claude-sonnet-5"), messages });
```

The SDK client is constructed lazily on first use. Env fallbacks:
`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`.

## API

`anthropic(model?, options?)` → `LanguageModelAdapter<Message, RawMessageStreamEvent>`

| Option | Purpose |
| --- | --- |
| `clientOptions` | SDK `ClientOptions` (apiKey, authToken, baseURL, …) |
| `client` | Inject a pre-built `Anthropic` client |
| `maxTokens` | Default `max_tokens` (Anthropic requires it; default 4096) |
| `stream` | Stream every execution |
| `parseThinkTags` | Inline `<think>…</think>` extraction (niche — native thinking blocks are preferred) |
| `customBlocks` | Adopter-declared XML tag extraction |
| `target` | Override the self-described `ExecutionTarget` |

## Anthropic dialect

- **Custom projection** (`project` hook): system text extracted to the
  `system` param; strict user/assistant alternation enforced.
- **Native thinking**: `thinking` / `redacted_thinking` blocks map to
  the reasoning channel; redacted data round-trips opaquely.
- **Prompt caching**: per-block breakpoints via
  `providerMetadata.anthropic.cacheControl` on the specific content
  block; per-tool via `ProviderToolOptions["anthropic"].cache_control`.
- **Usage**: `cache_read_input_tokens` surfaces as `cachedInputTokens`.

## Verified by

- `src/__tests__/anthropic-executor.spec.ts` — dialect behavior
  (alternation, thinking blocks, stop-reason mapping, streaming
  vocabulary, tag routing).
- `src/__tests__/conformance.spec.ts` — `runExecutorConformance`
  against `LanguageModelExecutor` + this adapter.
