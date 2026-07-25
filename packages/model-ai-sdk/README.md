# @agentick/model-ai-sdk

Vercel AI SDK bridge for Agentick v2 (ADR 52) — wraps any `ai` package
`LanguageModel` as a `LanguageModelAdapter`. The progressive-adoption
path: keep your existing `@ai-sdk/*` provider setup, gain JSX agents,
sessions, tool harnesses, and observability.

## Quick Start

```ts
import { openai } from "@ai-sdk/openai";
import { aisdk } from "@agentick/model-ai-sdk";

const app = await createApp(<Agent />, {
  model: aisdk(openai("gpt-4o")),
});
```

## API

`aisdk(model, options?)` → `LanguageModelAdapter`

- `model` — any AI SDK `LanguageModel` (model handle or plain id
  string).
- `options.target` — override the self-described `ExecutionTarget`
  (defaults derive from the model handle's `provider` + `modelId`).

This adapter uses the AI SDK as a **provider library** — one
`generateText` / `streamText` call per executor round; agentick runs
the loop. The "AI SDK as execution engine" archetype (their loop, their
tool dispatch) is a separate ADR 52 follow-up.

## Multimodal & providerOptions (ADR 57)

The adapter projects agentick's wire-native parts to AI SDK 5
`ModelMessage` parts:

| Part                         | AI SDK part                 | Sources supported                                                                      |
| ---------------------------- | --------------------------- | -------------------------------------------------------------------------------------- |
| `image`                      | `image`                     | any URL / data URI                                                                     |
| `document`, `audio`, `video` | `file` (data + `mediaType`) | `base64` (raw), `url` / `gcs` / `s3` / `reference` (as a URL the SDK fetches/forwards) |
| `reasoning`                  | `reasoning`                 | signed payload rides `providerOptions`                                                 |
| `tool_use` / `tool_result`   | `tool-call` / `tool-result` | —                                                                                      |

`providerOptions` fold via `mergeProviderOptions`:

- **Request-level** — folded `target.providerOptions` over
  `input.providerOptions` (#176) forwards to the AI SDK
  `generateText` / `streamText` call's `providerOptions` (Anthropic
  cache control, OpenAI reasoning effort, …). The spec carries the
  looser `Record<string, unknown>`; runtime shape matches AI SDK's
  `SharedV2ProviderOptions`.
- **Per-part** — a part's own `providerOptions` forwards 1:1 onto its
  AI SDK part's `providerOptions` (`partProviderOptions`).
- **Per-message** — a message's own `providerOptions` (carried from
  `MessageEntry.metadata.providerMetadata`, #173) forwards 1:1 onto the
  AI SDK `ModelMessage.providerOptions` (`messageProviderOptions`).

**Reasoning output** (#213). AI SDK 5 `reasoning` / `reasoning-delta` /
`reasoning-start` / `reasoning-end` stream parts map to reasoning deltas,
and `raw.reasoning` / `raw.reasoningText` surface as a `reasoning`
`ContentBlock` (before text — v1 ordering) on the non-streaming path.
`usage.reasoningTokens` surfaces on `UsageStats` (#217).

**Deferred (`TODO(adr-57-followup)` / known gaps):**

- **Output multimodal** — `mapChunk` maps text / reasoning / tool-call /
  finish parts; **file / source** stream parts from the model are not yet
  mapped (silently ignored).
- **`aisdk(model, { tools })`** registration with the app handler
  resolver.

## Provider-executed tools (Pass D)

**Request-half DELIBERATELY not mapped.** Unlike the three native adapters,
the AI SDK does not accept raw `{ type, ...config }` entries in its
`ToolSet` — provider-executed tools are built via provider-specific
factories (`openai.tools.webSearchPreview(config)`,
`anthropic.tools.webSearch_20250305(config)`, …) that produce opaque
provider-defined `Tool` objects. This adapter holds only an opaque
`LanguageModel` handle and cannot reconstruct the right factory call from
`{ provider, type, config }`, so it forwards `input.providerTools` NOWHERE
(a wrong mapping the SDK rejects at runtime is worse than an honest gap).
A correct impl needs a `provider → factory` registry keyed off `pt.provider`.
See the `TODO(pass-d): REQUEST HALF` trailhead in `toAISDKInput`.

**Provenance-half: sources DONE, tool-result executedBy NARROWED.** The AI SDK
exposes provider web sources on `GenerateTextResult.sources` (typed
`Array<Source>`). These are mapped onto the canonical `Citation[]` on the
assistant text block — `url`/`title` → `source`. AI SDK sources are
whole-response refs (no char span), so the citations carry no `range`.

Stamping a `tool_result` with `executedBy: "provider:<key>"` is **narrowed**
(`TODO(pass-d)` in `normalizeImpl`): the adapter holds an OPAQUE `LanguageModel`
handle (same reason the request-half is un-mapped) and cannot determine the
concrete provider key a `ToolExecutor` stamp requires — `"provider:ai-sdk"` is
not a real execution source. Citations need no provider identity, so they ARE
mapped; the provider-identity-bearing stamp stays narrowed.

## Verified by

- `src/__tests__/ai-sdk-executor.spec.ts` — bridge behavior against
  `MockLanguageModelV2` (target derivation, tool-call extraction,
  finish-reason vocabulary, abort, reasoning output + `reasoningTokens`,
  Pass D provider-tools request-half no-leak invariant, Pass D
  provenance-half provider sources → citations).
- `src/__tests__/multimodal-projection.spec.ts` — wire-native modality
  projection, request- and message-level `providerOptions` carry.
- `src/__tests__/conformance.spec.ts` — `runExecutorConformance`
  against `LanguageModelExecutor` + this adapter.
