# @agentick/model-anthropic

**The Anthropic Messages API as a plain object.** `anthropic()` returns a `LanguageModelAdapter` — six functions and a handful of quirk hooks, zero Effect, zero substrate. The same value drives a full session through the model executor and answers a three-line `generate()` call with no framework in sight.

It is also the adapter to read when Anthropic's dialect diverges most from the canonical shape: system text lives in its own request field, user and assistant turns must strictly alternate, and a signed thinking block has to replay byte-identical on the next turn. All three are handled by overriding one hook.

## Install

```bash
npm install @agentick/model-anthropic @agentick/model
```

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { anthropic } from "@agentick/model-anthropic";

const app = await createApp(<Agent />, { model: anthropic("claude-sonnet-4-5") });
```

The app wraps the adapter in the model executor for you. Or drive it directly, no app:

```ts
import { generate } from "@agentick/model";
import { anthropic } from "@agentick/model-anthropic";

const result = await generate({
  model: anthropic("claude-sonnet-4-5"),
  messages: [{ role: "user", content: [{ type: "text", text: "Explain quorum reads." }] }],
});

result.output; // ContentBlock[]
result.usage; // UsageStats — cache reads folded into inputTokens
```

The SDK client is constructed lazily on first use, so declaring an adapter needs no key until a call actually happens. Env fallbacks: `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`. Inject `options.client` to bypass construction entirely.

## API

`anthropic(model?, options?)` → `LanguageModelAdapter<Message, RawMessageStreamEvent>`

| Option           | Purpose                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `clientOptions`  | Every field the SDK's `Anthropic` constructor takes (apiKey, authToken, baseURL, timeout, fetch, …). Ignored when `client` is set |
| `client`         | Inject a pre-built `Anthropic` client — tests, custom dispatcher, mTLS                                                            |
| `maxTokens`      | Default `max_tokens`. Anthropic **requires** it; defaults to 4096                                                                 |
| `stream`         | Stream every execution. Per-call intent on the target still wins                                                                  |
| `parseThinkTags` | Route inline `<think>…</think>` to the reasoning channel — niche; native thinking blocks are better                               |
| `customBlocks`   | Adopter-declared XML-ish tags carved out of the text stream as `custom-block-*` deltas                                            |
| `target`         | Override the self-described `ExecutionTarget` (a proxy, an extra capability)                                                      |

Defaults with no `model` argument: `claude-3-5-sonnet-latest`, a 200k context window, 8192 max output tokens, tools and vision on.

## The Anthropic dialect

**A custom projection.** This is the only shipped adapter that overrides `project`: system content is extracted into the request's own `system` field rather than a leading message, and strict user/assistant alternation is enforced by merging adjacent same-role turns. The canonical projection cannot express either, so the override is the honest answer.

**Native thinking.** `thinking` and `redacted_thinking` blocks map to the reasoning channel, and both round-trip. This is not a nicety — extended thinking with tool use _requires_ that a signed block replay unchanged on the next turn, so `signature` + `thinking` (or the opaque `data` of a redacted block) ride back out verbatim.

**Prompt caching, two granularities.** A per-block breakpoint comes from `providerMetadata.anthropic.cacheControl` on the specific content block; a per-tool one from `ProviderToolOptions["anthropic"].cache_control`. An explicit per-block `cacheControl` beats the canonical `CacheHint` that the executor otherwise translates onto the last block. `cache_read_input_tokens` surfaces as `usage.cachedInputTokens`, treated as a subset of `inputTokens`.

**Stop reasons, unmasked.**

| Anthropic       | Canonical        |
| --------------- | ---------------- |
| `end_turn`      | `end`            |
| `max_tokens`    | `max_tokens`     |
| `stop_sequence` | `stop_sequence`  |
| `tool_use`      | `tool_use`       |
| `refusal`       | `content_filter` |
| `pause_turn`    | `other`          |

The last two matter: a refusal and a paused turn are not a clean completion, and reporting them as `end` would make a loop treat a non-answer as an answer.

## Multimodal

| Part        | Native block                     | Sources                                                          |
| ----------- | -------------------------------- | ---------------------------------------------------------------- |
| `image`     | `image`                          | base64, URL                                                      |
| `document`  | `document`                       | base64 (inline), URL (Anthropic fetches server-side)             |
| `reasoning` | `thinking` / `redacted_thinking` | signed thinking replayed verbatim; redacted payload stays opaque |

Audio and video input are **dropped, not flattened** — Messages has no native part for either, and a transcript stuffed into text would be a silent token bomb with different semantics. Same for `reference` (file id), `s3`, and `gcs` document sources: the SDK's document `source` union does not express them.

## Provider knobs

Four channels, each typed by this package augmenting the shared provider namespaces, so `providerOptions.anthropic` is the shape you would write against the SDK directly:

| Channel                              | Reaches                                                          |
| ------------------------------------ | ---------------------------------------------------------------- |
| `ProviderClientOptions["anthropic"]` | The SDK client, via `clientOptions`                              |
| `ProviderOptions["anthropic"]`       | The Messages request body — thinking budget, `top_k`, `metadata` |
| `ProviderToolOptions["anthropic"]`   | One tool declaration — `cache_control`                           |
| `providerMetadata.anthropic`         | What came **back**, per content block                            |

The direction split is the rule: `providerOptions` is what you send, `providerMetadata` is what returned. Bags fold through `mergeProviderOptions` with the rendered tree winning over the target, and provider overrides spread last — an explicit escape-hatch value always beats the canonical mapping.

## Provider-executed tools

Tools Anthropic runs itself are projected onto the native `tools` array from the `provider === "anthropic"` slice of `providerTools`. Anthropic server tools carry **both** a versioned `type` and a `name`, and both pass through verbatim:

```ts
providerTools: [
  {
    provider: "anthropic",
    type: "web_search_20250305",
    name: "web_search",
    config: { max_uses: 5 },
  },
];
```

Other providers' slices are ignored; function tools are unaffected.

Coming back, provenance is mapped in both forms Anthropic uses. Document citations on a text block (`char_location`, `page_location`, `content_block_location`) become canonical `Citation[]` with their document index, title, cited text, and span. A web-search result becomes a `tool_result` block stamped `executedBy: "provider:anthropic"`, with each hit interned as a URL-keyed `Source`; the request half of that exchange is **excluded** from the tool calls the framework would dispatch, so a server-executed search is never re-run locally.

> [!NOTE]
> The pinned SDK does not yet type the server-tool blocks or the web-search citation variant, though the wire delivers them. This adapter carries local wire interfaces and detects those blocks structurally. They are replaced with the SDK's own types on the next bump.

## Implementing your own

The port is `LanguageModelAdapter`, and `defineLanguageModelAdapter` is how you build one. Six members are the whole round trip; everything else is an optional hook with a supplied default.

| Member                                                                                                                       | Required | Role                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| `provider`, `target`                                                                                                         | yes      | Identity and self-described capabilities                       |
| `prepareRequest(input)`                                                                                                      | yes      | Canonical input → the **provider-native** request object. Pure |
| `send(request, signal)`                                                                                                      | yes      | The non-streaming SDK call                                     |
| `mapChunk(chunk, accum)`                                                                                                     | yes      | One provider chunk → canonical `AdapterDelta[]`                |
| `reconstructRaw(accum, modelSeen)`                                                                                           | yes      | Final stream state → the provider's own raw response shape     |
| `normalize(raw)`                                                                                                             | yes      | Raw → `LanguageModelExecutionResult`                           |
| `openStream(request, signal)`                                                                                                | no       | The streaming call. Omit it to declare no streaming surface    |
| `project(input)`                                                                                                             | no       | Replace the canonical projection — what this adapter overrides |
| `finalizeStream` / `adapterTransforms` / `postProcessForNormalize` / `extractMetadata` / `isAbortError` / `mapProviderError` | no       | Provider quirks, each with a default                           |

Two things worth internalizing before you write one:

**`prepareRequest` is split from `send` on purpose.** It returns the provider-native request — a `MessageCreateParams` here — which is exactly what the executor's last-mile request hook gets to inspect and transform before it reaches the SDK. Fold the request inside `send` and you close that seam.

**Override `project` only when the request _shape_ demands it.** Anthropic qualifies: system content is a sibling field, not a message, and alternation is a hard wire requirement. Sampling knobs, tool schemas, and message parts do not qualify — those belong in `prepareRequest`, where you translate the canonical `parameters` into the dialect and drop what the provider lacks.

Streaming state that has nowhere canonical to live goes on `accum.providerExtra`, a scratch slot nothing else touches. This adapter keeps per-block kinds there, so `content_block_stop` knows whether it is closing text, thinking, or a tool call.

### Certify it

There is no standalone adapter conformance suite yet. Adapters are certified by running the executor's suite against the real executor plus your adapter plus a **stubbed SDK client** — which is what `options.client` is for:

```ts
import { runExecutorConformance } from "@agentick/spec-conformance";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { LanguageModelExecutor } from "@agentick/model-executor";
import { anthropic } from "@agentick/model-anthropic";

runExecutorConformance(async ({ harnessId, scripted }) => {
  const bus = new LocalEventBus();
  const executor = new LanguageModelExecutor(
    harnessId,
    new MemoryJournal(),
    bus,
    new LocalInbox(),
    { adapter: anthropic("claude-sonnet-4-5", { client: stubClientFor(scripted) }) },
  );
  await executor.ready;
  return { executor, bus };
});
```

`stubClientFor` is yours to write: it returns canned SDK payloads shaped so they normalize back to what the suite scripted, which means the round trip through `prepareRequest → send → normalize` is what is actually under test rather than a mock of your own code. Write the dialect tests the same way — assert against the request the stub _received_, and against the canonical result your `normalize` produced.

## Patterns

**The contract and the helpers.** [@agentick/model](../model) owns `LanguageModelAdapter`, `defineLanguageModelAdapter`, the canonical projection and its parts, the streaming accumulator, `generate` / `generateStream` / `generateObject`, the `withRetry` / `withFallback` / `tapModel` combinators, and the model registry that prices a call.

**Running inside an app.** [@agentick/model-executor](../model-executor) wraps an adapter with orchestration, abort, backpressure, the request-interception command path, and bus-level delta envelopes.

**Sibling providers.** [@agentick/model-openai](../model-openai), [@agentick/model-google](../model-google), [@agentick/model-ai-sdk](../model-ai-sdk). Compose across them with `withFallback` — each adapter runs its own `prepareRequest`, because native requests are not portable.

**Shapes.** [@agentick/spec](../spec) owns `LanguageModelInput`, `AdapterDelta`, `LanguageModelExecutionResult`, `ExecutionTarget`, `MediaSource`, the provider namespaces, and `mergeProviderOptions`.

## Roadmap & known gaps

- **`responseFormat` is dropped.** The canonical structured-output knob has no Messages equivalent this adapter maps. `generateObject` still validates the model's text, so it stays correct — but prompt the JSON contract explicitly here.
- **No audio or video input.** Dropped rather than flattened; Messages has no native part.
- **Document sources are base64 or URL only.** `reference`, `s3`, and `gcs` are not expressible in the SDK's `source` union.
- **Server-tool types are local.** The web-search block and citation shapes are this package's own interfaces until the SDK types them.
- **Code-execution provenance.** Only web search is stamped with `executedBy`; other server tools return their results unmarked.

## Verified by

- `src/__tests__/anthropic-executor.spec.ts` — the dialect: system extraction and strict alternation, tool-use round-trip including streaming input JSON, abort, the streaming delta vocabulary, cache-token accounting, native thinking blocks, sampling params lifted from tree config, `providerOptions` spread, think-tag routing, custom blocks, base64 images, canonical `CacheHint` translation, canonical `toolChoice`, the provider-tools request projection, and document citations.
- `src/__tests__/provider-web-search.spec.ts` — a provider-executed search: the `tool_result` stamped `executedBy: "provider:anthropic"`, the request half excluded from dispatchable tool calls, URL-interned sources, and web-search-location citations.
- `src/__tests__/multimodal-projection.spec.ts` — base64 documents as native blocks, request-level `providerOptions` reaching the body, the signed-thinking round trip through normalize and back onto the wire, the redacted-thinking opaque round trip, `refusal` → `content_filter`, `pause_turn` → `other`, and config-declared `topP` / `stopSequences` reaching the request.
- `src/__tests__/conformance.spec.ts` — the executor conformance suite against the real executor, this adapter, and a stubbed SDK client.
