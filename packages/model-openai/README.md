# @agentick/model-openai

**The OpenAI Chat Completions API as a plain object.** `openai()` returns a `LanguageModelAdapter` — six functions and a handful of quirk hooks, zero Effect, zero substrate. The same value drives a full session through the model executor and answers a three-line `generate()` call with no framework in sight.

It is also the adapter that reaches beyond OpenAI itself. Chat Completions is the lingua franca of local and self-hosted inference, so a base URL plus a target override points this at vLLM, LM Studio, ollama, or anything else speaking the same wire — including the ones that emit chain-of-thought as inline tags instead of a reasoning field.

## Install

```bash
npm install @agentick/model-openai
```

`@agentick/model` arrives with it (a dependency). Add it to your own
manifest only when you import from it directly — combinators, the model
registry, `defineLanguageModelAdapter`.

## Quick start

```tsx
import { createApp } from "@agentick/app/react";
import { openai } from "@agentick/model-openai";

const app = await createApp(<Agent />, { model: openai("gpt-4o") });
```

The app wraps the adapter in the model executor for you. Or drive it directly, no app:

```ts
import { generate } from "@agentick/model";
import { openai } from "@agentick/model-openai";

const result = await generate({
  model: openai("gpt-4o"),
  messages: [{ role: "user", content: [{ type: "text", text: "Explain vector clocks." }] }],
});

result.output; // ContentBlock[]
result.stopReason; // "end" | "tool_use" | "max_tokens" | "content_filter" | …
```

The SDK client is constructed lazily on first use, so declaring an adapter needs no key until a call actually happens. Env fallbacks: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORGANIZATION`. Inject `options.client` to bypass construction entirely.

## API

`openai(model?, options?)` → `LanguageModelAdapter<ChatCompletion, ChatCompletionChunk>`

| Option           | Purpose                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `clientOptions`  | Every field the SDK's `OpenAI` constructor takes (apiKey, baseURL, organization, project, timeout, fetch, …). Ignored when `client` is set |
| `client`         | Inject a pre-built `OpenAI` client — tests, custom dispatcher, mTLS                                                                        |
| `stream`         | Stream every execution. Per-call intent on the target still wins                                                                           |
| `parseThinkTags` | Route inline `<think>…</think>` from the content channel to reasoning deltas                                                               |
| `customBlocks`   | Adopter-declared XML-ish tags carved out of the text stream as `custom-block-*` deltas                                                     |
| `target`         | Override the self-described `ExecutionTarget` — the switch for a non-stock endpoint                                                        |

Defaults with no `model` argument: `gpt-4o-mini`, with tools, streaming, and JSON-schema output advertised.

## Pointing it somewhere else

Any server that speaks Chat Completions works. Give it a base URL, and describe what it actually supports rather than inheriting OpenAI's claims:

```ts
const local = openai("qwen3-32b", {
  clientOptions: { baseURL: "http://localhost:1234/v1", apiKey: "not-needed" },
  parseThinkTags: true, // this server emits <think> in the content channel
  target: {
    kind: "language-model",
    provider: "lmstudio", // a distinct serving provider — its own registry row
    modelId: "qwen3-32b",
    capabilities: { supportsTools: true, supportsStreaming: true, contextWindow: 32_768 },
  },
});
```

Two things earn their keep there. `provider` is the **serving** provider, so pricing and window lookups get their own registry row instead of colliding with a hosted model of the same name. And `parseThinkTags` re-routes inline reasoning that the server did not extract for you — servers that do expose `reasoning_content` or `reasoning` need no option at all, since those fields map to reasoning deltas automatically.

## The OpenAI dialect

**No projection override.** Unlike Anthropic, this adapter uses the canonical projection unchanged — system content as a leading message, tools as a `tools[]` array. All of the dialect lives in `prepareRequest`.

**Model precedence.** A per-tick model override on the target wins over the construction-time `openai(model)` default; the default applies only when the target names no model. So one adapter instance serves a tree that switches models per render.

**Reasoning.** `reasoning_content` and `reasoning` fields map to reasoning deltas with no option needed, and `usage.completion_tokens_details.reasoning_tokens` surfaces as `usage.reasoningTokens`.

**Stop reasons.**

| `finish_reason`  | Canonical        |
| ---------------- | ---------------- |
| `stop`           | `end`            |
| `length`         | `max_tokens`     |
| `content_filter` | `content_filter` |
| `tool_calls`     | `tool_use`       |
| `function_call`  | `tool_use`       |

**Structured output.** The canonical `responseFormat` maps natively to a `json_schema` response format, which is what makes `generateObject` a single call here rather than a prompt-and-hope.

## Multimodal

| Part       | Native part   | Sources                                                                                          |
| ---------- | ------------- | ------------------------------------------------------------------------------------------------ |
| `image`    | `image_url`   | any URL, including data URIs                                                                     |
| `document` | `file`        | base64 (inline data URI, filename from the source metadata), `reference` (a Files API `file_id`) |
| `audio`    | `input_audio` | base64 only; `format` (wav / mp3) inferred from the MIME type                                    |

Video and replayed `reasoning` input are **dropped, not flattened** — Chat Completions has no slot for either, and stuffing them into text would be a silent token bomb. URL, `s3`, and `gcs` document sources need staging first: fetch to base64, or upload for a `file_id`.

## Provider knobs

Four channels, each typed by this package augmenting the shared provider namespaces, so `providerOptions.openai` is the shape you would write against the SDK directly:

| Channel                           | Reaches                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| `ProviderClientOptions["openai"]` | The SDK client, via `clientOptions`                                       |
| `ProviderOptions["openai"]`       | The request body — a `Partial<ChatCompletionCreateParams>` spread onto it |
| `ProviderToolOptions["openai"]`   | One tool's `function` shape — `{ strict: true }`, say                     |
| `providerMetadata.openai`         | What came **back**, per content block                                     |

The direction split is the rule: `providerOptions` is what you send, `providerMetadata` is what returned. Bags fold through `mergeProviderOptions` with the rendered tree winning over the target, and provider overrides spread last — an explicit escape-hatch value always beats the canonical mapping.

> [!WARNING]
> Don't set `model`, `messages`, or `stream` through `providerOptions`. Those are the adapter's to own, and overriding them desynchronizes the request from the target the executor thinks it called.

## Provider-executed tools

Tools OpenAI runs itself are projected onto the native `tools` array from the `provider === "openai"` slice of `providerTools`, as `{ type, ...config }` — you write OpenAI's own type string and it passes through verbatim:

```ts
providerTools: [{ provider: "openai", type: "web_search_preview" }];
```

Other providers' slices are ignored; function tools and their `tool_choice` are unaffected.

Coming back, web-search provenance arrives as `message.annotations` of kind `url_citation`, and those become canonical `Citation[]` on the assistant text block with their URL, title, and character span.

> [!NOTE]
> Provider-executed tool _results_ are not stamped with `executedBy` on this surface, because Chat Completions does not return them as discrete items — they are typed output items on the Responses API, which this adapter does not target. For the same reason there is no handler-less provider call to suppress: `message.tool_calls` only ever carries dispatchable function calls.

## Implementing your own

The port is `LanguageModelAdapter`, and `defineLanguageModelAdapter` is how you build one. Six members are the whole round trip; everything else is an optional hook with a supplied default.

| Member                                                                                                                       | Required | Role                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------- |
| `provider`, `target`                                                                                                         | yes      | Identity and self-described capabilities                        |
| `prepareRequest(input)`                                                                                                      | yes      | Canonical input → the **provider-native** request object. Pure  |
| `send(request, signal)`                                                                                                      | yes      | The non-streaming SDK call                                      |
| `mapChunk(chunk, accum)`                                                                                                     | yes      | One provider chunk → canonical `AdapterDelta[]`                 |
| `reconstructRaw(accum, modelSeen)`                                                                                           | yes      | Final stream state → the provider's own raw response shape      |
| `normalize(raw)`                                                                                                             | yes      | Raw → `LanguageModelExecutionResult`                            |
| `openStream(request, signal)`                                                                                                | no       | The streaming call. Omit it to declare no streaming surface     |
| `project(input)`                                                                                                             | no       | Replace the canonical projection — **not** used by this adapter |
| `finalizeStream` / `adapterTransforms` / `postProcessForNormalize` / `extractMetadata` / `isAbortError` / `mapProviderError` | no       | Provider quirks, each with a default                            |

Three things worth internalizing before you write one:

**`prepareRequest` is split from `send` on purpose.** It returns the provider-native request — a `ChatCompletionCreateParams` here — which is exactly what the executor's last-mile request hook gets to inspect and transform before it reaches the SDK. Fold the request inside `send` and you close that seam.

**Reach for `project` last.** This adapter is the proof that most providers don't need it: the canonical projection produced the messages and tools, and every OpenAI-specific decision — parameter names, `tool_choice` translation, the multimodal parts, the response format — happened in `prepareRequest`. Override `project` only when the request's _shape_ diverges, as Anthropic's system field and alternation rule do.

**`mapChunk` must be pure.** Which blocks are open and which tool calls have started are derived from the accumulator, not from closure state, so one adapter instance serves concurrent executions. Anything genuinely provider-private — a response id, a late `finish_reason` — goes on `accum.providerExtra`, a scratch slot nothing else touches, and `reconstructRaw` reads it back to rebuild a raw response the shared `normalize` can consume. That is what makes the streaming and non-streaming paths normalize identically.

### Certify it

There is no standalone adapter conformance suite yet. Adapters are certified by running the executor's suite against the real executor plus your adapter plus a **stubbed SDK client** — which is what `options.client` is for:

```ts
import { runExecutorConformance } from "@agentick/spec-conformance";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { LanguageModelExecutor } from "@agentick/model-executor";
import { openai } from "@agentick/model-openai";

runExecutorConformance(async ({ harnessId, scripted }) => {
  const bus = new LocalEventBus();
  const executor = new LanguageModelExecutor(
    harnessId,
    new MemoryJournal(),
    bus,
    new LocalInbox(),
    { adapter: openai("gpt-4o-mini", { client: stubClientFor(scripted) }) },
  );
  await executor.ready;
  return { executor, bus };
});
```

`stubClientFor` is yours to write: it returns canned SDK payloads shaped so they normalize back to what the suite scripted, which means the round trip through `prepareRequest → send → normalize` is what is actually under test rather than a mock of your own code. Write the dialect tests the same way — assert against the request the stub _received_, and against the canonical result your `normalize` produced.

## Patterns

**The contract and the helpers.** [@agentick/model](../model) owns `LanguageModelAdapter`, `defineLanguageModelAdapter`, the canonical projection and its parts, the streaming accumulator, `generate` / `generateStream` / `generateObject`, the `withRetry` / `withFallback` / `tapModel` combinators, and the model registry that prices a call.

**Running inside an app.** [@agentick/model-executor](../model-executor) wraps an adapter with orchestration, abort, backpressure, the request-interception command path, and bus-level delta envelopes.

**Sibling providers.** [@agentick/model-anthropic](../model-anthropic), [@agentick/model-google](../model-google), [@agentick/model-ai-sdk](../model-ai-sdk). Compose across them with `withFallback` — each adapter runs its own `prepareRequest`, because native requests are not portable.

**Shapes.** [@agentick/spec](../spec) owns `LanguageModelInput`, `AdapterDelta`, `LanguageModelExecutionResult`, `ExecutionTarget`, `MediaSource`, the provider namespaces, and `mergeProviderOptions`.

`StreamTagParser` is re-exported here for convenience; it lives in [@agentick/model](../model) alongside the `thinkTagTransform` and `customBlockTransform` built on it.

## Roadmap & known gaps

- **Chat Completions only.** The Responses API is not targeted, which is what bounds the provider-tool provenance above.
- **No video, no replayed reasoning input.** Dropped rather than flattened.
- **Staged document and audio sources.** Only base64 (plus a Files API `file_id` for documents) is a first-class part; URL, `s3`, and `gcs` need staging first.
- **Provider tool results carry no `executedBy`.** Not reachable on this surface — see the note above.

## Verified by

- `src/__tests__/openai-executor.spec.ts` — the dialect: message conversion, `finish_reason` mapping, abort, the streaming delta vocabulary, think-tag routing, custom blocks, target-over-construction model precedence, the provider-tools request projection, and web-search citations.
- `src/__tests__/multimodal-projection.spec.ts` — wire-native modality projection, the model-override precedence, and `reasoningTokens` surfacing on usage.
- `src/__tests__/provider-request-hooks.spec.ts` — the last-mile request hook seeing and transforming the provider-native request `prepareRequest` produced.
- `src/__tests__/conformance.spec.ts` — the executor conformance suite against the real executor, this adapter, and a stubbed SDK client, with the same protocol checks passing against the fake executor.
