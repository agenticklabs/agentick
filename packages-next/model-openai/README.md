# @agentick/model-openai-next

OpenAI `LanguageModelAdapter` for Agentick v2 (ADR 52) — the Chat
Completions API as a provider-normalization part. Zero Effect, zero
substrate.

## Quick Start

```ts
import { openai } from "@agentick/model-openai-next";

// In an app — the app wraps it in the ONE LanguageModelExecutor:
const app = await createApp(<Agent />, { model: openai("gpt-4o") });

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
needed. `usage.completion_tokens_details.reasoning_tokens` surfaces as
`UsageStats.reasoningTokens` (#217).

Model selection: `target.modelId` (the per-tick `<Model>` override, ADR
56) wins over the construction-time `openai(model)` default; the default
applies only when the target names no model (#214).

## Multimodal & providerOptions (ADR 57)

The adapter projects wire-native message parts to Chat Completions
content parts:

| Part | Projection | Sources supported |
| --- | --- | --- |
| `image` | `image_url` part | any URL (incl. data URIs) |
| `document` | `file` part | `base64` (inline data URI + filename from `source.metadata.filename`), `reference` (Files API `file_id`) |
| `audio` | `input_audio` part | `base64` only (`format` wav/mp3 inferred from MIME) |

`providerOptions` reach the request in two places, both merged with
`mergeProviderOptions`:

- **Request-level** — `ProviderOptions["openai"]` (a
  `Partial<ChatCompletionCreateParams>`) spreads onto the request body.
  Folded from `target.providerOptions` and `input.providerOptions`
  (tree-over-target, #176). Don't set `model` / `messages` / `stream`
  here.
- **Per-tool** — `ProviderToolOptions["openai"]` (e.g. `{ strict: true }`)
  merges into each tool's `function` shape.

**Deferred (`TODO(adr-57-followup)`):**

- **`video` + replayed `reasoning` input** — Chat Completions has no
  native slot; dropped rather than flattened to a token bomb.
- **Staged document sources** — `url` / `s3` / `gcs` documents (stage to
  base64 or upload for a `file_id` first).
- **Non-base64 audio sources** — only inline base64 is a first-class
  `input_audio` part.

## Provider-executed tools (Pass D)

**Request-half wired.** The adapter maps the `provider === "openai"` slice
of `input.providerTools` onto the native `tools` array as `{ type, ...config }`
(passthrough — the adopter writes OpenAI's own type string, e.g.
`web_search_preview`). Other providers' slices are ignored. Function tools
and their `tool_choice: "auto"` are unaffected.

**Provenance-half TODO.** Parsing provider-EXECUTED results and stamping
`executedBy: "provider:openai"` is not yet implemented — see the
`TODO(pass-d): PROVENANCE HALF` trailhead at the response-mapping site
(`normalizeImpl` in `openai-adapter.ts`).

## Verified by

- `src/__tests__/openai-executor.spec.ts` — dialect behavior (message
  conversion, finish_reason mapping, abort, streaming deltas, think
  tags, custom blocks, `target.modelId` precedence #214, Pass D
  provider-tools request-half).
- `src/__tests__/multimodal-projection.spec.ts` — wire-native modality
  projection, model-override precedence (#214), `reasoningTokens` (#217).
- `src/__tests__/conformance.spec.ts` — `runExecutorConformance`
  against `LanguageModelExecutor` + this adapter.
