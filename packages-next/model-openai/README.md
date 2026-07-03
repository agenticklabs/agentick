# @agentick/model-openai-next

OpenAI `LanguageModelAdapter` for Agentick v2 (ADR 52) — the Chat
Completions API as a provider-normalization part. Zero Effect, zero
substrate.

## Quick Start

```ts
import { openai } from "@agentick/model-openai-next";

// In an app — the app wraps it in the ONE LanguageModelExecutor:
const app = await createApp(<Agent />, { executor: openai("gpt-4o") });

// Standalone — single-shot, no framework:
import { generate } from "@agentick/model-next";
const result = await generate({ model: openai("gpt-4o"), messages });
```

The SDK client is constructed lazily on first use — declaring the
adapter does not require `OPENAI_API_KEY` until a call happens. Env
fallbacks: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`.

## API

`openai(model?, options?)` → `LanguageModelAdapter<ChatCompletion, ChatCompletionChunk>`

| Option | Purpose |
| --- | --- |
| `clientOptions` | SDK `ClientOptions` (apiKey, baseURL, …) |
| `client` | Inject a pre-built `OpenAI` client (tests, mTLS, …) |
| `stream` | Stream every execution (delta envelopes on the bus) |
| `parseThinkTags` | Route inline `<think>…</think>` to the reasoning channel (OpenAI-compatible local servers) |
| `customBlocks` | Adopter-declared XML tag extraction |
| `target` | Override the self-described `ExecutionTarget` |

Provider-options escape hatch (typed via module augmentation):
`ProviderOptions["openai"]` spreads onto the request body;
`ProviderToolOptions["openai"]` merges into each tool's function shape
(e.g. `strict: true`).

Reasoning support: native `reasoning_content` / `reasoning` fields
(vLLM, LM Studio) map to reasoning deltas automatically — no option
needed.

## Verified by

- `src/__tests__/openai-executor.spec.ts` — dialect behavior (message
  conversion, finish_reason mapping, abort, streaming deltas, think
  tags, custom blocks).
- `src/__tests__/conformance.spec.ts` — `runExecutorConformance`
  against `LanguageModelExecutor` + this adapter.
