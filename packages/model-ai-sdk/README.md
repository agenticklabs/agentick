# @agentick/model-ai-sdk

**Keep your provider setup; get the framework.** `aisdk(model)` wraps any Vercel AI SDK `LanguageModel` as a `LanguageModelAdapter`, so an existing `@ai-sdk/openai` or `@ai-sdk/anthropic` handle — with whatever middleware, gateway, or custom fetch you already wired around it — becomes the model behind JSX agents, sessions, tool execution, and the whole observability spine.

The AI SDK is used here as a **provider library**, not an execution engine: one `generateText` or `streamText` call per round, and the loop stays with agentick. That is the boundary that makes the two composable rather than competing.

## Install

```bash
npm install @agentick/model-ai-sdk @agentick/model ai @ai-sdk/openai
```

`ai` and your `@ai-sdk/*` providers are yours to install — this package brings no provider with it.

## Quick start

```tsx
import { openai } from "@ai-sdk/openai";
import { createApp } from "@agentick/app/react";
import { aisdk } from "@agentick/model-ai-sdk";

const app = await createApp(<Agent />, { model: aisdk(openai("gpt-4o")) });
```

Anything the AI SDK hands you works, including a middleware-wrapped model:

```ts
import { openai } from "@ai-sdk/openai";
import { wrapLanguageModel, extractReasoningMiddleware } from "ai";
import { aisdk } from "@agentick/model-ai-sdk";

const model = aisdk(
  wrapLanguageModel({
    model: openai("gpt-4o"),
    middleware: extractReasoningMiddleware({ tagName: "think" }),
  }),
);
```

Or drive it directly, no app:

```ts
import { generate } from "@agentick/model";
import { openai } from "@ai-sdk/openai";
import { aisdk } from "@agentick/model-ai-sdk";

const result = await generate({
  model: aisdk(openai("gpt-4o")),
  messages: [{ role: "user", content: [{ type: "text", text: "Explain read repair." }] }],
});
```

## API

`aisdk(model, options?)` → `LanguageModelAdapter`

| Argument / option | Purpose                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `model`           | Any AI SDK `LanguageModel` — a provider handle or a plain model-id string                                      |
| `options.target`  | Override the self-described `ExecutionTarget`. Defaults are derived from the handle's `provider` and `modelId` |

There is no `clientOptions` and no `client`: the AI SDK handle _is_ the client, so API keys, base URLs, and fetch overrides stay where you already configure them.

Target derivation is why a handle beats a bare string here — a string id carries no provider, so the derived target is thinner. Pass `target` explicitly when you want accurate capabilities, or an accurate serving-provider key for pricing and context-window lookups.

## What crosses the bridge

| Canonical part               | AI SDK part                 | Sources                                                                            |
| ---------------------------- | --------------------------- | ---------------------------------------------------------------------------------- |
| `image`                      | `image`                     | any URL or data URI                                                                |
| `document`, `audio`, `video` | `file` with a `mediaType`   | base64 raw; `url` / `gcs` / `s3` / `reference` forwarded as a URL the SDK resolves |
| `reasoning`                  | `reasoning`                 | the signed payload rides on the part's `providerOptions`                           |
| `tool_use` / `tool_result`   | `tool-call` / `tool-result` | —                                                                                  |

Reasoning comes back through both paths: streamed `reasoning`, `reasoning-delta`, `reasoning-start`, and `reasoning-end` parts map to reasoning deltas, while a non-streaming `reasoning` / `reasoningText` surfaces as a `reasoning` content block ordered before the text. `usage.reasoningTokens` surfaces on the canonical usage.

Generation knobs — temperature, `maxOutputTokens`, `topP`, the penalties, stop sequences — are lifted from the tree config and spread onto the call.

## Provider knobs

The AI SDK has its own `providerOptions` bag, and this adapter forwards the canonical one onto it at three granularities:

| Level       | Source                                                       | Lands on                               |
| ----------- | ------------------------------------------------------------ | -------------------------------------- |
| Request     | `target.providerOptions` folded under the rendered tree's    | the `generateText` / `streamText` call |
| Per message | a message's own `providerOptions`, carried from its metadata | the `ModelMessage.providerOptions`     |
| Per part    | a part's own `providerOptions`                               | that AI SDK part's `providerOptions`   |

So Anthropic cache control or OpenAI reasoning effort reaches the provider exactly as it would if you had called the AI SDK yourself. The canonical spec types the bag as a loose record while the AI SDK types it strictly; the runtime shape is the same.

## The honest gaps

Wrapping another abstraction means some things cannot be mapped correctly, and this adapter says so instead of guessing.

**Provider-executed tools are not forwarded — deliberately.** The AI SDK does not accept raw `{ type, ...config }` entries in a tool set. Provider tools are built by provider-specific factories (`openai.tools.webSearchPreview(config)`, `anthropic.tools.webSearch_20250305(config)`) that produce opaque objects. This adapter holds an opaque `LanguageModel` handle and cannot reconstruct which factory to call from a `{ provider, type, config }` triple, so it forwards `providerTools` **nowhere**. A wrong mapping the SDK rejects at runtime is worse than a documented gap; a correct implementation needs a provider-to-factory registry, which is a layer above this bridge.

**Tool results carry no `executedBy` stamp.** Same root cause: the concrete provider key a stamp requires is not recoverable from an opaque handle, and `"provider:ai-sdk"` would name an execution source that does not exist.

**Provider sources _are_ mapped**, because a citation needs no provider identity: the AI SDK's `sources` become canonical `Citation[]` on the assistant text block with their URL and title. They are whole-response references with no character span, so the citations carry no range.

That is the discipline worth copying into your own adapter: map what the surface actually returns, and leave a loud gap where it doesn't. A fabricated field is a lie the whole pipeline downstream will trust.

## Implementing your own

The port is `LanguageModelAdapter`, and `defineLanguageModelAdapter` is how you build one. Six members are the whole round trip; everything else is an optional hook with a supplied default.

| Member                                                                                                                                   | Required | Role                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------- |
| `provider`, `target`                                                                                                                     | yes      | Identity and self-described capabilities                         |
| `prepareRequest(input)`                                                                                                                  | yes      | Canonical input → the **provider-native** request object. Pure   |
| `send(request, signal)`                                                                                                                  | yes      | The non-streaming call                                           |
| `mapChunk(chunk, accum)`                                                                                                                 | yes      | One provider chunk → canonical `AdapterDelta[]`                  |
| `reconstructRaw(accum, modelSeen)`                                                                                                       | yes      | Final stream state → the raw response shape `normalize` consumes |
| `normalize(raw)`                                                                                                                         | yes      | Raw → `LanguageModelExecutionResult`                             |
| `openStream(request, signal)`                                                                                                            | no       | The streaming call. Omit it to declare no streaming surface      |
| `project` / `finalizeStream` / `adapterTransforms` / `postProcessForNormalize` / `extractMetadata` / `isAbortError` / `mapProviderError` | no       | Provider quirks, each with a default                             |

Two lessons specific to wrapping an SDK rather than an HTTP API:

**"Provider-native request" means native to whatever you call.** Here `prepareRequest` returns the messages, tool set, generation knobs, and provider options that `generateText` takes — not an HTTP body. That is still the right split: the executor's last-mile request hook gets to inspect and transform exactly that object before the call happens. What crosses the seam is whatever your `send` consumes.

**Duck-type the stream you don't own.** The AI SDK's full-stream parts are matched on `type` as loose records rather than against its exported union, so an SDK minor version that adds a part kind does not break the build — it is simply unmapped until someone maps it. When you wrap a moving target, tolerate parts you don't know and map the ones you do.

Provider-private streaming state goes on `accum.providerExtra`, a scratch slot nothing else touches. This adapter keeps block indices, whether text and reasoning blocks have opened, tool-call names by id, and the finish reason there — reasoning gets a reserved block index so it can never collide with the text block.

### Certify it

There is no standalone adapter conformance suite yet. Adapters are certified by running the executor's suite against the real executor plus your adapter. For this bridge the double is the AI SDK's own `MockLanguageModelV2` — no client to stub, because the handle _is_ the client:

```ts
import { MockLanguageModelV2 } from "ai/test";
import { runExecutorConformance } from "@agentick/spec-conformance";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { LanguageModelExecutor } from "@agentick/model-executor";
import { aisdk } from "@agentick/model-ai-sdk";

runExecutorConformance(async ({ harnessId, scripted }) => {
  const bus = new LocalEventBus();
  const executor = new LanguageModelExecutor(
    harnessId,
    new MemoryJournal(),
    bus,
    new LocalInbox(),
    { adapter: aisdk(new MockLanguageModelV2({ doGenerate: mockGenerateFor(scripted) })) },
  );
  await executor.ready;
  return { executor, bus };
});
```

`mockGenerateFor` is yours to write: it returns an SDK result shaped so it normalizes back to what the suite scripted, which means the round trip through `prepareRequest → send → normalize` is what is actually under test rather than a mock of your own code. Write the bridge tests the same way — assert against the call the mock _received_, and against the canonical result your `normalize` produced.

## Patterns

**The contract and the helpers.** [@agentick/model](../model) owns `LanguageModelAdapter`, `defineLanguageModelAdapter`, the canonical projection and its parts, the streaming accumulator, `generate` / `generateStream` / `generateObject`, the `withRetry` / `withFallback` / `tapModel` combinators, and the model registry that prices a call.

**Running inside an app.** [@agentick/model-executor](../model-executor) wraps an adapter with orchestration, abort, backpressure, the request-interception command path, and bus-level delta envelopes.

**Native adapters.** [@agentick/model-openai](../model-openai), [@agentick/model-anthropic](../model-anthropic), and [@agentick/model-google](../model-google) talk to their provider SDKs directly, which is what buys them the provider-tool request mapping and the `executedBy` stamps this bridge cannot do. Reach for a native adapter when you need those; reach for this one when you want to keep an existing AI SDK setup.

**Shapes.** [@agentick/spec](../spec) owns `LanguageModelInput`, `AdapterDelta`, `LanguageModelExecutionResult`, `ExecutionTarget`, `MediaSource`, the provider namespaces, and `mergeProviderOptions`.

## Roadmap & known gaps

- **Provider-executed tools are not forwarded**, and tool results carry no `executedBy` — both by design, per the section above.
- **`responseFormat` is dropped.** The canonical structured-output knob is not translated to an AI SDK response format. `generateObject` still validates the model's text, so it stays correct — but prompt the JSON contract explicitly here.
- **Model-produced files and sources in the stream are unmapped.** `mapChunk` handles text, reasoning, tool-call, and finish parts; `file` and `source` stream parts are ignored rather than surfaced as blocks.
- **No tool registration through this adapter.** `aisdk(model, { tools })` is not a thing — tools come from the agent tree and the tool executor, not from the AI SDK's tool set.
- **The AI SDK as an execution engine is out of scope.** Its loop and its tool dispatch are not used; agentick owns the loop.

## Verified by

- `src/__tests__/ai-sdk-executor.spec.ts` — the bridge against `MockLanguageModelV2`: target derivation from a handle, tool-call extraction, the finish-reason vocabulary, abort, reasoning output and `reasoningTokens`, the invariant that `providerTools` leak nowhere, and provider sources becoming citations.
- `src/__tests__/multimodal-projection.spec.ts` — wire-native modality projection across the source kinds, plus request-level and message-level `providerOptions` carry.
- `src/__tests__/conformance.spec.ts` — the executor conformance suite against the real executor and this adapter.
