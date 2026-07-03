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
 * const app = await createApp(<Agent />, { executor: openai("gpt-4o") });
 * ```
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

import { OpenAI, type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionChunk,
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { FunctionDefinition } from "openai/resources/shared";

import {
  type CustomBlockDefinition,
  type DeltaTransform,
  type LanguageModelAdapter,
  type StreamAccumulatorView,
  StreamTagParser,
  type StreamTagHandler,
  thinkTagTransform,
} from "@agentick/model-next";
import type {
  AdapterDelta,
  ContentBlock,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelStopReason,
  LanguageModelTool,
  NormalizeInput,
  ToolCall,
} from "@agentick/spec-next";
import { SPEC_VERSION } from "@agentick/spec-next";

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
declare module "@agentick/spec-next" {
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
   * {@link import("@agentick/spec-next").ProviderClientOptions} slot.
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
   * `app.events({surface: "executor", phase: "delta"})` or via the
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
}

// Re-export from @agentick/executor-next so adopters that import from
// @agentick/model-openai-next keep the same surface.
export type { CustomBlockDefinition } from "@agentick/model-next";

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
 * adapter is accepted — the app's `executor:` slot (wrapped in the ONE
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
  const target: ExecutionTarget = options.target ?? {
    kind: "language-model",
    provider: "openai",
    modelId: model ?? "gpt-4o-mini",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };

  let clientMemo: OpenAI | undefined = options.client;
  const client = (): OpenAI => (clientMemo ??= new OpenAI(buildClientOptions(options)));

  return {
    provider: "openai",
    target,
    streamByDefault: options.stream ?? false,
    ...(customBlocks !== undefined ? { customBlocks } : {}),

    buildParams(input: LanguageModelInput, target: ExecutionTarget): ChatCompletionCreateParams {
      return toOpenAIParams(input, target, defaultModel);
    },

    call(params: unknown, signal: AbortSignal | undefined): Promise<ChatCompletion> {
      return client().chat.completions.create(
        { ...(params as ChatCompletionCreateParams), stream: false },
        { signal },
      ) as unknown as Promise<ChatCompletion>;
    },

    openStream(
      params: unknown,
      signal: AbortSignal | undefined,
    ): Promise<AsyncIterable<ChatCompletionChunk>> {
      const cp = params as ChatCompletionCreateParams;
      return client().chat.completions.create(
        { ...cp, stream: true, stream_options: { include_usage: true } },
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
  };
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

  const tools = input.tools && input.tools.length > 0 ? input.tools.map(toOpenAITool) : undefined;

  const params: ChatCompletionCreateParams = {
    model: defaultModel ?? "gpt-4o-mini",
    messages,
  };
  const p = input.parameters;
  if (p?.temperature !== undefined) params.temperature = p.temperature;
  if (p?.maxOutputTokens !== undefined) params.max_tokens = p.maxOutputTokens;
  if (p?.topP !== undefined) params.top_p = p.topP;
  if (p?.frequencyPenalty !== undefined) params.frequency_penalty = p.frequencyPenalty;
  if (p?.presencePenalty !== undefined) params.presence_penalty = p.presencePenalty;
  if (p?.stopSequences !== undefined) params.stop = p.stopSequences as string[];
  if (tools && tools.length > 0) {
    params.tools = tools;
    params.tool_choice = "auto";
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
  // Adopter escape hatch — spread provider-specific options after canonical
  // mapping. Lets callers set logprobs, seed, store, n, prediction, etc.
  // without us hardcoding every OpenAI knob.
  const overrides = target.providerOptions?.openai;
  if (overrides && typeof overrides === "object") {
    Object.assign(params, overrides);
  }
  return params;
}

function toOpenAIMessages(m: LanguageModelMessage): ChatCompletionMessageParam[] {
  // Tool result messages must go on their own `role: "tool"` entry.
  const toolResults: ChatCompletionMessageParam[] = [];
  const textParts: { type: "text"; text: string }[] = [];
  const imageParts: {
    type: "image_url";
    image_url: { url: string };
  }[] = [];
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
      case "image":
        imageParts.push({
          type: "image_url",
          image_url: { url: part.imageUrl },
        });
        break;
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

  if (m.role === "tool") return toolResults;

  if (
    toolResults.length > 0 &&
    textParts.length === 0 &&
    imageParts.length === 0 &&
    toolCalls.length === 0
  ) {
    return toolResults;
  }

  const content: ChatCompletionMessageParam["content"] =
    imageParts.length === 0
      ? textParts.map((p) => p.text).join("") || null
      : ([...textParts, ...imageParts] as unknown as Exclude<
          ChatCompletionMessageParam["content"],
          string | null
        >);

  const base = { role: m.role, content } as ChatCompletionMessageParam;
  if (toolCalls.length > 0 && m.role === "assistant") {
    (base as { tool_calls?: typeof toolCalls }).tool_calls = toolCalls;
  }
  if (m.name !== undefined) {
    (base as { name?: string }).name = m.name;
  }
  const out: ChatCompletionMessageParam[] = [base];
  if (toolResults.length > 0) out.push(...toolResults);
  return out;
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

// ============================================================================
// IR projection — identical to FakeLanguageModelExecutor (kept local so the
// adapter does not depend on @agentick/executor-next).
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
      ...(raw.usage?.prompt_tokens_details?.cached_tokens !== undefined
        ? { cachedInputTokens: raw.usage.prompt_tokens_details.cached_tokens }
        : {}),
    },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw,
  };
  return result;
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
