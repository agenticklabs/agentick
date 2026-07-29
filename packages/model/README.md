# @agentick/model

**A model adapter is a plain object, not a subclass.** This package owns everything between a provider SDK and the rest of the framework: the `LanguageModelAdapter` contract, the canonical projection that turns a compiled tree into a provider request, the streaming delta fold, and the standalone `generate()` / `generateStream()` / `generateObject()` helpers.

That plainness is the bet. An adapter is Promise/AsyncIterable-shaped with zero Effect and zero substrate, so the same object a session drives through [@agentick/model-executor](../model-executor) also runs on its own with three lines and no framework. Everything else follows: resilience and routing are function composition (`withRetry`, `withFallback`, `tapModel`) rather than configuration; bringing a new provider means writing six functions; and there is exactly **one** normalization step between the SDK and everything downstream.

## Install

```bash
npm install @agentick/model @agentick/model-openai
```

Subpaths: `/testing` (`scriptedAdapter`, the canonical adapter double).

## Quick start

No app, no session, no substrate — an adapter and a call:

```ts
import { generate } from "@agentick/model";
import { openai } from "@agentick/model-openai";

const result = await generate({
  model: openai("gpt-4o"),
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Summarize the CAP theorem in two sentences." }],
    },
  ],
});

result.output; // ContentBlock[] — the normalized assistant content
result.stopReason; // "end" | "tool_use" | "max_tokens" | ...
result.usage; // UsageStats — optional; a provider that reports nothing reports nothing
```

> [!IMPORTANT]
> `generate` and `generateStream` are **single-shot**: one provider call in, one normalized result out. Tools are advertised, but tool calls come back on the result **unexecuted** — the loop belongs to [@agentick/model-executor](../model-executor) and [@agentick/session](../session), not here.

## Streaming

`generateStream` returns the delta stream and the eventual result side by side. The stream is the same canonical vocabulary the executor emits, because it runs the same fold:

```ts
import { generateStream } from "@agentick/model";
import { openai } from "@agentick/model-openai";

const handle = generateStream({
  model: openai("gpt-4o"),
  messages: [{ role: "user", content: [{ type: "text", text: "Write a haiku about b-trees." }] }],
});

for await (const delta of handle.stream) {
  if (delta.type === "content-delta") process.stdout.write(delta.delta);
  if (delta.type === "reasoning-delta") process.stderr.write(delta.delta);
}

const final = await handle.result; // resolves once the stream is drained
```

`handle.result` resolves only after the stream is consumed — the fold needs every delta — and rejects if the provider stream throws. Consuming the stream and ignoring `result` never produces an unhandled rejection.

## Structured output

`generateObject` sets a `json_schema` response format from any Standard Schema, then parses and validates the model's text:

```ts
import { generateObject, GenerateObjectError } from "@agentick/model";
import { openai } from "@agentick/model-openai";
import { z } from "zod";

const Invoice = z.object({ total: z.number(), currency: z.string() });

try {
  const { object, result } = await generateObject({
    model: openai("gpt-4o"),
    schema: Invoice,
    messages: [{ role: "user", content: [{ type: "text", text: "Parse: $42 USD" }] }],
  });
  object.total; // 42 — typed and validated
  result.usage; // the underlying execution result rides along
} catch (cause) {
  if (cause instanceof GenerateObjectError) {
    cause.text; // the raw text the model produced
    cause.issues; // Standard Schema issues ([] for a JSON parse failure)
  }
}
```

Any Standard Schema works — zod, effect/schema, or a raw `jsonSchema()` from [@agentick/spec](../spec). Validation is the safety net, so the helper is correct even against providers that ignore the response-format directive.

> [!NOTE]
> `responseFormat` maps natively on OpenAI and Google. Anthropic and the AI SDK adapter currently drop the canonical knob — validation still catches non-adherence, but prompt the JSON contract explicitly on those providers.

## Multimodal

Images, documents, audio and video are **wire-native parts**, not pre-flattened strings. Each adapter projects the `MediaSource` to its provider's own representation:

```ts
import { generate } from "@agentick/model";
import { openai } from "@agentick/model-openai";

const result = await generate({
  model: openai("gpt-4o"),
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What's in this chart, and summarize the attached PDF." },
        { type: "image", source: { type: "url", url: "https://example.com/chart.png" } },
        {
          type: "document",
          source: { type: "base64", data: pdfBase64, mimeType: "application/pdf" },
          mediaType: "application/pdf",
        },
      ],
    },
  ],
});
```

A `MediaSource` is `base64` | `url` | `reference` (an id in the **adopter's** namespace) — three kinds, and the set is **closed**.

`s3` and `gcs` used to sit alongside them and are deleted, not deprecated: the framework only ever re-concatenated their fields into a URI (`gs://${bucket}/${object}`), so an app decomposed a URI purely so the framework could put it back together. And the set had no closure — R2, Azure Blob, MinIO, IPFS and `file:` were all equally entitled, each a breaking change plus four adapter arms. A `url` carries any of them as a scheme, and `capabilities.media.urlSchemes` says which schemes a target can actually fetch. Adding a vendor is now data, not a release. All four modality parts carry one, so nothing is flattened to a string before an adapter sees it — the projection preserves sources that have no lexical form, and the adapter declines what its provider cannot fetch rather than emitting an invalid URL. Replayed model output round-trips through the same set: a `generated_image` block projects back to an `image` part with a `base64` source, a `generated_file` to a `document` with a URL source. Per-provider support is documented in each adapter's README.

`reference` is the one source the framework **cannot** resolve: `fileId` is meaningful only to the adopter's own storage. Resolve it in a `onModelGenerate` hook — swap it for a `url` (any scheme your provider declares) or a `base64` source — or accept that adapters will decline it.

## Bring your own provider

`defineLanguageModelAdapter` is the blessed constructor. Six functions are the whole round trip; everything else is an optional quirk hook with a supplied default.

```ts
import { defineLanguageModelAdapter, type StreamAccumulatorView } from "@agentick/model";
import { SPEC_VERSION, type AdapterDelta, type LanguageModelExecutionResult } from "@agentick/spec";

interface EchoRaw {
  readonly text: string;
}
interface EchoRequest {
  readonly prompt: string;
}

async function* words(prompt: string): AsyncGenerator<string> {
  for (const word of prompt.split(" ")) yield `${word} `;
}

export const echo = defineLanguageModelAdapter<EchoRaw, string, EchoRequest>({
  provider: "echo",
  target: {
    kind: "language-model",
    provider: "echo",
    modelId: "echo-1",
    capabilities: { supportsTools: false, supportsStreaming: true },
  },

  // 1. canonical input → the provider's NATIVE request. Pure.
  prepareRequest: ({ targetInput }) => ({
    prompt: targetInput.messages
      .flatMap((m) => m.content)
      .map((part) => (part.type === "text" ? part.text : ""))
      .join(""),
  }),

  // 2. the two SDK calls, over that native request
  send: (request) => Promise.resolve({ text: request.prompt }),
  openStream: (request) => words(request.prompt),

  // 3. provider chunk → canonical deltas
  mapChunk: (chunk: string, accum: StreamAccumulatorView): readonly AdapterDelta[] => [
    ...(accum.textByBlock.has(0)
      ? []
      : ([{ type: "content-start", blockIndex: 0, blockType: "text" }] as const)),
    { type: "content-delta", blockIndex: 0, delta: chunk },
  ],

  // 4. final stream state → canonical raw → canonical result
  reconstructRaw: (accum) => ({ text: accum.totalText() }),
  normalize: (raw): LanguageModelExecutionResult => ({
    specVersion: SPEC_VERSION,
    output: [{ type: "text", text: raw.text }],
    stopReason: "end",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  }),
});
```

`prepareRequest` is split from `send` deliberately: it returns the **provider-native** request object, which is what the executor's last-mile request hook gets to transform before it reaches the SDK. Omitting `openStream` declares "no streaming surface" — `defineLanguageModelAdapter` derives `supportsStreaming` from its presence.

| Member                                                                                                                              | Role                                         |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `provider`, `target`                                                                                                                | Identity + self-described capabilities       |
| `prepareRequest(input)`                                                                                                             | Canonical input → provider-native request    |
| `send(request, signal)`                                                                                                             | Non-streaming SDK call                       |
| `openStream?(request, signal)`                                                                                                      | Streaming SDK call (Promise-wrapped is fine) |
| `mapChunk(chunk, accum)`                                                                                                            | Provider chunk → canonical `AdapterDelta[]`  |
| `reconstructRaw(accum, modelSeen)`                                                                                                  | Final stream state → canonical raw           |
| `normalize(raw)`                                                                                                                    | Raw → `LanguageModelExecutionResult`         |
| `project?` `adapterTransforms?` `postProcessForNormalize?` `finalizeStream?` `isAbortError?` `mapProviderError?` `extractMetadata?` | Optional provider quirks                     |

**The no-double-normalization guardrail:** `LanguageModelInput`, `AdapterDelta`, and `LanguageModelExecutionResult` are the ONLY shapes that cross between an adapter and its consumer. Nothing downstream re-derives provider shapes.

### The accumulator

`mapChunk` and `reconstructRaw` receive a `StreamAccumulatorView` — read-only accumulation state (`textByBlock`, `reasoningByBlock`, `toolCalls`, `openBlocks`, `totalText()`, `toContentBlocks()`), plus exactly three writable slots: `stopReason` and `usage` for providers that learn them late, and `providerExtra`, a scratch field nothing else touches.

`defaultFinalizeStream(accum)` is the end-of-stream finalization as an executable value, so an override composes with it instead of re-rolling it:

```ts
import { defaultFinalizeStream, type StreamAccumulatorView } from "@agentick/model";
import type { AdapterDelta } from "@agentick/spec";

function finalizeStream(accum: StreamAccumulatorView): readonly AdapterDelta[] {
  accum.stopReason = "max_tokens"; // a trailer the provider only sends at the end
  return defaultFinalizeStream(accum);
}
```

It closes open blocks, closes tool calls that never saw an explicit end, emits `message-end`, and synthesizes the canonical `message` summary — rolling every block's `sources` up onto the message, deduped by source id.

## Combinators

Adapters are values, so resilience composes:

```ts
import { withFallback, withRetry, tapModel } from "@agentick/model";
import { openai } from "@agentick/model-openai";
import { anthropic } from "@agentick/model-anthropic";

const resilient = withFallback(
  withRetry(openai("gpt-4o"), { attempts: 3 }), // 429/5xx/network, jittered backoff
  anthropic("claude-sonnet-4-5"), // engages when the primary fails to start
);

const observed = tapModel(resilient, {
  onCall: (_request, target) => console.log("→", target.modelId),
  onResult: (r) => console.log("←", r.usage?.totalTokens),
});
```

The streaming boundary is the first chunk. `withRetry` retries the non-streaming call and the stream **start** (open plus first pull — generator-shaped adapters only surface start failures on the first pull); once a chunk has been observed, errors propagate. `withFallback` engages the next adapter when the current one fails to start, and **never on abort**. Neither switches mid-stream, so no partial output is ever replayed.

Failover is per-adapter all the way down: each adapter runs its own `prepareRequest` (native requests are not portable), and the serving adapter's `mapChunk` / `reconstructRaw` / `normalize` handle its own output. Per-execution serving state is keyed off the accumulator, so one composite serves concurrent executions.

`tapModel` is observation only — tap callbacks that throw are swallowed and never break the pipeline.

## Projection — what the model actually sees

`defaultProject` folds a compiled tree into a `LanguageModelInput`: sections become one system message, message entries become chat messages, model-exposed tool declarations become `tools[]`. Adapters override `project` only when their system-message or tool shape demands it.

The parts are exported individually so a custom projection stays aligned with the canonical one: `buildMessages`, `buildTools`, `buildProviderTools`, `buildParameters`, `collectSectionText`, `sectionText`, `messagePartFromBlock`.

### Media fidelity — what reaches the provider, and what you are told

Every modality part carries a `MediaSource`: `base64` | `url` (any scheme) | `reference`. Nothing is flattened to a string before an adapter sees it, so a source with no lexical form survives the trip.

A target **declares** which kinds it carries, per modality, and the framework enforces it immediately before the adapter builds its request:

```ts
capabilities: {
  media: { image: ["base64", "url"], document: ["base64", "url"] },
  //       ^ audio and video ABSENT — this target carries neither
  urlSchemes: ["https", "http", "data", "gs"], // Vertex reads Cloud Storage natively
}
```

Absent `media` means **undeclared** — nothing is screened, never "carries nothing". Present means **complete**: a modality with no entry carries nothing. `urlSchemes` defaults to `["http", "https", "data"]`.

Why a declaration rather than letting each adapter decide, which is what used to happen: the verdict was **discarded**. A part an adapter could not carry was skipped and the request **succeeded**, so the model never saw the user's attachment and nothing recorded it. And some verdicts were never reached — Anthropic has no `audio` or `video` arm, so those parts fall off the end of its `switch` with no `null` to observe. Moving the fact onto the target makes it data: enforced in one place, and checkable (`runMediaDeclarationCheck` asserts each adapter's declaration against its real wire projection).

**A declined part is reported.** One `ctx.log` warning per decline, carrying coordinates that join to a timeline entry id.

> [!IMPORTANT]
> A `reference` is the one source the framework **cannot** resolve — `fileId` is in your namespace. Swap it for a `url` or `base64` source in an `onBeforeModelGenerate` hook (that seam runs _before_ the screen, precisely so it gets its chance), or accept that it is dropped and reported.

### Attribution — repair is yours, legibility is ours

A provider rejects a **request** and names nothing inside it. Since every turn replays the whole conversation, one bad entry then breaks every future turn.

The framework does not repair that, and cannot: repair needs to know what in your store is durable versus derived, whether you may mutate it, and what a quarantine means in your data model. So it owes you the facts it uniquely holds, and you decide.

| We own               | You get                                                    |
| -------------------- | ---------------------------------------------------------- |
| The projection       | `buildMessageProvenance` — which entry produced which part |
| The adapter boundary | `applyMediaSupport` declines, and `detectDroppedInputs`    |
| The error taxonomy   | `ProviderRejected`, status, `isTransientProviderError`     |
| The wire             | The request as sent, at a hook                             |

```ts
const messages = buildMessages(tree);
const provenance = buildMessageProvenance(tree);
provenance[1]?.[1]; // → { entryId: "m_7", blockIndex: 1 } — durable, unlike a position
```

Provenance is **derived, never stored**: it is a function of `(tree, target)`, so it is a property of a _projection_, not of a message — storing it on the entity is the category error of storing a query plan on the table. Same rule as a compiler's source map.

> [!WARNING]
> **It describes THIS projection.** It mirrors the walk `buildMessages` does, so if an adapter supplies its own `project` (Anthropic does) or your app filters via `<Timeline>`, these origins name the wrong entries. The framework's real contribution is the contract — _if you project, emit origins_.

Two facts make the rest cheap and are worth knowing before you build on it. `boundary.target` records which target ran a turn, so a `succeeded` boundary proves every entry it carried was projectable **for that target** — narrowing suspects after a failure to the entries appended since the last comparable success, usually one. And `detectDroppedInputs` catches what a declaration cannot: it re-projects without one input and deep-compares, so an identical request means that input contributed nothing. `n + 1` local projections, no network — a failure-time audit rather than a per-tick cost.

### Tool-call narration (`_summary`)

`buildTools(tools, narrate)` injects a reserved optional `_summary` string property into each model-facing tool schema so the model can narrate what a call is doing in one first-person sentence — the text that lights a tool-start spinner in a UI. It is never added to `required`, never mutates the source schema, and [@agentick/tool-executor](../tool-executor) strips it before validation, so it never reaches a handler or a `tool_result`.

Three independent opt-outs, each of which skips injection:

| Opt-out                                            | Scope                                              |
| -------------------------------------------------- | -------------------------------------------------- |
| `buildTools(tools, false)`                         | App-wide, threaded from the app's `narrate` flag   |
| `annotations: { narrate: false }` on a declaration | That one tool                                      |
| The tool's schema already declares `_summary`      | That one tool — an author field is never clobbered |

> [!WARNING]
> Narration is on by default and costs real tokens on every tool-using tick — one extra schema property per tool plus one extra model-emitted sentence per call. Turn it off app-wide with `narrate: false` if that trade isn't worth it for your workload.

### Provider-executed tools

`buildProviderTools` projects declarations for tools the **provider** runs (OpenAI `web_search`, Anthropic server tools, Google grounding) onto `LanguageModelInput.providerTools` — a sibling of the function `tools` list, never a member of it. The projection is deliberately minimal: resolve `name ?? type`, copy `provider` / `type` / `config` verbatim, dedupe by provider plus resolved name (last wins), and return `undefined` when empty so the slot is dropped entirely.

Provider tools carry no input schema (the provider owns the arguments), are never narrated, and bypass tool execution completely.

### The provider-knob channels

Four escape tiers share one set of augmentable provider namespaces. Spec ships them as empty interfaces; each adapter package augments its own slot with the SDK's real types, so `providerOptions.openai` is the shape you'd write against the SDK directly.

| Channel                 | Lives on                                        | Scope                                |
| ----------------------- | ----------------------------------------------- | ------------------------------------ |
| `ProviderClientOptions` | adapter construction                            | SDK client (apiKey, baseURL, region) |
| `ProviderOptions`       | target · rendered tree · message · message part | per-call request shape               |
| `ProviderToolOptions`   | `ToolDeclaration.providerOptions`               | per tool definition                  |
| `providerMetadata`      | content blocks and output parts                 | what the provider **returned**       |

The direction split is the rule worth memorizing: **`providerOptions` is what you send; `providerMetadata` is what came back.** A canonical content block carries only `providerMetadata`, and projection maps it onto the _input_ part's `providerOptions` — which is how model-produced opaque data (a Gemini `thoughtSignature`, a signed reasoning block) replays verbatim on the next turn.

Bags fold through one function — never hand-roll it:

```ts
import { mergeProviderOptions } from "@agentick/spec";

// what an adapter does in prepareRequest: tree/per-render wins over target
const merged = mergeProviderOptions(target.providerOptions, input.providerOptions);
```

`patch` wins per provider-namespace key with a one-level-deep merge, so two adopters decorating the same block under different namespaces never collide.

Canonical generation knobs stay out of that channel entirely. `buildParameters` lifts `temperature`, `maxOutputTokens`, `topP`, `frequencyPenalty`, `presencePenalty`, `stopSequences`, `responseFormat` and `toolChoice` off the tree config into `parameters`, and each adapter translates them into its own dialect (`tool_choice`, `functionCallingConfig`, …), dropping the ones its provider lacks. Provider overrides spread last, so an explicit escape-hatch value always wins over the canonical mapping.

## Model registry — window, pricing, cost

One table keyed **serving provider → model-id prefix → `ModelInfo`**, carrying pricing, context window, output cap, capabilities and an optional tokenizer. `SEED_MODELS` ships approximate defaults; layer your own numbers over them.

```ts
import {
  SEED_MODELS,
  contextUtilization,
  effectiveModelInfo,
  estimateTokens,
  mergeRegistry,
} from "@agentick/model";
import { openai } from "@agentick/model-openai";

const registry = mergeRegistry(SEED_MODELS, {
  openai: {
    "gpt-4o": { contextWindow: 128_000, pricing: { inputPerMTok: 2.5, outputPerMTok: 10 } },
  },
});

const adapter = openai("gpt-4o");
const info = effectiveModelInfo(adapter.target, registry);
contextUtilization(96_000, info); // 0.75 — or undefined when no window is known
estimateTokens("some prompt text", info); // info.tokenEstimator ?? char/4
```

Resolution is longest-prefix (`gpt-4o-mini` beats `gpt-4o` for minis), and `effectiveModelInfo` folds per field with a fixed precedence: **adopter registry > the adapter's self-description > seed**. When no layer knows the model the answer is `undefined` — never a fabricated number.

### `provider` means the serving provider

The same underlying model re-served through Bedrock, Vertex, OpenRouter or Azure is different data: different markup, different model-id strings, sometimes a different window. Keying on the serving provider gives each its own row, and they never collide:

```ts
import { mergeRegistry, resolveModelInfo, SEED_MODELS } from "@agentick/model";

const registry = mergeRegistry(SEED_MODELS, {
  bedrock: {
    "anthropic.claude-sonnet-4": {
      contextWindow: 200_000,
      pricing: { inputPerMTok: 3.3, outputPerMTok: 16.5 },
    },
  },
  openrouter: {
    "anthropic/claude-sonnet-4": {
      contextWindow: 200_000,
      pricing: { inputPerMTok: 3.15, outputPerMTok: 15.75 },
    },
  },
});

resolveModelInfo({ provider: "bedrock", modelId: "anthropic.claude-sonnet-4-v1:0" }, registry);
resolveModelInfo({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4" }, registry);
```

### Cost

`estimateCost` is a projection of the same table — one source of numbers:

```ts
import { estimateCost, mergeUsageStats } from "@agentick/model";
import type { UsageStats } from "@agentick/spec";

// `ticks` — one UsageStats sample per model call
const total = ticks.reduce<UsageStats>(mergeUsageStats, {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
});

const cost = estimateCost(total, adapter.target);
cost?.totalUSD; // undefined for a model no layer prices — never a fabricated zero
cost?.pricing; // the row that produced the estimate, for auditing
```

Cached reads and cache writes are billed at their own rates and are treated as **subsets** of `inputTokens`, so fresh input is `inputTokens - cached - written`. Unpriced cache rates fall back to the input rate rather than to zero.

## Streaming extras

**Tag routing.** Some OpenAI-compatible servers (vLLM, LM Studio, quantized local models) emit chain-of-thought as inline `<think>` tags in the content channel instead of a reasoning field. `thinkTagTransform()` re-routes those to `reasoning-*` deltas. `customBlockTransform(defs)` does the same for adopter-declared tags, emitting `custom-block-*` deltas — a way to carve structured channels (citations, sentinels, semantic markers) out of a text stream. Both are built on `StreamTagParser`, which buffers correctly across chunk boundaries, parses attributes, handles self-closing tags, and flushes an unclosed tag as a best-effort block rather than losing it.

**Source interning.** A provider response cites the same URL across many spans. `createSourceInterner()` mints one `Source` with one turn-stable id per natural key (`url`, else `doc:<documentIndex>`), so citations resolve by `sourceId` and the message-level roll-up dedupes cleanly:

```ts
import { createSourceInterner } from "@agentick/model";

const sources = createSourceInterner();
const a = sources.intern({ url: "https://example.com/a", title: "A" }); // → id "s0"
const again = sources.intern({ url: "https://example.com/a" }); // → the SAME object
sources.all(); // every interned source, in first-seen order
```

A source with neither a URL nor a document index has no shared identity and is interned distinctly each time.

## API

### `@agentick/model`

| Export                                                                                       | Purpose                                        |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `generate` / `generateStream`                                                                | Standalone single-shot call over an adapter    |
| `generateObject` / `GenerateObjectError`                                                     | Schema-validated structured output             |
| `defineLanguageModelAdapter`                                                                 | The blessed adapter constructor                |
| `isLanguageModelAdapter`                                                                     | Structural guard for adapter-or-executor slots |
| `defaultFinalizeStream`                                                                      | End-of-stream finalization, composable         |
| `withRetry` / `withFallback` / `tapModel`                                                    | Resilience, failover, observability            |
| `isTransientProviderError`                                                                   | The default retry predicate (429/5xx/network)  |
| `StreamAccumulator`                                                                          | The canonical delta fold                       |
| `composeTransforms` / `identityTransform`                                                    | `DeltaTransform` pipeline                      |
| `thinkTagTransform` / `customBlockTransform`                                                 | Tag routing as transforms                      |
| `StreamTagParser`                                                                            | The streaming XML-ish tag parser beneath them  |
| `defaultProject` + `buildTools` / `buildProviderTools` / `buildMessages` / `buildParameters` | Canonical projection and its parts             |
| `messagePartFromBlock` / `sectionText` / `collectSectionText`                                | Projection leaves                              |
| `buildMessageProvenance`                                                                     | Where-provenance over a projected request      |
| `applyMediaSupport`                                                                          | Screen media against the target's declaration  |
| `detectDroppedInputs`                                                                        | What the adapter silently discarded            |
| `createSourceInterner`                                                                       | Per-turn one-source-one-id registry            |
| `SEED_MODELS` / `resolveModelInfo` / `mergeRegistry` / `effectiveModelInfo`                  | The model registry                             |
| `contextUtilization` / `estimateTokens`                                                      | Window ratio and token estimation              |
| `SEED_PRICING` / `resolvePricing` / `mergePricing` / `estimateCost` / `mergeUsageStats`      | Cost accounting                                |

Types: `LanguageModelAdapter`, `LanguageModelAdapterDefinition`, `StreamAccumulatorView`, `AccumToolCall`, `DeltaTransform`, `CustomBlockDefinition`, `StreamTagHandler` / `StreamTagParserConfig` / `StreamTagEvent`, `GenerateOptions`, `GenerateObjectOptions` / `GenerateObjectResult`, `RetryOptions`, `ModelTap`, `SourceInterner`, `ModelInfo` / `ModelPricing` / `ModelRegistry`, `PricingTable` / `CostEstimate`, `MessageProvenance` / `PartOrigin`, `MediaSupportResult` / `PartDeclined`, `DroppedInputs` / `DroppedPart` / `ProjectingAdapter`.

### `@agentick/model/testing`

| Export                              | Purpose                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `scriptedAdapter(text, ?)`          | Scripted adapter double — chunk scripting, failure scripting, `calls()` / `seenParams()` introspection |
| `runMediaDeclarationCheck(adapter)` | Asserts `capabilities.media` matches the adapter's real wire projection, both directions               |

```ts
import { scriptedAdapter } from "@agentick/model/testing";

const flaky = scriptedAdapter("done", { failures: 2 }); // two 429s, then success
const secondary = scriptedAdapter("done", { provider: "backup", tagOutput: true });
```

Spread-override any hook for a behavior-specific variant: `{ ...scriptedAdapter("x"), openStream: () => { throw boom; } }`.

## Patterns

**Provider packages.** Each implements the adapter contract and augments its own provider namespaces. None depend on the executor or on Effect at runtime — every one of them works standalone through `generate()`.

| Package                                         | Factory                       |
| ----------------------------------------------- | ----------------------------- |
| [@agentick/model-openai](../model-openai)       | `openai(model?, options?)`    |
| [@agentick/model-anthropic](../model-anthropic) | `anthropic(model?, options?)` |
| [@agentick/model-google](../model-google)       | `google(model?, options?)`    |
| [@agentick/model-ai-sdk](../model-ai-sdk)       | `aisdk(model, options?)`      |

**Running inside an app.** [@agentick/model-executor](../model-executor) wraps an adapter with orchestration, backpressure, abort, the request-interception command path, and bus-level delta envelopes. Hand an adapter to `createApp({ model })` and that wrapping happens for you; executor events then flow through the app's event stream.

**Shapes.** [@agentick/spec](../spec) owns `LanguageModelInput`, `LanguageModelMessage(Part)`, `LanguageModelTool`, `AdapterDelta`, `LanguageModelExecutionResult`, `ExecutionTarget`, `MediaSource`, the provider-namespace interfaces, and `mergeProviderOptions`.

**Downstream of narration.** [@agentick/tool-executor](../tool-executor) strips `_summary` before validation and surfaces it alongside the author's `title` / `summary` and the raw tool name as four distinct fields on the tool lifecycle events — the client composes them; no precedence is assumed.

## Roadmap & known gaps

- **No adapter-level conformance suite.** There is no `runModelAdapterConformance`. Adapters are certified today by running the executor's conformance suite against the real executor plus the adapter plus a stubbed provider client — which means certification requires the executor even though the contract itself is Effect-free.
- **Modalities beyond text.** `embed`, `embedMany`, `transcribe`, `generateSpeech` and `generateImage` are not part of the contract; adapters expose them, if at all, outside it.
- **`responseFormat` coverage.** Native on OpenAI and Google only; Anthropic and the AI SDK adapter drop the canonical knob.
- **Chain-wide transforms under `withFallback`.** `adapterTransforms` are compiled before the serving adapter is known, so the primary's transforms apply to whichever adapter ends up serving. Compose adapters that share a projection.
- **Seed registry breadth.** `SEED_MODELS` covers a handful of headline models with approximate numbers. Treat it as a convenience default and override anything cost- or limit-sensitive.
- **No token-budget enforcement.** `estimateCost` and `estimateTokens` report; nothing in this layer stops a call for exceeding a budget.
- **No search ships.** When the declaration and `detectDroppedInputs` both come up empty, narrowing further means probing — re-projecting without a subset and asking again. That is a minimizing search over a candidate set (Zeller's `ddmin`), it needs nothing only the framework has, and it is yours to write. Narrow with the regression range first (`boundary.target` plus your own log) and you will usually not need one.
- **Four adapters still discard inputs silently.** `detectDroppedInputs` makes them _observable_; nothing yet makes them _reported_. The verdicts are not on the stream and not at a hook, so an application only learns of them by asking. Surfacing them per-request is the remaining half of the disclosure invariant. `TODO(decline-reporting)`.
- **Lossy-but-accepted transformations are undetected.** An adapter that keeps an input while changing its meaning — flattening a reasoning block into visible text, joining cache-hinted sections and losing the breakpoints — passes both mechanisms here: nothing was dropped, and the provider accepts it. Only the adapter knows, so only the adapter can disclose it, and no adapter does yet.
- **`customBlockTransform` has no suite here.** It is exercised through the provider packages' executor tests; `StreamTagParser` beneath it is pinned directly.

## Verified by

- `src/__tests__/generate.spec.ts` — the `prepareRequest → send → normalize` round trip, `postProcessForNormalize`, the streaming delta vocabulary, the adapter transform pipeline (think tags → reasoning), and result rejection when the provider stream throws.
- `src/__tests__/generate-object.spec.ts` — `responseFormat` wiring, a raw `jsonSchema()` carried through, the typed validated object, and `GenerateObjectError` on both non-JSON output and schema violation.
- `src/__tests__/combinators.spec.ts` — retry of transient failures and of the stream open, non-retry of non-transient causes, failover to a secondary with the serving adapter's `normalize`, streaming failover through the secondary's `mapChunk`, never-on-abort, exhausted chains, composition of retry with failover, tap transparency with swallowed tap errors, and the transient classifier.
- `src/__tests__/canonical-projection.spec.ts` — wire-native modality parts, the `generated_image` data-URI regression, resource projection, `providerMetadata → providerOptions` on parts and on messages, the tree-over-target `providerOptions` fold, `buildParameters` lifting the generation knobs and `toolChoice`, and `buildProviderTools` name resolution, dedupe, empty-slot omission, and exclusion from the function tools list.
- `src/__tests__/dropped-inputs.spec.ts` — a dropped part found among carried ones and reported nothing for a faithful adapter; a SOLO dropped part whose removal also empties its message (and again when the adapter drops the emptied message wholesale — the apparent confound that is not one); drops across several messages; two identical parts not mistaken for one drop; a dropped `responseFormat` and a dropped tool; **the case it cannot see** — an input carried in a form the provider would reject — pinned so silence is never read as safety; and a drop joined through provenance to the durable entry id.
- `src/__tests__/media-support.spec.ts` — undeclared targets unscreened (by reference); a declared kind carried and an undeclared one declined; an entire omitted modality declined, and `[]` read the same as omission; a declined image not taking neighbouring text with it; a message emptied by the removal dropped while an already-empty one is left alone; and declines joining provenance to name a durable entry id, over a tree where the filtered list diverges from the indexed one.
- `src/__tests__/provenance.spec.ts` — the alignment invariant (`provenance[i][j]` describes `messages[i].content[j]`) over the trees a divergent walk would go off by one on: cache-hinted sections emitting one part each, an empty section contributing none, no sections at all, mixed blocks, empty content; plus the timeline message id rather than a position, `undefined` for a system part, `entryId` omitted rather than invented for an id-less entry, out-of-range lookups returning `undefined`, and out-of-range lookups returning `undefined`.
- `src/__tests__/narration-injection.spec.ts` — `_summary` injected when enabled, never in `required`, skipped on the app-level off-switch, on `annotations.narrate: false`, and on an author-owned `_summary`; source schema never mutated; dispatch-only tools dropped.
- `src/__tests__/cache-hints.spec.ts` — message-level cache hints carried, unhinted sections keeping the joined system blob, and a hinted section switching the system message to per-section parts.
- `src/__tests__/model-info.spec.ts` — longest-prefix resolution, `mergeRegistry` layering, the adopter > self > seed precedence in every direction, `undefined` when no layer knows the model, utilization ratio and clamping, token estimation, single-source pricing parity, and distinct rows per serving provider for the same underlying model.
- `src/__tests__/pricing.spec.ts` — longest-prefix pricing, fresh/cached/write rate splitting, rate fallbacks, table layering, `mergeUsageStats` optional-field handling, and the explicit-table > `target.pricing` > seed order.
- `src/__tests__/message-sources-rollup.spec.ts` — `defaultFinalizeStream` deduping a source cited in two blocks and unioning distinct sources across blocks.
- `src/__tests__/source-interner.spec.ts` — turn-stable ids in first-seen order, dedupe by URL and by document index, distinct interning with no natural key.
- `src/__tests__/stream-tag-parser.spec.ts` — passthrough, attribute parsing, self-closing tags, tags split across chunks, handler callbacks, multiple registered tags, and flush of incomplete or unclosed tags.
- Custom blocks and per-provider `responseFormat` translation are covered in the provider packages' executor suites; the request-interception path in [@agentick/model-executor](../model-executor).
