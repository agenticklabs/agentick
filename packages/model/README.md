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
        { type: "image", imageUrl: "https://example.com/chart.png" },
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

A `MediaSource` is `base64` | `url` | `reference` (provider file id) | `s3` | `gcs`. Replayed model output round-trips through the same set: a `generated_image` block projects back to an `image` part as a data URI, a `generated_file` to a `document` with a URL source. Per-provider support is documented in each adapter's README.

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

The parts are exported individually so a custom projection stays aligned with the canonical one: `buildMessages`, `buildTools`, `buildProviderTools`, `buildParameters`, `collectSectionText`, `sectionText`, `messagePartFromBlock`, `imageUrlFromSource`.

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
| `messagePartFromBlock` / `imageUrlFromSource` / `sectionText` / `collectSectionText`         | Projection leaves                              |
| `createSourceInterner`                                                                       | Per-turn one-source-one-id registry            |
| `SEED_MODELS` / `resolveModelInfo` / `mergeRegistry` / `effectiveModelInfo`                  | The model registry                             |
| `contextUtilization` / `estimateTokens`                                                      | Window ratio and token estimation              |
| `SEED_PRICING` / `resolvePricing` / `mergePricing` / `estimateCost` / `mergeUsageStats`      | Cost accounting                                |

Types: `LanguageModelAdapter`, `LanguageModelAdapterDefinition`, `StreamAccumulatorView`, `AccumToolCall`, `DeltaTransform`, `CustomBlockDefinition`, `StreamTagHandler` / `StreamTagParserConfig` / `StreamTagEvent`, `GenerateOptions`, `GenerateObjectOptions` / `GenerateObjectResult`, `RetryOptions`, `ModelTap`, `SourceInterner`, `ModelInfo` / `ModelPricing` / `ModelRegistry`, `PricingTable` / `CostEstimate`.

### `@agentick/model/testing`

| Export                     | Purpose                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------ |
| `scriptedAdapter(text, ?)` | Scripted adapter double — chunk scripting, failure scripting, `calls()` / `seenParams()` introspection |

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
- **`customBlockTransform` has no suite here.** It is exercised through the provider packages' executor tests; `StreamTagParser` beneath it is pinned directly.

## Verified by

- `src/__tests__/generate.spec.ts` — the `prepareRequest → send → normalize` round trip, `postProcessForNormalize`, the streaming delta vocabulary, the adapter transform pipeline (think tags → reasoning), and result rejection when the provider stream throws.
- `src/__tests__/generate-object.spec.ts` — `responseFormat` wiring, a raw `jsonSchema()` carried through, the typed validated object, and `GenerateObjectError` on both non-JSON output and schema violation.
- `src/__tests__/combinators.spec.ts` — retry of transient failures and of the stream open, non-retry of non-transient causes, failover to a secondary with the serving adapter's `normalize`, streaming failover through the secondary's `mapChunk`, never-on-abort, exhausted chains, composition of retry with failover, tap transparency with swallowed tap errors, and the transient classifier.
- `src/__tests__/canonical-projection.spec.ts` — wire-native modality parts, the `generated_image` data-URI regression, resource projection, `providerMetadata → providerOptions` on parts and on messages, the tree-over-target `providerOptions` fold, `buildParameters` lifting the generation knobs and `toolChoice`, and `buildProviderTools` name resolution, dedupe, empty-slot omission, and exclusion from the function tools list.
- `src/__tests__/narration-injection.spec.ts` — `_summary` injected when enabled, never in `required`, skipped on the app-level off-switch, on `annotations.narrate: false`, and on an author-owned `_summary`; source schema never mutated; dispatch-only tools dropped.
- `src/__tests__/cache-hints.spec.ts` — message-level cache hints carried, unhinted sections keeping the joined system blob, and a hinted section switching the system message to per-section parts.
- `src/__tests__/model-info.spec.ts` — longest-prefix resolution, `mergeRegistry` layering, the adopter > self > seed precedence in every direction, `undefined` when no layer knows the model, utilization ratio and clamping, token estimation, single-source pricing parity, and distinct rows per serving provider for the same underlying model.
- `src/__tests__/pricing.spec.ts` — longest-prefix pricing, fresh/cached/write rate splitting, rate fallbacks, table layering, `mergeUsageStats` optional-field handling, and the explicit-table > `target.pricing` > seed order.
- `src/__tests__/message-sources-rollup.spec.ts` — `defaultFinalizeStream` deduping a source cited in two blocks and unioning distinct sources across blocks.
- `src/__tests__/source-interner.spec.ts` — turn-stable ids in first-seen order, dedupe by URL and by document index, distinct interning with no natural key.
- `src/__tests__/stream-tag-parser.spec.ts` — passthrough, attribute parsing, self-closing tags, tags split across chunks, handler callbacks, multiple registered tags, and flush of incomplete or unclosed tags.
- Custom blocks and per-provider `responseFormat` translation are covered in the provider packages' executor suites; the request-interception path in [@agentick/model-executor](../model-executor).
