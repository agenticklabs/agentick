/**
 * `anthropic(model?, options?)` — the Anthropic `LanguageModelAdapter`
 * (ADR 52), backed by the Messages API (`@anthropic-ai/sdk`).
 *
 * A plain Promise/AsyncIterable-shaped object consumed by
 * `LanguageModelExecutor` — zero Effect, zero substrate. Anthropic
 * dialect handled at this layer: system extraction with strict
 * user/assistant alternation (custom `project`), native `thinking` /
 * `redacted_thinking` blocks for reasoning, per-block `cache_control`
 * via providerMetadata, separate `cache_*_input_tokens` usage fields.
 *
 * @see docs/proposals/v2/anthropic-adapter-plan.md
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import type {
  DocumentBlockParam,
  ImageBlockParam,
  Message as AnthropicMessage,
  MessageCreateParams,
  MessageCreateParamsNonStreaming,
  MessageCreateParamsStreaming,
  MessageParam,
  RawMessageStreamEvent,
  RedactedThinkingBlock,
  RedactedThinkingBlockParam,
  TextBlock as AnthropicTextBlock,
  TextBlockParam,
  ThinkingBlock as AnthropicThinkingBlock,
  ThinkingBlockParam,
  Tool as AnthropicTool,
  ToolResultBlockParam,
  ToolUseBlock as AnthropicToolUseBlock,
  ToolUseBlockParam,
  ContentBlockParam,
  Usage,
} from "@anthropic-ai/sdk/resources/messages";

import {
  buildParameters,
  buildTools,
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
  LanguageModelMessagePart,
  LanguageModelStopReason,
  LanguageModelTool,
  MediaSource,
  NormalizeInput,
  ProjectInput,
  ProviderOptions,
  RenderedTree,
  SectionEntry,
  ToolCall,
  UsageStats,
} from "@agentick/spec-next";
import { mergeProviderOptions, SPEC_VERSION } from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

// ============================================================================
// ProviderOptions augmentation — typed Anthropic escape hatch (G5)
// ============================================================================

/**
 * All three v2 provider-option tiers contributed at once via the
 * SDK's actual types — no hand-rolled subsets.
 *
 * - `ProviderClientOptions["anthropic"]`: {@link ClientOptions} —
 *   every field `@anthropic-ai/sdk`'s `Anthropic` constructor
 *   accepts (apiKey, baseURL, authToken, defaultHeaders, timeout,
 *   maxRetries, fetch, httpAgent, …).
 *
 * - `ProviderOptions["anthropic"]`: `Partial<MessageCreateParams>` —
 *   every field the SDK accepts on the Messages request body
 *   (top_k, top_p, stop_sequences, thinking, tool_choice, metadata,
 *   service_tier, mcp_servers, container, …). Spread last onto the
 *   request body so executor-projected canonical knobs can be
 *   overridden. Fields the executor controls structurally and
 *   SHOULD NOT be set via providerOptions: `model`, `messages`,
 *   `system`, `tools`, `max_tokens` (use `maxTokens` constructor
 *   option), `stream`.
 *
 * - `ProviderToolOptions["anthropic"]`: per-tool SDK overrides
 *   (e.g. `cache_control: { type: "ephemeral" }` to mark a specific
 *   tool as a prompt-cache breakpoint).
 *
 * **Per-block `cache_control` lives on `BaseContentBlock.providerMetadata`,
 * not here.** Adopters who want to mark THIS message-block as a
 * cache breakpoint stamp
 * `providerMetadata.anthropic.cacheControl = { type: "ephemeral" }`
 * on the specific {@link ContentBlock}. The executor reads it
 * per-block during projection. No meta-knob policy.
 */
declare module "@agentick/spec-next" {
  interface ProviderClientOptions {
    readonly anthropic?: ClientOptions;
  }
  interface ProviderOptions {
    readonly anthropic?: Partial<MessageCreateParams>;
  }
  interface ProviderToolOptions {
    readonly anthropic?: Partial<AnthropicTool>;
  }
}

// ============================================================================
// Construction options
// ============================================================================

export interface AnthropicAdapterOptions {
  /**
   * SDK client construction options — every field
   * `@anthropic-ai/sdk`'s `Anthropic` constructor accepts (apiKey,
   * baseURL, authToken, defaultHeaders, timeout, maxRetries, fetch,
   * httpAgent, …). Typed via the augmentable
   * {@link import("@agentick/spec-next").ProviderClientOptions} slot.
   * Ignored when `client` is supplied.
   *
   * Env-var fallbacks (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`)
   * are applied at construction time for any field not present here.
   */
  readonly clientOptions?: ClientOptions;
  /** Inject a pre-built Anthropic client (testing, advanced setups). */
  readonly client?: Anthropic;
  /** Default `max_tokens`. Anthropic REQUIRES this. Defaults to 4096. */
  readonly maxTokens?: number;
  /** Whether `run()` streams by default. Per-call wins via the target. */
  readonly stream?: boolean;
  /**
   * Parse inline `<think>...</think>` tags. For Claude, native
   * `thinking` blocks are preferred — this is for the niche case of
   * piping a non-thinking Claude through a pre-prompt eliciting
   * `<think>` artifacts in the text channel.
   */
  readonly parseThinkTags?: boolean;
  /** Adopter-declared XML-like tags to extract (G12). */
  readonly customBlocks?: Readonly<Record<string, CustomBlockDefinition>>;
  /** Override the self-described target. */
  readonly target?: ExecutionTarget;
}

// Re-export from @agentick/executor-next so adopters that import from
// @agentick/model-anthropic-next keep the same surface.
export type { CustomBlockDefinition } from "@agentick/model-next";

// ============================================================================
// Internals
// ============================================================================

const SPEC_VERSION_LITERAL = SPEC_VERSION;
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MODEL = "claude-3-5-sonnet-latest";

// ============================================================================
// anthropic() — the adapter factory
// ============================================================================

/**
 * Provider-private state stashed on `accum.providerExtra` for
 * Anthropic. Tracks per-block kind (so `content_block_stop` can
 * dispatch to the right finalize action), tool callIds keyed by
 * Anthropic's block index (so `input_json_delta` knows which callId
 * to use), and the redacted-thinking opaque data blob.
 */
interface AnthropicStreamState {
  id: string;
  stopSequence: string | null;
  blockKind: Map<number, "text" | "thinking" | "tool_use" | "redacted_thinking">;
  toolCallIdByBlock: Map<number, string>;
  redactedData: Map<number, string>;
}

function getAnthropicState(accum: StreamAccumulatorView): AnthropicStreamState {
  let s = accum.providerExtra as AnthropicStreamState | undefined;
  if (!s) {
    s = {
      id: "",
      stopSequence: null,
      blockKind: new Map(),
      toolCallIdByBlock: new Map(),
      redactedData: new Map(),
    };
    accum.providerExtra = s;
  }
  return s;
}

/**
 * Construct the Anthropic `LanguageModelAdapter`. Pass it wherever an
 * adapter is accepted — the app's `executor:` slot (wrapped in the ONE
 * `LanguageModelExecutor`), `generate({ model:
 * anthropic("claude-sonnet-5"), ... })`, or a hand-constructed
 * executor.
 *
 * The SDK client is constructed lazily on first use, so declaring the
 * adapter does not require `ANTHROPIC_API_KEY` until a call actually
 * happens (inject `options.client` to bypass).
 */
export function anthropic(
  model?: string,
  options: AnthropicAdapterOptions = {},
): LanguageModelAdapter<AnthropicMessage, RawMessageStreamEvent> {
  const defaultModel = model;
  const defaultMaxTokens = options.maxTokens;
  const parseThinkTags = options.parseThinkTags ?? false;
  const customBlocks = options.customBlocks;
  const target: ExecutionTarget = options.target ?? {
    kind: "language-model",
    provider: "anthropic",
    modelId: model ?? DEFAULT_MODEL,
    capabilities: {
      supportsTools: true,
      supportsStreaming: true,
      supportsVision: true,
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    },
  };

  let clientMemo: Anthropic | undefined = options.client;
  const client = (): Anthropic => (clientMemo ??= new Anthropic(buildClientOptions(options)));

  return {
    provider: "anthropic",
    target,
    streamByDefault: options.stream ?? false,
    ...(customBlocks !== undefined ? { customBlocks } : {}),

    project(input: ProjectInput): LanguageModelInput {
      return anthropicProjectImpl(input);
    },

    buildParams(input: LanguageModelInput, target: ExecutionTarget): MessageCreateParams {
      return toAnthropicParams(input, target, defaultModel, defaultMaxTokens);
    },

    call(params: unknown, signal: AbortSignal | undefined): Promise<AnthropicMessage> {
      return client().messages.create(
        { ...(params as MessageCreateParams), stream: false } as MessageCreateParamsNonStreaming,
        { signal },
      ) as unknown as Promise<AnthropicMessage>;
    },

    openStream(
      params: unknown,
      signal: AbortSignal | undefined,
    ): Promise<AsyncIterable<RawMessageStreamEvent>> {
      const cp = params as MessageCreateParams;
      return client().messages.create({ ...cp, stream: true } as MessageCreateParamsStreaming, {
        signal,
      }) as unknown as Promise<AsyncIterable<RawMessageStreamEvent>>;
    },

    /**
     * Translate one Anthropic stream event into AdapterDeltas. Anthropic's
     * vocabulary maps almost 1:1 to ours — `message_start` →
     * `message-start`, `content_block_start`/`_delta`/`_stop` →
     * `content-*` / `reasoning-*` / `tool-call-*` (dispatched on the
     * block kind), `message_delta` carries the final usage/stop_reason
     * into `message-end`. The base's `finalizeStream` emits the assembled
     * `message` summary from accumulator state.
     */
    mapChunk(event: RawMessageStreamEvent, accum: StreamAccumulatorView): readonly AdapterDelta[] {
      const state = getAnthropicState(accum);
      const out: AdapterDelta[] = [];

      switch (event.type) {
        case "message_start": {
          const msg = event.message;
          if (msg.id) state.id = msg.id;
          out.push({ type: "message-start", role: "assistant", model: msg.model });
          const u = msg.usage;
          if (u) {
            out.push({
              type: "usage",
              // Subset semantics (#186): fold cache reads into inputTokens.
              usage: (() => {
                const cached = u.cache_read_input_tokens ?? 0;
                const inputTokens = (u.input_tokens ?? 0) + cached;
                const outputTokens = u.output_tokens ?? 0;
                return {
                  inputTokens,
                  outputTokens,
                  totalTokens: inputTokens + outputTokens,
                  ...(u.cache_read_input_tokens != null ? { cachedInputTokens: cached } : {}),
                };
              })(),
            });
          }
          break;
        }
        case "content_block_start": {
          const block = event.content_block;
          const idx = event.index;
          if (block.type === "text") {
            state.blockKind.set(idx, "text");
            out.push({ type: "content-start", blockIndex: idx, blockType: "text" });
          } else if (block.type === "tool_use") {
            state.blockKind.set(idx, "tool_use");
            state.toolCallIdByBlock.set(idx, block.id);
            out.push({
              type: "tool-call-start",
              callId: block.id,
              name: block.name,
              blockIndex: idx,
            });
          } else if (block.type === "thinking") {
            state.blockKind.set(idx, "thinking");
            out.push({ type: "reasoning-start", blockIndex: idx });
          } else if (block.type === "redacted_thinking") {
            state.blockKind.set(idx, "redacted_thinking");
            state.redactedData.set(idx, (block as RedactedThinkingBlock).data);
            out.push({ type: "reasoning-start", blockIndex: idx });
          }
          break;
        }
        case "content_block_delta": {
          const idx = event.index;
          const delta = event.delta;
          if (delta.type === "text_delta") {
            out.push({ type: "content-delta", blockIndex: idx, delta: delta.text });
          } else if (delta.type === "input_json_delta") {
            const callId = state.toolCallIdByBlock.get(idx) ?? "";
            out.push({
              type: "tool-call-delta",
              callId,
              delta: delta.partial_json,
            });
          } else if (delta.type === "thinking_delta") {
            out.push({ type: "reasoning-delta", blockIndex: idx, delta: delta.thinking });
          }
          // signature_delta + citations_delta: ignored (G3 §10.4/§10.5).
          break;
        }
        case "content_block_stop": {
          const idx = event.index;
          const kind = state.blockKind.get(idx);
          if (kind === "text") {
            out.push({ type: "content-end", blockIndex: idx });
            out.push({
              type: "content",
              blockIndex: idx,
              content: { type: "text", text: accum.textByBlock.get(idx) ?? "" } as ContentBlock,
            });
          } else if (kind === "tool_use") {
            const callId = state.toolCallIdByBlock.get(idx) ?? "";
            const entry = accum.toolCalls.get(callId);
            let parsedInput: Readonly<Record<string, unknown>> = {};
            try {
              parsedInput = entry?.argsBuffer
                ? (JSON.parse(entry.argsBuffer) as Readonly<Record<string, unknown>>)
                : {};
            } catch {
              /* invalid JSON */
            }
            out.push({ type: "tool-call-end", callId });
            out.push({
              type: "tool-call",
              callId,
              name: entry?.name ?? "",
              input: parsedInput,
            });
          } else if (kind === "thinking" || kind === "redacted_thinking") {
            out.push({ type: "reasoning-end", blockIndex: idx });
            out.push({
              type: "reasoning",
              blockIndex: idx,
              reasoning: accum.reasoningByBlock.get(idx) ?? "",
            });
          }
          break;
        }
        case "message_delta": {
          // Carries final stop_reason + last usage update.
          if (event.delta.stop_sequence != null) state.stopSequence = event.delta.stop_sequence;
          const u = event.usage;
          const inputTokens = accum.usage.inputTokens; // already captured at message_start
          out.push({
            type: "message-end",
            stopReason: mapFinishReason(event.delta.stop_reason),
            usage: {
              inputTokens,
              outputTokens: u?.output_tokens ?? accum.usage.outputTokens,
              totalTokens: inputTokens + (u?.output_tokens ?? accum.usage.outputTokens),
              ...omitUndefined({ cachedInputTokens: accum.usage.cachedInputTokens }),
            },
          });
          break;
        }
        case "message_stop":
          // Final wire frame — no delta needed, base finalize emits `message`.
          break;
      }
      return out;
    },

    /**
     * Synthesize the canonical AnthropicMessage from accumulator state.
     * Iterates blocks by index (text → text, thinking → thinking,
     * tool_use → tool_use, redacted_thinking → redacted_thinking from the
     * private slot) and reassembles a structure normalize() can consume.
     */
    reconstructRaw(accum: StreamAccumulatorView, modelSeen: string | undefined): AnthropicMessage {
      const state = getAnthropicState(accum);
      const content: AnthropicMessage["content"] = [];
      const allBlockIndices = new Set<number>([
        ...accum.textByBlock.keys(),
        ...accum.reasoningByBlock.keys(),
        ...Array.from(accum.toolCalls.values()).map((c) => c.blockIndex),
        ...state.redactedData.keys(),
      ]);
      const sorted = [...allBlockIndices].sort((a, b) => a - b);
      for (const idx of sorted) {
        const kind = state.blockKind.get(idx);
        if (kind === "redacted_thinking") {
          content.push({
            type: "redacted_thinking",
            data: state.redactedData.get(idx) ?? "",
          } as RedactedThinkingBlock);
          continue;
        }
        if (kind === "thinking" || accum.reasoningByBlock.has(idx)) {
          content.push({
            type: "thinking",
            thinking: accum.reasoningByBlock.get(idx) ?? "",
            signature: "",
          } as AnthropicThinkingBlock);
          continue;
        }
        const tc = [...accum.toolCalls.values()].find((c) => c.blockIndex === idx);
        if (tc) {
          let parsed: unknown = {};
          try {
            parsed = tc.argsBuffer ? JSON.parse(tc.argsBuffer) : (tc.input ?? {});
          } catch {
            parsed = tc.input ?? {};
          }
          content.push({
            type: "tool_use",
            id: tc.callId,
            name: tc.name,
            input: parsed,
          } as AnthropicToolUseBlock);
          continue;
        }
        if (accum.textByBlock.has(idx)) {
          const text = accum.textByBlock.get(idx) ?? "";
          if (text.length > 0) {
            content.push({
              type: "text",
              text,
              citations: null,
            } as AnthropicTextBlock);
          }
        }
      }

      const fallbackModel = defaultModel ?? target.modelId;
      return {
        id: state.id || `msg_anthropic`,
        type: "message",
        role: "assistant",
        model: modelSeen ?? fallbackModel,
        content,
        stop_reason: mapBackStopReason(accum.stopReason),
        stop_sequence: state.stopSequence,
        usage: {
          // Back-map subset semantics to Anthropic's disjoint wire shape.
          input_tokens: accum.usage.inputTokens - (accum.usage.cachedInputTokens ?? 0),
          output_tokens: accum.usage.outputTokens,
          cache_read_input_tokens: accum.usage.cachedInputTokens ?? null,
          cache_creation_input_tokens: null,
        },
      } as AnthropicMessage;
    },

    adapterTransforms(): readonly DeltaTransform[] {
      return parseThinkTags ? [thinkTagTransform()] : [];
    },

    normalize(raw: AnthropicMessage): LanguageModelExecutionResult {
      return normalizeImpl({ targetOutput: raw, target });
    },

    /**
     * Non-streaming + tag routing: streaming path's transforms didn't
     * run, so extract tags from the message's text blocks here. Mirrors
     * the OpenAI executor's postProcessForNormalize.
     */
    postProcessForNormalize(raw: AnthropicMessage): AnthropicMessage {
      if (!parseThinkTags && !customBlocks) return raw;
      if (!Array.isArray(raw.content)) return raw;
      const newContent: AnthropicMessage["content"] = [];
      let reasoningCarry = "";
      for (const block of raw.content) {
        if (block.type === "text") {
          const cleaned = applyTagsToText(block.text, parseThinkTags, customBlocks);
          if (cleaned) {
            reasoningCarry += cleaned.reasoning;
            if (cleaned.text.length > 0) {
              newContent.push({
                type: "text",
                text: cleaned.text,
                citations: (block as AnthropicTextBlock).citations ?? null,
              } as AnthropicTextBlock);
            }
          } else {
            newContent.push(block);
          }
        } else {
          newContent.push(block);
        }
      }
      if (reasoningCarry.length > 0) {
        newContent.unshift({
          type: "thinking",
          thinking: reasoningCarry,
          signature: "",
        } as AnthropicThinkingBlock);
      }
      return { ...raw, content: newContent } as AnthropicMessage;
    },
  };
}

/**
 * Map our canonical stop reasons back to Anthropic's enum for the
 * synthesized AnthropicMessage. The forward mapping (anthropic →
 * canonical) lives in `mapFinishReason`.
 */
function mapBackStopReason(reason: LanguageModelStopReason): AnthropicMessage["stop_reason"] {
  switch (reason) {
    case "end":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "tool_use":
      return "tool_use";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

/**
 * Reuse the OpenAI executor's tag-extraction primitive for the
 * non-streaming post-process path. Streaming uses the
 * `adapterTransforms` + `customBlocks` pipeline.
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
  for (const ev of events) {
    if (ev.type === "text") cleanText += ev.content;
    else if (ev.type === "block" && reasoningTags.has(ev.tag)) reasoning += ev.content;
  }
  return { text: cleanText, reasoning };
}

// ============================================================================
// Client construction
// ============================================================================

function buildClientOptions(opts: AnthropicAdapterOptions): ClientOptions {
  // Env-var fallbacks fill in any field absent from explicit
  // clientOptions. Explicit values win.
  const base: ClientOptions = {};
  const envApiKey = process.env["ANTHROPIC_API_KEY"];
  if (envApiKey !== undefined) base.apiKey = envApiKey;
  const envBaseURL = process.env["ANTHROPIC_BASE_URL"];
  if (envBaseURL !== undefined) base.baseURL = envBaseURL;
  if (opts.clientOptions !== undefined) {
    return { ...base, ...opts.clientOptions };
  }
  return base;
}

// ============================================================================
// IR → Anthropic params
// ============================================================================

function toAnthropicParams(
  input: LanguageModelInput,
  target: ExecutionTarget,
  defaultModel: string | undefined,
  executorMaxTokens: number | undefined,
): MessageCreateParams {
  const { system, messages } = toAnthropicMessages(input.messages);
  const fnTools = input.tools && input.tools.length > 0 ? toAnthropicTools(input.tools) : [];
  // Pass D request-half: append this adapter's own provider-EXECUTED tool
  // slice (`provider === "anthropic"`) onto the native `tools` array.
  // Anthropic server tools carry BOTH a versioned `type` AND a `name`
  // (e.g. `{ type: "web_search_20250305", name: "web_search", max_uses: 5 }`),
  // so map `{ type, name, ...config }` verbatim — passthrough, no per-tool
  // knowledge. Other providers' slices are ignored (each adapter owns its key).
  const providerTools = buildAnthropicProviderTools(input.providerTools);
  const tools = [...fnTools, ...providerTools];

  const params: MessageCreateParams = {
    model: target.modelId ?? defaultModel ?? DEFAULT_MODEL,
    messages,
    max_tokens: input.parameters?.maxOutputTokens ?? executorMaxTokens ?? DEFAULT_MAX_TOKENS,
  } as MessageCreateParams;

  if (system !== undefined) (params as { system?: MessageCreateParams["system"] }).system = system;
  if (tools.length > 0) params.tools = tools;
  const p = input.parameters;
  if (p?.temperature !== undefined) params.temperature = p.temperature;
  if (p?.topP !== undefined) params.top_p = p.topP;
  if (p?.stopSequences !== undefined) params.stop_sequences = [...p.stopSequences];
  // Silently drop frequencyPenalty / presencePenalty / responseFormat —
  // Anthropic has no native support (G1 caveat from the skill).

  // Adopter escape hatch — spread last so explicit overrides win.
  // `input.providerOptions` (project-time fold of tree over target, #176)
  // wins over the target's own bag; merged defensively so a direct
  // `buildParams(input, target)` still applies the escape hatch.
  const overrides = mergeProviderOptions(target.providerOptions, input.providerOptions)?.anthropic;
  if (overrides && typeof overrides === "object") {
    Object.assign(params, overrides);
  }
  return params;
}

/** Read `providerOptions.anthropic.cacheControl` from an INPUT part as a
 *  validated SDK `cache_control` value, or undefined. (ADR 57 §2 — the
 *  adopter-stamped per-block knob rides `providerOptions` on the send
 *  path; projected from the block's `providerMetadata`.) */
function readBlockCacheControl(part: {
  readonly providerOptions?: ProviderOptions;
}): { type: "ephemeral" } | undefined {
  const bag = part.providerOptions as Record<string, Record<string, unknown>> | undefined;
  const v = bag?.["anthropic"]?.["cacheControl"];
  if (v && typeof v === "object" && "type" in v && (v as { type?: unknown }).type === "ephemeral") {
    return { type: "ephemeral" };
  }
  return undefined;
}

/**
 * Canonical CacheHint → Anthropic cache_control (#185). ttl "5m"/"1h"
 * maps through; anything else falls back to plain ephemeral. Explicit
 * per-block `providerMetadata.anthropic.cacheControl` always wins over
 * this translation (escape hatch beats canonical).
 */
function cacheControlFromHint(
  hint: { readonly ttl?: string } | undefined,
): { type: "ephemeral"; ttl?: "5m" | "1h" } | undefined {
  if (hint === undefined) return undefined;
  if (hint.ttl === "5m" || hint.ttl === "1h") return { type: "ephemeral", ttl: hint.ttl };
  return { type: "ephemeral" };
}

function toAnthropicMessages(messages: ReadonlyArray<LanguageModelMessage>): {
  system: string | Array<TextBlockParam> | undefined;
  messages: Array<MessageParam>;
} {
  // Track each collected system text + whether the source part marked
  // itself ephemeral via providerMetadata. If ANY system part is
  // marked, emit the array form so cache_control can land on the
  // right segment.
  const systemEntries: Array<{
    text: string;
    cache: { type: "ephemeral"; ttl?: "5m" | "1h" } | undefined;
  }> = [];
  const out: Array<MessageParam> = [];

  for (const message of messages) {
    if (message.role === "system") {
      for (const part of message.content) {
        if (part.type !== "text" || !part.text) continue;
        systemEntries.push({
          text: part.text,
          cache: readBlockCacheControl(part) ?? cacheControlFromHint(part.cache),
        });
      }
      continue;
    }

    const role: "user" | "assistant" = message.role === "assistant" ? "assistant" : "user";
    const content: ContentBlockParam[] = [];

    for (const [i, part] of message.content.entries()) {
      // Precedence: explicit per-block providerMetadata > canonical
      // part hint > canonical message hint (marks the LAST block —
      // Anthropic breakpoints cache the prefix through that block).
      const messageHint = i === message.content.length - 1 ? message.cache : undefined;
      const cache =
        readBlockCacheControl(part) ??
        cacheControlFromHint((part as { cache?: { ttl?: string } }).cache ?? messageHint);
      switch (part.type) {
        case "text": {
          const block: TextBlockParam = { type: "text", text: part.text };
          if (cache) block.cache_control = cache;
          content.push(block);
          break;
        }
        case "image": {
          const source = imageSourceFromUrl(part.imageUrl, part.mediaType);
          const block: ImageBlockParam = { type: "image", source };
          if (cache) (block as { cache_control?: { type: "ephemeral" } }).cache_control = cache;
          content.push(block);
          break;
        }
        case "tool_use": {
          const block: ToolUseBlockParam = {
            type: "tool_use",
            id: part.id,
            name: part.name,
            input: (part.input ?? {}) as Record<string, unknown>,
          };
          if (cache) (block as { cache_control?: { type: "ephemeral" } }).cache_control = cache;
          content.push(block);
          break;
        }
        case "tool_result": {
          const inner = toolResultContent(part.content);
          const block: ToolResultBlockParam = {
            type: "tool_result",
            tool_use_id: part.toolUseId,
            content: inner,
            ...(part.isError ? { is_error: true } : {}),
          };
          if (cache) (block as { cache_control?: { type: "ephemeral" } }).cache_control = cache;
          content.push(block);
          break;
        }
        case "document": {
          // Anthropic native document block (port of v1 anthropic.ts:537).
          const source = anthropicDocumentSource(part.source, part.mediaType);
          if (source) {
            const block = { type: "document", source } as DocumentBlockParam;
            if (cache) (block as { cache_control?: { type: "ephemeral" } }).cache_control = cache;
            content.push(block);
          }
          break;
        }
        case "reasoning": {
          // Round-trip signed thinking verbatim (CB-BLOCKER-1). A
          // redacted block replays its opaque `data`; a normal block
          // replays `thinking` + `signature`. Anthropic requires the
          // signed block replayed unchanged on the next turn.
          const redactedData = reasoningRedactedData(part);
          if (redactedData !== undefined) {
            content.push({
              type: "redacted_thinking",
              data: redactedData,
            } as RedactedThinkingBlockParam);
          } else {
            content.push({
              type: "thinking",
              thinking: part.text,
              signature: part.signature ?? "",
            } as ThinkingBlockParam);
          }
          break;
        }
        // TODO(adr-57-followup: anthropic audio/video input): Anthropic
        // Messages has no native audio/video content part — dropped
        // rather than flattened to a text bomb.
      }
    }
    if (content.length === 0) continue;

    // Strict user/assistant alternation: coalesce consecutive same-role.
    const last = out[out.length - 1];
    if (last && last.role === role) {
      if (Array.isArray(last.content)) {
        (last.content as ContentBlockParam[]).push(...content);
      } else {
        last.content = [{ type: "text", text: last.content } as TextBlockParam, ...content];
      }
    } else {
      out.push({ role, content });
    }
  }

  // System param: array form if any segment marked ephemeral, else
  // joined string.
  let systemOut: string | Array<TextBlockParam> | undefined;
  if (systemEntries.length === 0) {
    systemOut = undefined;
  } else if (systemEntries.some((e) => e.cache !== undefined)) {
    systemOut = systemEntries.map((e) => {
      const block: TextBlockParam = { type: "text", text: e.text };
      if (e.cache) block.cache_control = e.cache;
      return block;
    });
  } else {
    systemOut = systemEntries.map((e) => e.text).join("\n\n");
  }
  return { system: systemOut, messages: out };
}

function toolResultContent(
  parts: ReadonlyArray<LanguageModelMessagePart>,
): Array<TextBlockParam | ImageBlockParam> {
  const result: Array<TextBlockParam | ImageBlockParam> = [];
  for (const c of parts) {
    if (c.type === "text") {
      result.push({ type: "text", text: c.text } as TextBlockParam);
    } else if (c.type === "image") {
      const source = imageSourceFromUrl(c.imageUrl, c.mediaType);
      result.push({ type: "image", source } as ImageBlockParam);
    } else {
      // Flatten anything else to a JSON text representation (matches v1).
      result.push({ type: "text", text: JSON.stringify(c) } as TextBlockParam);
    }
  }
  if (result.length === 0) {
    // Anthropic rejects empty tool_result.content — insert placeholder.
    result.push({ type: "text", text: "Done" } as TextBlockParam);
  }
  return result;
}

function toAnthropicTools(tools: ReadonlyArray<LanguageModelTool>): Array<AnthropicTool> {
  return tools.map((t) => {
    const base: AnthropicTool = {
      name: t.name,
      input_schema: (t.inputSchema ?? {
        type: "object",
      }) as AnthropicTool["input_schema"],
    };
    if (t.description !== undefined) base.description = t.description;
    // Per-tool providerOptions.anthropic — adopter-supplied SDK
    // overrides (typically `cache_control` for prompt-cache breakpoints)
    // win over projected defaults.
    const overrides = t.providerOptions?.anthropic;
    return overrides ? { ...base, ...overrides } : base;
  });
}

/**
 * Pass D request-half: map the `provider === "anthropic"` slice of
 * `input.providerTools` onto Anthropic's native tools-array shape. Anthropic
 * server tools are `{ type: <versioned>, name: <framework id>, ...config }`
 * (e.g. `{ type: "web_search_20250305", name: "web_search", max_uses: 5 }`) —
 * passthrough, no schema, no per-tool knowledge. The `MessageCreateParams`
 * `tools` union accepts these server-tool shapes alongside function tools;
 * cast at the boundary since the projected `type`/`config` are opaque.
 * Other providers' slices are ignored.
 */
function buildAnthropicProviderTools(
  providerTools: LanguageModelInput["providerTools"],
): Array<AnthropicTool> {
  if (!providerTools) return [];
  const out: Array<AnthropicTool> = [];
  for (const pt of providerTools) {
    if (pt.provider !== "anthropic") continue;
    out.push({ type: pt.type, name: pt.name, ...pt.config } as unknown as AnthropicTool);
  }
  return out;
}

/**
 * Project a document {@link MediaSource} to an Anthropic document block
 * `source` (port of v1 `anthropic.ts:537`): base64 → inline; url →
 * server-side fetch; files-API reference → `file` by id.
 */
function anthropicDocumentSource(
  source: MediaSource,
  mediaType: string | undefined,
): DocumentBlockParam["source"] | null {
  switch (source.type) {
    case "base64":
      return {
        type: "base64",
        media_type: (source.mimeType ?? mediaType ?? "application/pdf") as "application/pdf",
        data: source.data,
      };
    case "url":
      return { type: "url", url: source.url };
    default:
      // reference (Files API) / s3 / gcs are not expressible in this
      // SDK version's document `source` union (base64 / url / text /
      // content only) — TODO(adr-57-followup: anthropic file-id +
      // staged document sources once the SDK exposes them).
      return null;
  }
}

/**
 * Extract a redacted-thinking opaque payload from a reasoning INPUT
 * part, if present. It rides either the generic `data` slot or the
 * Anthropic provider namespace (`providerOptions.anthropic.redactedData`,
 * projected from the block's `providerMetadata` — where `normalize`
 * stashes it, since the canonical `ReasoningBlock` has no `data` field).
 */
function reasoningRedactedData(part: {
  readonly data?: unknown;
  readonly providerOptions?: ProviderOptions;
}): string | undefined {
  if (typeof part.data === "string") return part.data;
  const bag = part.providerOptions as Record<string, Record<string, unknown>> | undefined;
  const v = bag?.["anthropic"]?.["redactedData"];
  return typeof v === "string" ? v : undefined;
}

function imageSourceFromUrl(
  imageUrl: string,
  mimeType: string | undefined,
):
  | {
      type: "base64";
      media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      data: string;
    }
  | { type: "url"; url: string } {
  if (imageUrl.startsWith("data:")) {
    // data:image/png;base64,XXXX
    const match = /^data:([^;]+);base64,(.*)$/.exec(imageUrl);
    if (match) {
      const inferred = (match[1] ?? mimeType ?? "image/png") as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp";
      return {
        type: "base64",
        media_type: inferred,
        data: match[2] ?? "",
      };
    }
  }
  return { type: "url", url: imageUrl };
}

// ============================================================================
// IR projection — Anthropic-specific: one text part per system section so
// per-section providerMetadata.anthropic.cacheControl survives projection.
// (The base's `defaultProject` joins all section text into one string, which
// would lose per-section cache breakpoints.)
// ============================================================================

function anthropicProjectImpl(input: ProjectInput): LanguageModelInput {
  const messages = buildAnthropicMessages(input.compiled);
  // Tool projection is the canonical fold — Anthropic doesn't need a
  // provider-specific tool shape at this layer. The system-message
  // override above exists ONLY because Anthropic preserves per-section
  // cache_control; tools have no such concern.
  const tools = buildTools(input.tools, input.narrate);
  // Generation params are the canonical fold — Anthropic's projection
  // override exists ONLY to preserve per-section cache_control on the
  // system message; the SpecConfig → LanguageModelParameters lift is
  // identical to the base, so reuse it rather than duplicate (and keep
  // topP/frequencyPenalty/presencePenalty/stopSequences reachable, #211).
  const parameters = buildParameters(input.compiled);
  // #176: fold tree.providerOptions over target.providerOptions (tree
  // wins) — same as the canonical `defaultProject`. The Anthropic
  // override replaces the base projection wholesale, so it must carry
  // the fold itself or every tree-declared knob is orphaned here.
  const providerOptions = mergeProviderOptions(
    input.target.providerOptions,
    input.compiled.providerOptions,
  );
  return {
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...omitUndefined({ parameters, providerOptions }),
  };
}

function buildAnthropicMessages(tree: RenderedTree): ReadonlyArray<LanguageModelMessage> {
  const messages: LanguageModelMessage[] = [];
  // Emit one text part per section (not a single joined string) so
  // per-section `metadata.providerMetadata` survives projection. The
  // executor reads each part's `providerOptions` in `toAnthropicMessages`
  // to decide string vs array system form. (ADR 57 §2 — the section's
  // adopter-stamped `providerMetadata` knob projects onto the INPUT
  // part's `providerOptions`.)
  const systemParts: LanguageModelMessagePart[] = [];
  for (const e of tree.context.entries) {
    if (e.kind !== "section") continue;
    const text = anthropicSectionText(e);
    if (text.length === 0) continue;
    const part: LanguageModelMessagePart = { type: "text", text };
    const pm = e.metadata?.providerMetadata;
    if (pm !== undefined) {
      (part as { providerOptions?: Record<string, Record<string, unknown>> }).providerOptions = pm;
    }
    // Canonical CacheHint rides the part (#185); toAnthropicMessages
    // translates it (explicit providerOptions above still wins there).
    if (e.metadata?.cache !== undefined) {
      (part as { cache?: unknown }).cache = e.metadata.cache;
    }
    systemParts.push(part);
  }
  if (systemParts.length > 0) {
    messages.push({ role: "system", content: systemParts });
  }
  for (const entry of tree.context.entries) {
    if (entry.kind !== "message") continue;
    const cache = entry.metadata?.cache;
    // Message-level provider knobs ride the INPUT channel (#173) — same
    // send/return split as the canonical projection.
    const providerOptions = entry.metadata?.providerMetadata;
    messages.push({
      role: entry.role as LanguageModelMessage["role"],
      content: entry.content.map(anthropicMessagePartFromBlock),
      ...(providerOptions !== undefined ? { providerOptions } : {}),
      ...(cache !== undefined ? { cache } : {}),
    });
  }
  return messages;
}

function anthropicSectionText(section: SectionEntry): string {
  const head = section.title ? `## ${section.title}\n\n` : "";
  const body = section.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter((t) => t.length > 0)
    .join("\n\n");
  return head + body;
}

function anthropicMessagePartFromBlock(block: ContentBlock): LanguageModelMessagePart {
  // Per-block `providerMetadata` (the canonical block's knob channel)
  // projects onto the INPUT part's `providerOptions` (ADR 57 §2). Mirrors
  // the canonical `messagePartFromBlock`; the Anthropic override exists
  // only for the system-section shape, not the block mapping.
  const po =
    block.providerMetadata !== undefined ? { providerOptions: block.providerMetadata } : {};
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text, ...po };
    case "image":
      return {
        type: "image",
        imageUrl: anthropicImageUrlFromSource(block.source, block.mimeType),
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "document":
      return {
        type: "document",
        source: block.source,
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "audio":
      return {
        type: "audio",
        source: block.source,
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "video":
      return {
        type: "video",
        source: block.source,
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "reasoning":
      return {
        type: "reasoning",
        text: block.text,
        ...omitUndefined({ signature: block.signature }),
        ...po,
      };
    case "generated_image":
      // Replay as an image (ADR 57 §Taxonomy) — data URI, not a
      // JSON.stringify base64 token-bomb.
      return {
        type: "image",
        imageUrl: `data:${block.mimeType};base64,${block.data}`,
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "generated_file":
      return {
        type: "document",
        source: { type: "url", url: block.uri, ...omitUndefined({ mimeType: block.mimeType }) },
        ...omitUndefined({ mediaType: block.mimeType }),
        ...po,
      };
    case "tool_use":
      return {
        type: "tool_use",
        id: block.toolUseId,
        name: block.name,
        input: block.input,
        ...po,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolUseId: block.toolUseId,
        content: block.content.map(anthropicMessagePartFromBlock),
        ...omitUndefined({ isError: block.isError }),
        ...po,
      };
    case "task_ref":
      // Match the base mapper's drop-in text projection (task_ref stays
      // canonical `{_kind}` JSON — ADR 57 §Taxonomy). Previously this
      // override lacked the case and fell to the raw `JSON.stringify`
      // default below.
      return {
        type: "text",
        text: JSON.stringify({
          _kind: "session_task_ref",
          taskId: block.taskId,
          status: block.status,
          ...omitUndefined({
            statusMessage: block.statusMessage,
            ttl: block.ttl,
            pollInterval: block.pollInterval,
          }),
        }),
        ...po,
      };
    default:
      return {
        type: "text",
        text:
          "text" in block && typeof block.text === "string" ? block.text : JSON.stringify(block),
      };
  }
}

function anthropicImageUrlFromSource(source: MediaSource, mimeType: string | undefined): string {
  switch (source.type) {
    case "url":
      return source.url;
    case "base64": {
      const mt = source.mimeType ?? mimeType ?? "image/png";
      return `data:${mt};base64,${source.data}`;
    }
    case "reference":
      return source.fileId;
    case "s3":
      return `s3://${source.bucket}/${source.key}`;
    case "gcs":
      return `gs://${source.bucket}/${source.object}`;
  }
}

// ============================================================================
// Anthropic Message → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput;
  if (!isAnthropicMessage(raw)) {
    throw new Error("normalize expected Anthropic Message shape");
  }
  // ┌─ TODO(pass-d): PROVENANCE HALF — NOT YET IMPLEMENTED ──────────────────────
  // │ Provider-executed tools (web_search / code_interpreter / server_tool_use /
  // │ grounding) are ENABLED on the request (see prepareInput) but their RESULTS
  // │ are not yet provenance-stamped here. This adapter must, in a follow-on pass:
  // │   1. Recognize Anthropic's provider-executed result blocks
  // │      (`server_tool_use` + the paired `web_search_tool_result` /
  // │       `code_execution_tool_result` content blocks on the message).
  // │   2. Stamp the resulting `tool_result` block `executedBy: "provider:anthropic"`
  // │      (see ToolExecutor docblock in spec content-blocks.ts) so the client
  // │      attributes + renders it and knows NOT to act on it.
  // │   3. Ensure provider-executed tool CALLS are NOT surfaced as dispatchable
  // │      function `tool_use` — else the loop's executor will try to dispatch a
  // │      tool with no handler. They are provider-run; their result is inline.
  // └────────────────────────────────────────────────────────────────────────────
  const output = anthropicContentToContentBlocks(raw.content);
  const toolCalls: ToolCall[] = [];
  for (const block of raw.content) {
    if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      });
    }
  }
  const stopReason = mapFinishReason(raw.stop_reason);
  const usage = toUsageStats(raw.usage);

  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION_LITERAL,
    output,
    stopReason,
    usage,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw,
  };
  return result;
}

function anthropicContentToContentBlocks(
  content: AnthropicMessage["content"] | undefined,
): ContentBlock[] {
  const output: ContentBlock[] = [];
  if (!content) return output;
  for (const block of content) {
    switch (block.type) {
      case "text":
        if ((block as AnthropicTextBlock).text.length > 0) {
          output.push({ type: "text", text: (block as AnthropicTextBlock).text });
        }
        break;
      case "tool_use": {
        const t = block as AnthropicToolUseBlock;
        output.push({
          type: "tool_use",
          toolUseId: t.id,
          name: t.name,
          input: (t.input ?? {}) as Record<string, unknown>,
        });
        break;
      }
      case "thinking": {
        // CB-BLOCKER-1: capture the signature (previously dropped) so
        // the signed thinking block replays verbatim on the next turn
        // (Anthropic requires this for extended-thinking + tool use).
        const t = block as AnthropicThinkingBlock;
        output.push({
          type: "reasoning",
          text: t.thinking,
          ...(t.signature ? { signature: t.signature } : {}),
        });
        break;
      }
      case "redacted_thinking": {
        // CB-BLOCKER-1: carry the opaque `data` (previously discarded).
        // The canonical `ReasoningBlock` has no `data` field, so stash it
        // in the provider namespace — `providerMetadata` is exactly the
        // "model-produced opaque data to resend verbatim" channel. It
        // rides back to `providerOptions.anthropic.redactedData` at
        // re-projection (`reasoningRedactedData`).
        const r = block as RedactedThinkingBlock;
        output.push({
          type: "reasoning",
          text: "[redacted]",
          isRedacted: true,
          ...(r.data !== undefined
            ? { providerMetadata: { anthropic: { redactedData: r.data } } }
            : {}),
        });
        break;
      }
    }
  }
  return output;
}

function isAnthropicMessage(v: unknown): v is AnthropicMessage {
  if (!v || typeof v !== "object") return false;
  const o = v as { type?: unknown; content?: unknown };
  return o.type === "message" && Array.isArray(o.content);
}

function toUsageStats(usage: Usage | undefined | null): UsageStats {
  if (!usage) {
    return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  // Anthropic reports cache reads/writes DISJOINT from input_tokens;
  // the canonical UsageStats rule (#186) is subset semantics — fold in.
  const cached = usage.cache_read_input_tokens ?? 0;
  const creation = usage.cache_creation_input_tokens ?? 0;
  const inputTokens = (usage.input_tokens ?? 0) + cached + creation;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(usage.cache_read_input_tokens != null ? { cachedInputTokens: cached } : {}),
    ...(usage.cache_creation_input_tokens != null ? { cacheCreationTokens: creation } : {}),
  };
}

// ============================================================================
// Stop-reason mapping
// ============================================================================

function mapFinishReason(reason: string | null | undefined): LanguageModelStopReason {
  switch (reason) {
    case "end_turn":
      return "end";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "tool_use":
      return "tool_use";
    case "refusal":
      // Anthropic declined to generate (safety) — surface as a distinct
      // content-filter event, NOT a clean completion (#216).
      return "content_filter";
    case "pause_turn":
      // Long-running turn paused (server tools) — no clean canonical
      // equivalent; carry as `other` so it isn't masked as `end` (#216).
      return "other";
    default:
      return "end";
  }
}
