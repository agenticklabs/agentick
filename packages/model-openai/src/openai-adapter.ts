/**
 * `openai(model?, options?)` — the OpenAI `LanguageModelAdapter` (ADR 52).
 *
 * A plain Promise/AsyncIterable-shaped object implementing the
 * provider-normalization part consumed by `LanguageModelExecutor`.
 * Zero Effect, zero substrate — the executor harness owns
 * orchestration; this factory owns exactly the OpenAI dialect:
 *
 *   - `buildParams` — canonical `LanguageModelInput` →
 *     `ChatCompletionCreateParams` (+ providerOptions escape hatch).
 *   - `call` / `openStream` — the SDK calls (non-streaming /
 *     streaming with usage trailer).
 *   - `mapChunk` — `ChatCompletionChunk` → typed `AdapterDelta`s,
 *     deriving open-block state from the accumulator view and
 *     stashing provider-private fields (id/created/finish_reason)
 *     in `providerExtra`.
 *   - `reconstructRaw` / `normalize` — synthesize the canonical
 *     `ChatCompletion` from final stream state, then parse it into
 *     `LanguageModelExecutionResult` with stop-reason mapping.
 *   - Tag routing (`parseThinkTags`, `customBlocks`) via
 *     `adapterTransforms` (streaming) + `postProcessForNormalize`
 *     (non-streaming parity).
 *
 * ```ts
 * const app = await createApp(<Agent />, { model: openai("gpt-4o") });
 * ```
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

import { OpenAI, type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessage,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { FunctionDefinition } from "openai/resources/shared";

import {
  createSourceInterner,
  defineLanguageModelAdapter,
  lowerSemanticRole,
  type CustomBlockDefinition,
  type DeltaTransform,
  type LanguageModelAdapter,
  type SourceInterner,
  type StreamAccumulatorView,
  StreamTagParser,
  type StreamTagHandler,
  thinkTagTransform,
} from "@agentick/model";
import type {
  AdapterDelta,
  Citation,
  ContentBlock,
  ExecuteInput,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelMessageRole,
  LanguageModelStopReason,
  LanguageModelTool,
  MediaSource,
  NormalizeInput,
  ProviderOptions,
  RateCard,
  Source,
  TextBlock,
  ToolCall,
} from "@agentick/spec";
import { mergeProviderOptions, SPEC_VERSION } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

// ============================================================================
// ProviderOptions augmentation — typed OpenAI escape hatch
// ============================================================================

/**
 * All three v2 provider-option tiers contributed at once via the
 * SDK's actual types — no hand-rolled subsets.
 *
 * - `ProviderClientOptions["openai"]`: {@link ClientOptions} — every
 *   field the SDK's `OpenAI` constructor accepts (apiKey, baseURL,
 *   organization, project, defaultHeaders, timeout, maxRetries,
 *   fetch, httpAgent, …).
 *
 * - `ProviderOptions["openai"]`: `Partial<ChatCompletionCreateParams>`
 *   — every field the SDK accepts on the Chat Completions request
 *   body (seed, logprobs, top_logprobs, store, n, user, metadata,
 *   parallel_tool_calls, service_tier, prediction, reasoning_effort,
 *   modalities, web_search_options, …). Spread last onto the
 *   request body so executor-projected canonical knobs can be
 *   overridden. Fields the executor controls structurally and
 *   SHOULD NOT be set via providerOptions: `model`, `messages`,
 *   `tools`, `tool_choice` (declared via spec), `stream`.
 *
 * - `ProviderToolOptions["openai"]`: per-tool function-definition
 *   overrides (e.g. `strict: true` for JSON-schema mode, custom
 *   `parameters`). Merged into the tool's inner `function` object.
 */
declare module "@agentick/spec" {
  interface ProviderClientOptions {
    readonly openai?: ClientOptions;
  }
  interface ProviderOptions {
    readonly openai?: Partial<ChatCompletionCreateParams>;
  }
  interface ProviderToolOptions {
    readonly openai?: Partial<FunctionDefinition>;
  }
}

// ============================================================================
// Construction options
// ============================================================================

export interface OpenAIAdapterOptions {
  /**
   * SDK client construction options — every field `openai`'s `OpenAI`
   * constructor accepts (apiKey, baseURL, organization, project,
   * defaultHeaders, timeout, maxRetries, fetch, httpAgent, …). Typed
   * via the augmentable
   * {@link import("@agentick/spec").ProviderClientOptions} slot.
   * Ignored when `client` is supplied.
   *
   * Env-var fallbacks (`OPENAI_API_KEY`, `OPENAI_BASE_URL`,
   * `OPENAI_ORGANIZATION`) are applied at construction time for any
   * field not present here.
   */
  readonly clientOptions?: ClientOptions;
  /**
   * Inject a pre-built `OpenAI` client. Useful for tests (stub the SDK)
   * and for advanced setups (custom dispatcher, mTLS, etc.). When set,
   * `clientOptions` is ignored.
   */
  readonly client?: OpenAI;
  /**
   * Stream every `execute()`. When false (default), uses non-streaming
   * completions and delta envelopes are not emitted. When true, every
   * call streams and per-chunk `executor:delta` envelopes are emitted
   * via `emitDeltaLazy`.
   */
  readonly stream?: boolean;
  /**
   * Parse inline `<think>...</think>` tags from `delta.content` and
   * route them as reasoning deltas. For OpenAI-compatible servers
   * (LM Studio, ollama, some quantized local models) that don't
   * extract reasoning server-side and instead emit raw tags in the
   * content channel. Defaults to `false` — adopters whose server
   * exposes reasoning via the standard `reasoning_content` /
   * `reasoning` fields (vLLM, LM Studio recent builds) get reasoning
   * extraction automatically via {@link mapChunkToAdapterDeltas}
   * without enabling this option.
   */
  readonly parseThinkTags?: boolean;
  /**
   * Adopter-declared XML-like tags to extract from the model's text
   * output. Used for structured outputs the adopter wants surfaced
   * separately from the text channel — citations, semantic
   * annotations, completion markers, etc.
   *
   * The tags get stripped from the cleaned text stream and surfaced
   * as `custom-block-*` `AdapterDelta` events. Adopters subscribe via
   * `app.events({surface: "model", phase: "delta"})` or via the
   * session's typed stream handle.
   *
   * Built on the same {@link StreamTagParser} primitive as
   * `parseThinkTags` — adopters can use both simultaneously.
   *
   * @example
   * ```ts
   * customBlocks: {
   *   citation: {},               // pass-through
   *   done: { onSelfClosing: () => stop() },  // <done/> hook
   *   debug: { tag: "debug-info" },           // map key → XML tag
   * }
   * ```
   */
  readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;
  /**
   * Override the self-described target. Defaults to
   * `{ kind: "language-model", provider: "openai", modelId: options.model ?? "gpt-4o-mini", capabilities: {...} }`.
   * Set this when surfacing a non-stock OpenAI-compatible endpoint
   * (vLLM, LM Studio, ollama) or to advertise additional capabilities.
   */
  readonly target?: ExecutionTarget;
  /**
   * Adopter-supplied rates for this model. Lands on
   * {@link ExecutionTarget.rates}, so it rides the per-tick `<Model>`
   * cascade with no extra plumbing. Applied over an explicit `target`
   * too — declaring one must not silently drop the rates.
   *
   * The framework ships NO prices: without a card the tick is UNPRICED,
   * which rolls up as explicitly unpriced rather than as zero.
   *
   * @see docs/proposals/v2/usage-cost.md §4.2
   */
  readonly rates?: RateCard;
  /**
   * Provider knobs applied to EVERY call this adapter makes. Lands on
   * {@link ExecutionTarget.providerOptions}, so it rides the per-tick
   * `<Model>` cascade with no extra plumbing, and folds OVER an explicit
   * `target`'s own bag — declaring one must not silently drop the knobs.
   *
   * The bag is OPAQUE: never validated or interpreted, spread last onto
   * the request. Folded by the canonical `mergeProviderOptions`
   * (per-namespace, one level deep, patch wins), so precedence reads
   * `<model providerOptions>` (tree) > this > `target.providerOptions`.
   * A per-call `SendInput.target` REPLACES the target, bag included.
   *
   * @example
   * ```ts
   * openai("gpt-5", { providerOptions: { openai: { reasoning_effort: "high" } } });
   * ```
   */
  readonly providerOptions?: ProviderOptions;
}

// Re-export from @agentick/model-executor so adopters that import from
// @agentick/model-openai keep the same surface.
export type { CustomBlockDefinition } from "@agentick/model";

// ============================================================================
// Internals
// ============================================================================

const SPEC_VERSION_LITERAL = SPEC_VERSION;

const STOP_REASON_MAP: Record<string, LanguageModelStopReason> = {
  stop: "end",
  length: "max_tokens",
  content_filter: "content_filter",
  tool_calls: "tool_use",
  function_call: "tool_use",
};

// ============================================================================
// openai() — the adapter factory
// ============================================================================

/**
 * Provider-private state the adapter stashes on the
 * `StreamAccumulatorView.providerExtra` slot during `mapChunk`. Read back
 * inside `reconstructRaw` to synthesize the canonical
 * `ChatCompletion`.
 */
interface OpenAIStreamState {
  id: string;
  created: number;
  finishReason: ChatCompletion["choices"][0]["finish_reason"] | null;
}

const RESERVED_REASONING_BLOCK_INDEX = -1; // OpenAI emits reasoning BEFORE text (index 0).

/**
 * Construct the OpenAI `LanguageModelAdapter`. Pass it wherever an
 * adapter is accepted — the app's `modelExecutor:` slot (wrapped in the ONE
 * `LanguageModelExecutor`), `generate({ model: openai("gpt-4o"), ... })`,
 * or a hand-constructed executor:
 *
 * ```ts
 * new LanguageModelExecutor(scopeId, journal, bus, inbox, {
 *   adapter: openai("gpt-4o", { parseThinkTags: true }),
 * });
 * ```
 *
 * The SDK client is constructed lazily on first use, so declaring the
 * adapter in config does not require `OPENAI_API_KEY` to be present
 * until a call actually happens (inject `options.client` to bypass).
 */
export function openai(
  model?: string,
  options: OpenAIAdapterOptions = {},
): LanguageModelAdapter<ChatCompletion, ChatCompletionChunk> {
  const defaultModel = model;
  const parseThinkTags = options.parseThinkTags ?? false;
  const customBlocks = options.customBlocks;
  const baseTarget: ExecutionTarget = options.target ?? {
    kind: "language-model",
    provider: "openai",
    modelId: model ?? "gpt-4o-mini",
    capabilities: {
      supportsTools: true,
      supportsStreaming: true,
      supportsJsonSchema: true,
      // Chat Completions, and the three modalities diverge — which is precisely
      // why the declaration is per-modality rather than one `supportsVision`
      // boolean. `image_url` takes a URL or an inline data URI; a `file` part
      // takes inline base64 or a Files API `file_id` but has NO url form;
      // `input_audio` takes base64 only. Video has no Chat Completions part at
      // all, so it is absent.
      media: {
        image: ["url", "base64"],
        document: ["base64", "reference"],
        audio: ["base64"],
      },
    },
  };
  // `rates` and `providerOptions` layer OVER the resolved target, explicit
  // or default. An adopter who overrides the target is describing
  // capabilities and ids, not waiving the price card or the provider knobs —
  // swallowing either there would make every tick silently unpriced /
  // un-configured. The bag folds through the canonical merge so an explicit
  // target's own namespaces survive under the factory's.
  const target: ExecutionTarget = {
    ...baseTarget,
    ...omitUndefined({
      rates: options.rates,
      providerOptions: mergeProviderOptions(baseTarget.providerOptions, options.providerOptions),
    }),
  };

  let clientMemo: OpenAI | undefined = options.client;
  const client = (): OpenAI => (clientMemo ??= new OpenAI(buildClientOptions(options)));

  return defineLanguageModelAdapter<
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionCreateParams
  >({
    provider: "openai",
    target,
    streamByDefault: options.stream ?? false,
    ...(customBlocks !== undefined ? { customBlocks } : {}),

    prepareRequest(input: ExecuteInput<LanguageModelInput>): ChatCompletionCreateParams {
      return toOpenAIParams(input.targetInput, input.target, defaultModel);
    },

    send(
      request: ChatCompletionCreateParams,
      signal: AbortSignal | undefined,
    ): Promise<ChatCompletion> {
      return client().chat.completions.create(
        { ...request, stream: false },
        { signal },
      ) as unknown as Promise<ChatCompletion>;
    },

    openStream(
      request: ChatCompletionCreateParams,
      signal: AbortSignal | undefined,
    ): Promise<AsyncIterable<ChatCompletionChunk>> {
      return client().chat.completions.create(
        { ...request, stream: true, stream_options: { include_usage: true } },
        { signal },
      ) as unknown as Promise<AsyncIterable<ChatCompletionChunk>>;
    },

    /**
     * Pure chunk → deltas. State (which blocks are open, which tool
     * calls have emitted -start) is derived from the accumulator;
     * OpenAI-specific provider state (id, created, finish_reason) is
     * stashed in `accum.providerExtra` for `reconstructRaw`.
     */
    mapChunk(chunk: ChatCompletionChunk, accum: StreamAccumulatorView): readonly AdapterDelta[] {
      // Capture provider-private fields from the chunk.
      const extra =
        (accum.providerExtra as OpenAIStreamState | undefined) ??
        ((accum.providerExtra = { id: "", created: 0, finishReason: null }),
        accum.providerExtra as OpenAIStreamState);
      if (chunk.id && !extra.id) extra.id = chunk.id;
      if (chunk.created && !extra.created) extra.created = chunk.created;
      if (chunk.choices?.[0]?.finish_reason) extra.finishReason = chunk.choices[0].finish_reason;

      // Reconstruct mapper state from accumulator: text block 0 open if
      // we've seen any text-related events; tool blocks set per callId.
      const textBlockStarted = accum.textByBlock.has(0);
      const toolBlockStartedByIndex = new Set<number>();
      for (const tc of accum.toolCalls.values()) toolBlockStartedByIndex.add(tc.blockIndex);
      const reasoningBlockStarted = accum.reasoningByBlock.has(RESERVED_REASONING_BLOCK_INDEX);

      return mapChunkToAdapterDeltas(chunk, {
        textBlockStarted,
        toolBlockStartedByIndex,
        reasoningBlockStarted,
        reasoningBlockIndex: RESERVED_REASONING_BLOCK_INDEX,
      });
    },

    /**
     * Synthesize a `ChatCompletion` from the final accumulator state.
     * Pulls text/reasoning/tool_calls from the accumulator; pulls
     * id/created/finish_reason from the provider-private slot stashed
     * during `mapChunk`. Usage comes from the accumulator's `usage`
     * (populated by `message-end`'s usage carry — when the provider
     * emits a usage-only trailer chunk, `mapChunk` translates it to a
     * `usage` delta which the executor routes through finalizeStream).
     */
    reconstructRaw(accum: StreamAccumulatorView, modelSeen: string | undefined): ChatCompletion {
      const extra = (accum.providerExtra as OpenAIStreamState | undefined) ?? {
        id: "",
        created: 0,
        finishReason: null,
      };
      const text = accum.textByBlock.get(0) ?? "";
      const reasoning = accum.reasoningByBlock.get(RESERVED_REASONING_BLOCK_INDEX) ?? "";
      const toolCalls = Array.from(accum.toolCalls.values())
        .sort((a, b) => a.blockIndex - b.blockIndex)
        .map((tc) => ({
          id: tc.callId,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.argsBuffer },
        }));

      const message = {
        role: "assistant" as const,
        content: text.length > 0 ? text : null,
        refusal: null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning } : {}),
      } as ChatCompletion["choices"][0]["message"];

      const finish = extra.finishReason ?? "stop";
      const fallbackModel = defaultModel ?? target.modelId;
      return {
        id: extra.id || `chatcmpl-${extra.created || 0}`,
        object: "chat.completion",
        created: extra.created || 0,
        model: modelSeen ?? fallbackModel,
        choices: [
          {
            index: 0,
            message,
            finish_reason: finish,
            logprobs: null,
          },
        ],
        usage: {
          prompt_tokens: accum.usage.inputTokens,
          completion_tokens: accum.usage.outputTokens,
          total_tokens: accum.usage.totalTokens,
          ...(accum.usage.reasoningTokens !== undefined
            ? { completion_tokens_details: { reasoning_tokens: accum.usage.reasoningTokens } }
            : {}),
          ...(accum.usage.cachedInputTokens !== undefined
            ? { prompt_tokens_details: { cached_tokens: accum.usage.cachedInputTokens } }
            : {}),
        },
      } as ChatCompletion;
    },

    /**
     * Tag-routing pipeline: `<think>...</think>` → reasoning deltas when
     * `parseThinkTags` is on. The executor also wires `customBlocks`
     * (the adopter-declared extraction) AFTER this transform.
     */
    adapterTransforms(): readonly DeltaTransform[] {
      return parseThinkTags ? [thinkTagTransform()] : [];
    },

    normalize(raw: ChatCompletion): LanguageModelExecutionResult {
      return normalizeImpl({ targetOutput: raw, target });
    },

    /**
     * Non-streaming + tag routing: when the SDK returned a complete
     * `ChatCompletion` (no stream), the chunk pipeline never ran, so
     * `<think>...</think>` / customBlock tags are still embedded in
     * `message.content`. Run the same `StreamTagParser` here to extract
     * them — mirrors the v1 `applyAdapterTransform` behavior without
     * carrying the old class.
     *
     * Streaming + tag routing is handled by `adapterTransforms()` +
     * `customBlocks` during the chunk pipeline, so this hook is a no-op
     * for the streaming path (which already produced cleaned text).
     */
    postProcessForNormalize(raw: ChatCompletion): ChatCompletion {
      if (!parseThinkTags && !customBlocks) return raw;
      const choice = raw.choices?.[0];
      const message = choice?.message;
      if (!message || typeof message.content !== "string") return raw;
      const cleaned = applyTagsToText(message.content, parseThinkTags, customBlocks);
      if (cleaned === null) return raw;
      const next = {
        ...raw,
        choices: [
          {
            ...choice,
            message: {
              ...message,
              content: cleaned.text.length > 0 ? cleaned.text : null,
              ...(cleaned.reasoning.length > 0 ? { reasoning_content: cleaned.reasoning } : {}),
            },
          },
        ],
      } as ChatCompletion;
      return next;
    },
  });
}

/**
 * Run a single block of text through the same tag-extraction primitives
 * used by the streaming pipeline. Used by `postProcessForNormalize` to
 * keep parity between streaming and non-streaming responses when
 * `parseThinkTags` or `customBlocks` is enabled.
 *
 * Returns `null` when no tag config is active (caller short-circuits).
 */
function applyTagsToText(
  text: string,
  parseThinkTags: boolean,
  customBlocks: Readonly<Record<string, CustomBlockDefinition>> | undefined,
): { text: string; reasoning: string } | null {
  const handlers: Record<string, StreamTagHandler> = {};
  const reasoningTags = new Set<string>();
  if (parseThinkTags) {
    handlers["think"] = {};
    reasoningTags.add("think");
  }
  if (customBlocks) {
    for (const [key, def] of Object.entries(customBlocks)) {
      const tagName = def.tag ?? key;
      const h: StreamTagHandler = {};
      if (def.onStart) h.onStart = def.onStart;
      if (def.onContent) h.onContent = def.onContent;
      if (def.onSelfClosing) h.onSelfClosing = def.onSelfClosing;
      handlers[tagName] = h;
    }
  }
  if (Object.keys(handlers).length === 0) return null;
  const parser = new StreamTagParser({ tags: handlers });
  const events = [...parser.process(text), ...parser.flush()];
  let cleanText = "";
  let reasoning = "";
  // The parser emits BOTH per-chunk `block-delta`s (streaming surface)
  // AND a summary `block` event at close. For the non-streaming
  // post-process path we only want the summary — `block-delta` is the
  // streaming counterpart.
  for (const ev of events) {
    if (ev.type === "text") cleanText += ev.content;
    else if (ev.type === "block" && reasoningTags.has(ev.tag)) reasoning += ev.content;
  }
  return { text: cleanText, reasoning };
}
// ============================================================================
// Client construction
// ============================================================================

function buildClientOptions(opts: OpenAIAdapterOptions): ClientOptions {
  // Env-var fallbacks fill in any field absent from explicit
  // clientOptions. Explicit values win.
  const base: ClientOptions = {};
  const envApiKey = process.env["OPENAI_API_KEY"];
  if (envApiKey !== undefined) base.apiKey = envApiKey;
  const envBaseURL = process.env["OPENAI_BASE_URL"];
  if (envBaseURL !== undefined) base.baseURL = envBaseURL;
  const envOrg = process.env["OPENAI_ORGANIZATION"];
  if (envOrg !== undefined) base.organization = envOrg;
  if (opts.clientOptions !== undefined) {
    return { ...base, ...opts.clientOptions };
  }
  return base;
}

// ============================================================================
// IR → OpenAI params
// ============================================================================

function toOpenAIParams(
  input: LanguageModelInput,
  target: ExecutionTarget,
  defaultModel: string | undefined,
): ChatCompletionCreateParams {
  const messages: ChatCompletionMessageParam[] = [];
  for (const m of input.messages) messages.push(...toOpenAIMessages(m));

  const fnTools = input.tools && input.tools.length > 0 ? input.tools.map(toOpenAITool) : [];
  // Pass D request-half: append this adapter's own provider-EXECUTED tool
  // slice (`provider === "openai"`) onto the native `tools` array. The
  // provider slot is passthrough-by-design — `type`/`config` are OpenAI's
  // own (`{ type: "web_search_preview", ... }`), so map verbatim. Other
  // providers' slices are ignored here (each adapter owns exactly its key).
  const providerTools = buildOpenAIProviderTools(input.providerTools);
  const tools = [...fnTools, ...providerTools];

  const params: ChatCompletionCreateParams = {
    // Per-tick `<Model>` override (ADR 56) flows via `target.modelId` and
    // MUST win over the construction-time default — parity with the
    // Anthropic and Google adapters (both `target.modelId ?? defaultModel
    // ?? DEFAULT_MODEL`). (#214)
    model: target.modelId ?? defaultModel ?? "gpt-4o-mini",
    messages,
  };
  const p = input.parameters;
  if (p?.temperature !== undefined) params.temperature = p.temperature;
  if (p?.maxOutputTokens !== undefined) params.max_tokens = p.maxOutputTokens;
  if (p?.topP !== undefined) params.top_p = p.topP;
  if (p?.frequencyPenalty !== undefined) params.frequency_penalty = p.frequencyPenalty;
  if (p?.presencePenalty !== undefined) params.presence_penalty = p.presencePenalty;
  if (p?.stopSequences !== undefined) params.stop = p.stopSequences as string[];
  if (tools.length > 0) {
    params.tools = tools;
    // `tool_choice: "auto"` governs FUNCTION tools; provider-executed tools
    // are always available and need no choice hint. Gate it on function
    // tools so a provider-tools-only request doesn't set a spurious choice.
    if (fnTools.length > 0) params.tool_choice = "auto";
  }
  if (p?.responseFormat) {
    const rf = p.responseFormat;
    if (rf.type === "text") {
      params.response_format = { type: "text" };
    } else if (rf.type === "json") {
      params.response_format = { type: "json_object" };
    } else if (rf.type === "json_schema" && rf.schema) {
      params.response_format = {
        type: "json_schema",
        json_schema: {
          name: rf.name ?? "response",
          schema: rf.schema,
          strict: true,
        },
      };
    }
  }
  // Canonical toolChoice → OpenAI `tool_choice`. Overrides the "auto" default
  // set above: "auto"/"none"/"required" pass verbatim; `{tool}` names a
  // forced single function call. Provider overrides in `providerOptions.openai`
  // still win (spread last, below).
  if (p?.toolChoice !== undefined) {
    params.tool_choice =
      typeof p.toolChoice === "string"
        ? p.toolChoice
        : { type: "function", function: { name: p.toolChoice.tool } };
  }
  // Adopter escape hatch — spread provider-specific options after canonical
  // mapping. Lets callers set logprobs, seed, store, n, prediction, etc.
  // without us hardcoding every OpenAI knob. `input.providerOptions` (the
  // project-time fold of tree over target, #176) wins over the target's
  // own bag; merged defensively so a direct `buildParams` call with only
  // a target still applies the escape hatch.
  const overrides = mergeProviderOptions(target.providerOptions, input.providerOptions)?.openai;
  if (overrides && typeof overrides === "object") {
    Object.assign(params, overrides);
  }
  return params;
}

/**
 * OpenAI role vocabulary. `developer` is this provider's sanctioned
 * non-user instruction channel and is legal mid-stream, which makes it the
 * right landing for `grounding` — context that is not an instruction to
 * obey and not a human turn. An `event` is a RECORD, not an instruction, so
 * it stays `user` here as it does everywhere; what distinguishes it is the
 * structure in its content, not the role.
 */
const OPENAI_ROLES = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
  grounding: "developer",
  event: "user",
} as const satisfies Record<LanguageModelMessageRole, ChatCompletionMessageParam["role"]>;

function toOpenAIMessages(m: LanguageModelMessage): ChatCompletionMessageParam[] {
  const role = lowerSemanticRole(m.role, OPENAI_ROLES);
  // Tool result messages must go on their own `role: "tool"` entry.
  const toolResults: ChatCompletionMessageParam[] = [];
  const textParts: { type: "text"; text: string }[] = [];
  // Non-text content parts (image / file / input_audio). OpenAI Chat
  // Completions carries them inline in the message `content` array.
  const mediaParts: unknown[] = [];
  const toolCalls: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[] = [];

  for (const part of m.content) {
    switch (part.type) {
      case "text":
        textParts.push({ type: "text", text: part.text });
        break;
      case "image": {
        // The same `…PartFromSource` + skip-on-null shape `document` and `audio` below
        // already used. Image was the one kind that took a pre-flattened string, which
        // is how an adopter `reference` reached the wire as `image_url: { url: "<uuid>" }`.
        const imagePart = openAIImagePartFromSource(part.source, part.mediaType);
        if (imagePart) mediaParts.push(imagePart);
        break;
      }
      case "document": {
        // OpenAI Chat Completions takes documents (e.g. PDFs) as a `file`
        // part: base64 payloads go inline as a data URI with a filename;
        // a Files API reference goes by file_id. No URL document source
        // in Chat Completions — port of v1 openai.ts:565.
        const filePart = openAIFilePartFromSource(part.source, part.mediaType);
        if (filePart) mediaParts.push(filePart);
        break;
      }
      case "audio": {
        // OpenAI takes audio as an `input_audio` part (base64 + format).
        const audioPart = openAIAudioPartFromSource(part.source, part.mediaType);
        if (audioPart) mediaParts.push(audioPart);
        break;
      }
      // TODO(adr-57-followup: openai video + reasoning input): Chat
      // Completions has no native video part and does not accept replayed
      // reasoning as input — dropped for now (no annihilating text bomb).
      case "tool_use":
        toolCalls.push({
          id: part.id,
          type: "function",
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input ?? {}),
          },
        });
        break;
      case "tool_result": {
        const textOnly = part.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("\n");
        toolResults.push({
          role: "tool",
          tool_call_id: part.toolUseId,
          content: textOnly || (part.isError ? "[error]" : "[done]"),
        });
        break;
      }
    }
  }

  if (role === "tool") return toolResults;

  if (
    toolResults.length > 0 &&
    textParts.length === 0 &&
    mediaParts.length === 0 &&
    toolCalls.length === 0
  ) {
    return toolResults;
  }

  const content: ChatCompletionMessageParam["content"] =
    mediaParts.length === 0
      ? textParts.map((p) => p.text).join("") || null
      : ([...textParts, ...mediaParts] as unknown as Exclude<
          ChatCompletionMessageParam["content"],
          string | null
        >);

  const base = { role, content } as ChatCompletionMessageParam;
  if (toolCalls.length > 0 && role === "assistant") {
    (base as { tool_calls?: typeof toolCalls }).tool_calls = toolCalls;
  }
  if (m.name !== undefined) {
    (base as { name?: string }).name = m.name;
  }
  const out: ChatCompletionMessageParam[] = [base];
  if (toolResults.length > 0) out.push(...toolResults);
  return out;
}

/**
 * Project a {@link MediaSource} to OpenAI's `image_url` part.
 *
 * Chat Completions takes a URL or a `data:` URI, so `base64` and `url` both work and
 * everything else is declined: `reference` is the adopter's own file id (the framework
 * cannot resolve it — see `FileReferenceSource`), and `gcs` / `s3` are not schemes
 * OpenAI fetches.
 *
 * OpenAI wanting a URL string on the wire is exactly why the canonical part could carry
 * `imageUrl: string` for so long without anyone noticing: two of four providers happened
 * to want the flattened form. It only broke for a source with no string form.
 *
 * TODO(decline-reporting): the `null` is a verdict that is now OBSERVABLE via
 * `detectDroppedInputs` but still not REPORTED — it reaches no stream, hook or result.
 * See the same marker on `googlePartFromSource`.
 */
function openAIImagePartFromSource(
  source: MediaSource,
  mimeType: string | undefined,
): { type: "image_url"; image_url: { url: string } } | null {
  if (source.type === "url") return { type: "image_url", image_url: { url: source.url } };
  if (source.type === "base64") {
    const mt = source.mimeType ?? mimeType ?? "image/png";
    const url = source.data.startsWith("data:") ? source.data : `data:${mt};base64,${source.data}`;
    return { type: "image_url", image_url: { url } };
  }
  return null;
}

/**
 * Project a document {@link MediaSource} to an OpenAI Chat Completions
 * `file` content part. Ports v1's `openai.ts:565` shape: base64 → inline
 * data URI with a filename; Files API reference → `file_id`. There is no
 * URL document source in Chat Completions — callers stage to base64 or
 * upload for a file_id.
 */
function openAIFilePartFromSource(source: MediaSource, mediaType: string | undefined): unknown {
  switch (source.type) {
    case "base64": {
      const mime = source.mimeType ?? mediaType ?? "application/pdf";
      const fn = source.metadata?.["filename"];
      return {
        type: "file",
        file: {
          filename: typeof fn === "string" ? fn : "document.pdf",
          file_data: `data:${mime};base64,${source.data}`,
        },
      };
    }
    case "reference":
      return { type: "file", file: { file_id: source.fileId } };
    default:
      // url / s3 / gcs are not first-class Chat Completions document
      // sources — TODO(adr-57-followup: openai staged document sources).
      return null;
  }
}

/**
 * Project an audio {@link MediaSource} to an OpenAI `input_audio` part.
 * OpenAI takes base64 audio + a `format` discriminator (wav / mp3).
 */
function openAIAudioPartFromSource(source: MediaSource, mediaType: string | undefined): unknown {
  if (source.type !== "base64") {
    // Only inline base64 audio is a first-class Chat Completions part —
    // TODO(adr-57-followup: openai staged audio sources).
    return null;
  }
  const mime = source.mimeType ?? mediaType ?? "audio/wav";
  const format = mime.includes("mp3") || mime.includes("mpeg") ? "mp3" : "wav";
  return { type: "input_audio", input_audio: { data: source.data, format } };
}

function toOpenAITool(t: LanguageModelTool): ChatCompletionTool {
  const fn: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
  } = {
    name: t.name,
    parameters: t.inputSchema,
  };
  if (t.description !== undefined) fn.description = t.description;
  // Per-tool providerOptions.openai — merge into the function shape so
  // adopters can set `strict: true` etc.
  const overrides = t.providerOptions?.openai;
  if (overrides !== undefined) {
    Object.assign(fn, overrides);
  }
  return { type: "function", function: fn };
}

/**
 * Pass D request-half: map the `provider === "openai"` slice of
 * `input.providerTools` onto OpenAI's native tools-array shape. A provider
 * tool is passthrough — the adopter already wrote OpenAI's own `type` string
 * (`"web_search_preview"`, `"code_interpreter"`, …) and a native `config`
 * bag, so we emit `{ type, ...config }` verbatim (matching the `{ type, … }`
 * discriminated shape OpenAI's provider tools use in `params.tools`). No
 * per-tool knowledge, no schema, no `function` wrapper — that is for
 * dispatchable function tools only. Other providers' slices are ignored.
 */
function buildOpenAIProviderTools(
  providerTools: LanguageModelInput["providerTools"],
): ChatCompletionTool[] {
  if (!providerTools) return [];
  const out: ChatCompletionTool[] = [];
  for (const pt of providerTools) {
    if (pt.provider !== "openai") continue;
    out.push({ type: pt.type, ...pt.config } as unknown as ChatCompletionTool);
  }
  return out;
}

// ============================================================================
// IR projection — identical to FakeLanguageModelExecutor (kept local so the
// adapter does not depend on @agentick/model-executor).
// ============================================================================

// ============================================================================
// ChatCompletion → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput;
  if (!isChatCompletion(raw)) {
    throw new Error("normalize expected ChatCompletion shape");
  }
  const choice = raw.choices?.[0];
  const message = choice?.message;
  if (!message) {
    throw new Error("ChatCompletion missing choices[0].message");
  }

  // Provenance-half (Pass D): this adapter targets Chat Completions. On that
  // surface web-search provenance arrives as `message.annotations`
  // (`url_citation`) — mapped to `Citation[]` on the assistant text block below.
  // Chat Completions does NOT surface provider-executed tool RESULTS as discrete
  // items (that is the Responses API's `web_search_call` / `code_interpreter_call`
  // output items), and `message.tool_calls` only ever carries `type: "function"`
  // dispatchable calls (filtered below) — so there is no handler-less provider
  // call to suppress and no `tool_result` to stamp on this surface.
  //
  // TODO(pass-d): `executedBy: "provider:openai"` on a `tool_result` is
  //   UNREACHABLE from Chat Completions — provider tool results are only exposed
  //   as typed output items on the Responses API, which this adapter does not
  //   target (request-half maps onto `params.tools` for Chat Completions).
  //   Narrowed per HARD RULE — stamped what IS present (citations), TODO the
  //   part the API surface cannot reach.
  const output: ContentBlock[] = [];
  // Reasoning blocks ride before text — OpenAI-compatible servers
  // (vLLM `reasoning_content`, LM Studio `reasoning`) expose
  // chain-of-thought via non-standard message fields. Duck-typed since
  // neither lives in the SDK's typed shape.
  {
    const m = message as unknown as Record<string, unknown>;
    const rc = m.reasoning_content;
    const r = m.reasoning;
    const reasoning = typeof rc === "string" ? rc : typeof r === "string" ? r : undefined;
    if (reasoning !== undefined && reasoning.length > 0) {
      output.push({ type: "reasoning", text: reasoning });
    }
  }
  if (typeof message.content === "string" && message.content.length > 0) {
    output.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part && typeof part === "object" && part.type === "text") {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string" && text.length > 0) {
          output.push({ type: "text", text });
        }
      }
    }
  }

  // Attach web-search url-citations to the assistant text block. Chat
  // Completions annotations index into the single assistant message text, so
  // they hang on the first text block. One interner per normalize (per turn):
  // a URL cited across many spans mints one `Source` with one turn-stable id.
  const interner = createSourceInterner();
  const { citations, sources } = openAIAnnotationsToCitations(message.annotations, interner);
  if (citations.length > 0) {
    const ti = output.findIndex((b) => b.type === "text");
    if (ti >= 0) {
      output[ti] = { ...(output[ti] as TextBlock), citations, sources };
    }
  }

  const toolCalls: ToolCall[] = [];
  const tcs = (message as { tool_calls?: unknown[] }).tool_calls;
  if (Array.isArray(tcs)) {
    for (const tc of tcs) {
      if (!tc || typeof tc !== "object") continue;
      const t = tc as {
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      };
      if (t.type !== "function" || !t.function) continue;
      const name = t.function.name;
      const id = t.id;
      if (!name || !id) continue;
      let parsed: unknown;
      try {
        parsed = t.function.arguments ? JSON.parse(t.function.arguments) : {};
      } catch {
        parsed = t.function.arguments ?? {};
      }
      const inputObj =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed };
      toolCalls.push({ id, name, input: inputObj });
      output.push({
        type: "tool_use",
        toolUseId: id,
        name,
        input: inputObj,
      });
    }
  }

  const stopReason: LanguageModelStopReason = choice?.finish_reason
    ? (STOP_REASON_MAP[choice.finish_reason] ?? "other")
    : "other";

  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION_LITERAL,
    output,
    stopReason,
    usage: {
      inputTokens: raw.usage?.prompt_tokens ?? 0,
      outputTokens: raw.usage?.completion_tokens ?? 0,
      totalTokens: raw.usage?.total_tokens ?? 0,
      ...(raw.usage?.completion_tokens_details?.reasoning_tokens !== undefined
        ? { reasoningTokens: raw.usage.completion_tokens_details.reasoning_tokens }
        : {}),
      ...(raw.usage?.prompt_tokens_details?.cached_tokens !== undefined
        ? { cachedInputTokens: raw.usage.prompt_tokens_details.cached_tokens }
        : {}),
    },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw,
  };
  return result;
}

/**
 * Pass D provenance-half: map Chat Completions `message.annotations`
 * (`url_citation`, emitted by the web-search tool) onto canonical
 * {@link Citation}. Each annotation carries `{ url, title, start_index,
 * end_index }` where the indices are a char span in the assistant message text
 * → {@link Citation.range}; `url` + `title` form the referenced {@link Source}
 * (minted / deduped via the turn-scoped `interner`). The block's referenced
 * `Source` entities are returned alongside for the caller to attach as
 * {@link BaseContentBlock.sources}.
 */
function openAIAnnotationsToCitations(
  annotations: ChatCompletionMessage["annotations"],
  interner: SourceInterner,
): { citations: Citation[]; sources: Source[] } {
  if (!annotations || annotations.length === 0) return { citations: [], sources: [] };
  const out: Citation[] = [];
  const blockSources = new Map<string, Source>();
  for (const a of annotations) {
    if (a.type !== "url_citation") continue;
    const uc = a.url_citation;
    const source = interner.intern({
      ...(uc.url ? { url: uc.url } : {}),
      ...(uc.title ? { title: uc.title } : {}),
    });
    blockSources.set(source.id, source);
    out.push({ sourceId: source.id, range: { start: uc.start_index, end: uc.end_index } });
  }
  return { citations: out, sources: [...blockSources.values()] };
}

function isChatCompletion(v: unknown): v is ChatCompletion {
  if (!v || typeof v !== "object") return false;
  const o = v as { choices?: unknown };
  return Array.isArray(o.choices);
}

/**
 * 1:1 translation of an OpenAI `ChatCompletionChunk` to zero-or-more
 * typed `AdapterDelta` events. State-aware: tracks whether a text
 * content block has been opened, and whether each tool-call slot has
 * been opened. The caller maintains the state across chunks.
 */
function mapChunkToAdapterDeltas(
  chunk: ChatCompletionChunk,
  state: {
    textBlockStarted: boolean;
    toolBlockStartedByIndex: Set<number>;
    reasoningBlockStarted: boolean;
    reasoningBlockIndex: number;
  },
): AdapterDelta[] {
  const out: AdapterDelta[] = [];
  // Usage carry — OpenAI emits the final `usage` on the same chunk that
  // carries `finish_reason` (with `delta: {}`). Always emit when present;
  // the accumulator overwrites with last-write-wins so duplicates are
  // safe (only the final chunk should carry usage anyway).
  if (chunk.usage) {
    out.push({
      type: "usage",
      usage: {
        inputTokens: chunk.usage.prompt_tokens ?? 0,
        outputTokens: chunk.usage.completion_tokens ?? 0,
        totalTokens: chunk.usage.total_tokens ?? 0,
        ...(chunk.usage.completion_tokens_details?.reasoning_tokens !== undefined
          ? { reasoningTokens: chunk.usage.completion_tokens_details.reasoning_tokens }
          : {}),
        ...(chunk.usage.prompt_tokens_details?.cached_tokens !== undefined
          ? { cachedInputTokens: chunk.usage.prompt_tokens_details.cached_tokens }
          : {}),
      },
    });
  }
  const choice = chunk.choices?.[0];
  if (!choice) return out;
  const delta = choice.delta;
  if (delta) {
    // Reasoning content — OpenAI-compatible servers expose chain-of-thought
    // via non-standard fields: vLLM uses `reasoning_content`, LM Studio
    // uses `reasoning`. v1 surfaces this through reasoning deltas; we do
    // the same. Both fields are duck-typed since they aren't in the
    // OpenAI SDK's typed shape.
    const reasoningChunk = ((): string | undefined => {
      const d = delta as unknown as Record<string, unknown>;
      const rc = d.reasoning_content;
      if (typeof rc === "string" && rc.length > 0) return rc;
      const r = d.reasoning;
      if (typeof r === "string" && r.length > 0) return r;
      return undefined;
    })();
    if (reasoningChunk !== undefined) {
      if (!state.reasoningBlockStarted) {
        out.push({ type: "reasoning-start", blockIndex: state.reasoningBlockIndex });
      }
      out.push({
        type: "reasoning-delta",
        blockIndex: state.reasoningBlockIndex,
        delta: reasoningChunk,
      });
    }
    if (typeof delta.content === "string" && delta.content.length > 0) {
      if (!state.textBlockStarted) {
        out.push({ type: "content-start", blockIndex: 0, blockType: "text" });
      }
      out.push({ type: "content-delta", blockIndex: 0, delta: delta.content });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (tc.function?.name && !state.toolBlockStartedByIndex.has(idx)) {
          out.push({
            type: "tool-call-start",
            callId: tc.id ?? `tc_${idx}`,
            name: tc.function.name,
            blockIndex: idx,
          });
        }
        if (typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0) {
          out.push({
            type: "tool-call-delta",
            callId: tc.id ?? `tc_${idx}`,
            delta: tc.function.arguments,
          });
        }
      }
    }
  }
  // We don't emit message-end here — the streaming loop emits it from
  // the accumulator after the iterator completes (so usage is final).
  return out;
}
