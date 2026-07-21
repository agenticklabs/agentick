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

| Option           | Purpose                                                                             |
| ---------------- | ----------------------------------------------------------------------------------- |
| `clientOptions`  | SDK `ClientOptions` (apiKey, authToken, baseURL, …)                                 |
| `client`         | Inject a pre-built `Anthropic` client                                               |
| `maxTokens`      | Default `max_tokens` (Anthropic requires it; default 4096)                          |
| `stream`         | Stream every execution                                                              |
| `parseThinkTags` | Inline `<think>…</think>` extraction (niche — native thinking blocks are preferred) |
| `customBlocks`   | Adopter-declared XML tag extraction                                                 |
| `target`         | Override the self-described `ExecutionTarget`                                       |

## Anthropic dialect

- **Custom projection** (`project` hook): system text extracted to the
  `system` param; strict user/assistant alternation enforced.
- **Native thinking**: `thinking` / `redacted_thinking` blocks map to
  the reasoning channel; redacted data round-trips opaquely.
- **Prompt caching**: per-block breakpoints via
  `providerMetadata.anthropic.cacheControl` on the specific content
  block; per-tool via `ProviderToolOptions["anthropic"].cache_control`.
- **Usage**: `cache_read_input_tokens` surfaces as `cachedInputTokens`.
- **Stop reasons**: `end_turn`→`end`, `max_tokens`→`max_tokens`,
  `stop_sequence`→`stop_sequence`, `tool_use`→`tool_use`,
  `refusal`→`content_filter`, `pause_turn`→`other` (#216 — `refusal` and
  `pause_turn` were previously masked as a clean `end`).

## Multimodal & providerOptions (ADR 57)

The adapter projects `image`, `document`, and `reasoning` parts to
native Messages content blocks (alongside `text` / `tool_use` /
`tool_result`):

| Part        | Projection                             | Sources supported                                                        |
| ----------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `image`     | `image` block                          | base64 / URL (via `imageSourceFromUrl`)                                  |
| `document`  | `document` block                       | `base64` (inline), `url` (server-side fetch)                             |
| `reasoning` | `thinking` / `redacted_thinking` block | signed thinking replayed verbatim; redacted payload round-trips opaquely |

The `reasoning` round-trip is a hard Anthropic requirement (extended
thinking + tool use): a signed block must replay unchanged on the next
turn — `signature` + `thinking` for a normal block, `data` for a
redacted one (read from `providerOptions.anthropic.redactedData` or the
generic `data` slot).

`providerOptions` fold via `mergeProviderOptions`:

- **Request-level** — `ProviderOptions["anthropic"]` merges into the
  Messages request (thinking budget, `top_k`, `metadata`, …). Folded
  `target.providerOptions` over `input.providerOptions` (#176).
- **Per-tool** — `ProviderToolOptions["anthropic"]` supplies per-tool
  `cache_control`.
- **Per-block** — `providerOptions.anthropic.cacheControl`
  (`{ type: "ephemeral" }`) sets a cache breakpoint on that specific
  content block. Precedence: explicit per-block `cacheControl` > the
  canonical `CacheHint` (#185) the executor translates onto the last
  block.

**Deferred (`TODO(adr-57-followup)`):**

- **`audio` / `video` input** — Messages has no native audio/video
  content part; dropped rather than flattened to a text bomb.
- **`reference` (file-id) / `s3` / `gcs` document sources** — the SDK's
  document `source` union is base64 / url / text / content only; not
  expressible until the SDK exposes them.

## Provider-executed tools (Pass D)

**Request-half wired.** The adapter maps the `provider === "anthropic"`
slice of `input.providerTools` onto the native `tools` array as
`{ type, name, ...config }` — Anthropic server tools carry BOTH a versioned
`type` AND a `name` (e.g. `{ type: "web_search_20250305", name: "web_search",
max_uses: 5 }`). Passthrough; other providers' slices are ignored. Function
tools are unaffected.

**Provenance-half: document citations DONE, web-search NARROWED.** Anthropic
`TextBlock.citations` (document citations — `char_location` / `page_location` /
`content_block_location`) are mapped onto the canonical `Citation[]` on the
annotated text block (`document_index` → `source.documentIndex`, `document_title`
→ `source.title`, `cited_text` → `citedText`, char/page/block span → `range`).

Web-search provenance — stamping `tool_result` with
`executedBy: "provider:anthropic"` and mapping `web_search_result_location`
citations — is **narrowed** (`TODO(pass-d)` in `normalizeImpl`): the installed
`@anthropic-ai/sdk@0.39.0` does not type `server_tool_use` /
`web_search_tool_result` blocks or the web-search citation variant, so a typed
fixture cannot be written against it. Implementing it requires an SDK bump
(server tools land ~0.5x, a cross-cutting break outside this pass). Per the
HARD RULE, we map what the SDK types (documents) and narrow-TODO what it can't
reach rather than fabricate against an untyped shape.

## Verified by

- `src/__tests__/anthropic-executor.spec.ts` — dialect behavior
  (alternation, thinking blocks, stop-reason mapping, streaming
  vocabulary, tag routing, sampling params from `tree.config` #211,
  Pass D provider-tools request-half, Pass D provenance-half document
  citations).
- `src/__tests__/multimodal-projection.spec.ts` — wire-native modality
  projection, thinking round-trip, stop-reason `refusal`/`pause_turn`
  (#216), config-declared `topP`/`stopSequences` reaching the wire (#211).
- `src/__tests__/conformance.spec.ts` — `runExecutorConformance`
  against `LanguageModelExecutor` + this adapter.
