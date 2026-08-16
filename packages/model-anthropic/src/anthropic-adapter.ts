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
  TextCitation,
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
  buildMessages,
  buildParameters,
  buildTools,
  createSourceInterner,
  lowerSemanticRole,
  defineLanguageModelAdapter,
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
  LanguageModelMessagePart,
  LanguageModelMessageRole,
  LanguageModelStopReason,
  LanguageModelTool,
  MediaSource,
  NormalizeInput,
  ProjectInput,
  ProviderOptions,
  RateCard,
  Source,
  ToolCall,
  ToolResultBlock,
  UsageStats,
} from "@agentick/spec";
import { mergeProviderOptions, SPEC_VERSION } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

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
declare module "@agentick/spec" {
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
   * {@link import("@agentick/spec").ProviderClientOptions} slot.
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
   * anthropic("claude-sonnet-5", {
   *   providerOptions: {
   *     anthropic: { thinking: { type: "enabled", budget_tokens: 8192 } },
   *   },
   * });
   * ```
   */
  readonly providerOptions?: ProviderOptions;
}

// Re-export from @agentick/model-executor so adopters that import from
// @agentick/model-anthropic keep the same surface.
export type { CustomBlockDefinition } from "@agentick/model";

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
 * adapter is accepted — the app's `modelExecutor:` slot (wrapped in the ONE
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
  const baseTarget: ExecutionTarget = options.target ?? {
    kind: "language-model",
    provider: "anthropic",
    modelId: model ?? DEFAULT_MODEL,
    capabilities: {
      supportsTools: true,
      supportsStreaming: true,
      supportsVision: true,
      // Images and documents take `base64` (inline) or `url` (Anthropic fetches
      // server-side). `reference` / `gcs` / `s3` are not expressible in this SDK
      // version's source unions.
      //
      // `audio` and `video` are ABSENT deliberately, and that is the declaration
      // earning its keep: the message projection below has no arm for either, so
      // those parts used to fall off the end of the switch and disappear with no
      // `null` anywhere to observe. Stated here, they are dropped with a reason.
      media: { image: ["base64", "url"], document: ["base64", "url"] },
      contextWindow: 200_000,
      maxOutputTokens: 8_192,
    },
    // Anthropic charges an image at roughly `width × height / 750`, which tops
    // out near 1590 at the 1092² it recommends; a PDF page runs 1.5k–3k. A
    // MediaSource carries no dimensions or page count, so these are that
    // formula at one typical instance (a ~1024² screenshot, one page).
    //
    // `audio` and `video` are declared unsupported above and dropped before the
    // wire — the rates exist only so a block that somehow reaches an estimate
    // is not silently free.
    mediaTokens: {
      image: 1_365,
      document: 2_250,
      audio: 1_900,
      video: 15_000,
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

  let clientMemo: Anthropic | undefined = options.client;
  const client = (): Anthropic => (clientMemo ??= new Anthropic(buildClientOptions(options)));

  return defineLanguageModelAdapter<AnthropicMessage, RawMessageStreamEvent, MessageCreateParams>({
    provider: "anthropic",
    target,
    streamByDefault: options.stream ?? false,
    ...(customBlocks !== undefined ? { customBlocks } : {}),

    project(input: ProjectInput): LanguageModelInput {
      return anthropicProjectImpl(input);
    },

    prepareRequest(input: ExecuteInput<LanguageModelInput>): MessageCreateParams {
      return toAnthropicParams(input.targetInput, input.target, defaultModel, defaultMaxTokens);
    },

    send(request: MessageCreateParams, signal: AbortSignal | undefined): Promise<AnthropicMessage> {
      return client().messages.create(
        { ...request, stream: false } as MessageCreateParamsNonStreaming,
        { signal },
      ) as unknown as Promise<AnthropicMessage>;
    },

    openStream(
      request: MessageCreateParams,
      signal: AbortSignal | undefined,
    ): Promise<AsyncIterable<RawMessageStreamEvent>> {
      return client().messages.create(
        { ...request, stream: true } as MessageCreateParamsStreaming,
        {
          signal,
        },
      ) as unknown as Promise<AsyncIterable<RawMessageStreamEvent>>;
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
            // Anthropic reports cache reads AND cache writes disjoint from
            // `input_tokens`; subset semantics (#186) folds BOTH in. This is
            // the same arithmetic as the non-streaming `toUsageStats` — the
            // two paths must produce identical UsageStats for identical wire
            // numbers, or a streamed call reports zero cache writes and
            // under-bills the expensive kind (usage-cost.md D5).
            out.push({ type: "usage", usage: toUsageStats(u) });
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
            let parsedInput: Readonly<Record<string, unknown>> | undefined;
            try {
              parsedInput = entry?.argsBuffer
                ? (JSON.parse(entry.argsBuffer) as Readonly<Record<string, unknown>>)
                : {};
            } catch {
              // No summary on unparseable arguments — the accumulator raises
              // MalformedModelOutput from the buffer at finalize (ADR 99).
            }
            out.push({ type: "tool-call-end", callId });
            if (parsedInput !== undefined) {
              out.push({
                type: "tool-call",
                callId,
                name: entry?.name ?? "",
                input: parsedInput,
              });
            }
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
          // Input and both cache counters were captured (and folded) at
          // message_start; carry them forward verbatim so the terminal
          // usage matches the non-streaming shape kind for kind.
          const inputTokens = accum.usage.inputTokens;
          const outputTokens = u?.output_tokens ?? accum.usage.outputTokens;
          out.push({
            type: "message-end",
            stopReason: mapFinishReason(event.delta.stop_reason),
            usage: {
              inputTokens,
              outputTokens,
              totalTokens: inputTokens + outputTokens,
              ...omitUndefined({
                cachedInputTokens: accum.usage.cachedInputTokens,
                cacheCreationTokens: accum.usage.cacheCreationTokens,
              }),
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
          // Back-map subset semantics to Anthropic's disjoint wire shape:
          // BOTH cache counters come back out of inputTokens, or the
          // round-trip through normalize() double-counts cache writes.
          input_tokens:
            accum.usage.inputTokens -
            (accum.usage.cachedInputTokens ?? 0) -
            (accum.usage.cacheCreationTokens ?? 0),
          output_tokens: accum.usage.outputTokens,
          cache_read_input_tokens: accum.usage.cachedInputTokens ?? null,
          cache_creation_input_tokens: accum.usage.cacheCreationTokens ?? null,
        },
      } as AnthropicMessage;
    },

    adapterTransforms(): readonly DeltaTransform[] {
      return parseThinkTags ? [thinkTagTransform()] : [];
    },

    // TODO(malformed-output): no `mapProviderError` — Anthropic publishes no
    // error class or stop reason that positively names malformed model output.
    // Its one occurrence, an unparseable `input_json_delta` run, is caught
    // generically at stream finalize (ADR 99 slice 4a).
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
  });
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
  // Canonical toolChoice → Anthropic `tool_choice`: "auto"→{type:"auto"},
  // "required"→{type:"any"}, "none"→{type:"none"}, `{tool}`→{type:"tool",name}
  // (a forced single call). Provider overrides in `providerOptions.anthropic`
  // still win (spread last, below).
  if (p?.toolChoice !== undefined) {
    const tc = p.toolChoice;
    params.tool_choice =
      tc === "auto"
        ? { type: "auto" }
        : tc === "required"
          ? { type: "any" }
          : tc === "none"
            ? { type: "none" }
            : { type: "tool", name: tc.tool };
  }
  // Silently drop frequencyPenalty / presencePenalty / responseFormat —
  // Anthropic has no native support (G1 caveat from the skill).
  // TODO(trail-anthropic-structured): map `responseFormat.type ===
  // "json_schema"` onto the tool-shaped strategy (a single forced
  // `output`-named tool whose input_schema IS the response schema +
  // `tool_choice: { type: "tool", name: "output" }`), per the
  // generate-object.ts docblock. The drop here is DELIBERATE-BUT-TRACKED,
  // not an oversight — `responseFormat` is a best-effort generation hint on
  // this adapter today. The robust structured path is the deferred
  // final-answer-tool capture (trail-response-format-send successor design),
  // which validates via the tool executor and works on every provider.

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
          const source = anthropicImageSource(part.source, part.mediaType);
          // Declined → the block is skipped rather than sent in a form the API rejects.
          if (source === null) break;
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
              signature: reasoningSignature(part) ?? "",
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
      const source = anthropicImageSource(c.source, c.mediaType);
      if (source !== null) result.push({ type: "image", source } as ImageBlockParam);
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
  return anthropicReasoningKey(part, "redactedData");
}

/**
 * The signed thinking block's signature, which Anthropic requires replayed
 * unchanged on the next turn of an extended-thinking + tools conversation.
 *
 * Read from the dialect namespace, same as `redactedData`. It used to ride a
 * bare `ReasoningBlock.signature`, which the canonical projection then handed to
 * every adapter — an opaque Anthropic blob offered to Google.
 */
function reasoningSignature(part: {
  readonly providerOptions?: ProviderOptions;
}): string | undefined {
  return anthropicReasoningKey(part, "signature");
}

function anthropicReasoningKey(
  part: { readonly providerOptions?: ProviderOptions },
  key: string,
): string | undefined {
  const bag = part.providerOptions as Record<string, Record<string, unknown>> | undefined;
  const v = bag?.["anthropic"]?.[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * Project a {@link MediaSource} to Anthropic's image source.
 *
 * This was `imageSourceFromUrl(imageUrl, mimeType)` — it parsed a `data:` URL with a
 * regex to recover the base64 payload the framework had just stringified. A structured
 * value flattened and then reverse-engineered, which lost precisely the sources that
 * have no lexical form: an adopter `reference` arrived as a bare file id and was sent as
 * `{ type: "url", url: "<uuid>" }`.
 *
 * `null` for a source Anthropic cannot take. `reference` is the adopter's own id (the
 * framework cannot resolve it — see `FileReferenceSource`), and `gcs` / `s3` are not
 * schemes Anthropic fetches. Declining beats emitting a request the API will reject.
 *
 * TODO(decline-reporting): the `null` is a verdict that is now OBSERVABLE via
 * `detectDroppedInputs` but still not REPORTED — it reaches no stream, hook or result.
 * See the same marker on `googlePartFromSource`.
 */
function anthropicImageSource(
  source: MediaSource,
  mimeType: string | undefined,
):
  | {
      type: "base64";
      media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
      data: string;
    }
  | { type: "url"; url: string }
  | null {
  if (source.type === "base64") {
    const mt = (source.mimeType ?? mimeType ?? "image/png") as
      | "image/jpeg"
      | "image/png"
      | "image/gif"
      | "image/webp";
    return { type: "base64", media_type: mt, data: source.data };
  }
  if (source.type === "url") {
    // A `data:` URL is still inline bytes; Anthropic wants those as base64, not a url.
    const match = /^data:([^;]+);base64,(.*)$/.exec(source.url);
    if (match) {
      const mt = (match[1] ?? mimeType ?? "image/png") as
        | "image/jpeg"
        | "image/png"
        | "image/gif"
        | "image/webp";
      return { type: "base64", media_type: mt, data: match[2] ?? "" };
    }
    return { type: "url", url: source.url };
  }
  return null;
}

// ============================================================================
// IR projection — Anthropic keeps its own `project` ONLY for the parts of
// the request the canonical fold does not own. Per-section cache breakpoints
// USED to be the reason this override existed: `defaultProject` joined every
// section into one string, so a breakpoint between two of them had nowhere
// to land. That reason is gone — a section is content now, one section is
// one block, and one block is one part (ADR 94) — so this delegates the
// message fold and adds only the Anthropic-specific role lowering.
// ============================================================================

/**
 * Anthropic has no non-user instruction role. `grounding` and `event` both
 * land as `user`; what keeps them distinguishable from a human turn is the
 * structure already in their content — the section lowering the compiler
 * applied — not an impersonated role.
 */
const ANTHROPIC_ROLES = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
  grounding: "user",
  event: "user",
} as const satisfies Record<LanguageModelMessageRole, LanguageModelMessageRole>;

function anthropicProjectImpl(input: ProjectInput): LanguageModelInput {
  const messages = buildMessages(input.compiled).map((m) => ({
    ...m,
    role: lowerSemanticRole(m.role, ANTHROPIC_ROLES),
  }));
  const tools = buildTools(input.tools, input.narrate);
  const parameters = buildParameters(input.compiled);
  // #176: fold tree.providerOptions over target.providerOptions (tree
  // wins) — same as the canonical `defaultProject`.
  const providerOptions = mergeProviderOptions(
    input.target.providerOptions,
    input.compiled.providerOptions,
  );
  // TODO(anthropic-provider-tools): this override predates
  // `LanguageModelInput.providerTools` and never projected them, so an
  // Anthropic tree declaring a `<ProviderTool>` (server_tool_use, web
  // search) silently sends none. `defaultProject` does project them.
  return {
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...omitUndefined({ parameters, providerOptions }),
  };
}

// ============================================================================
// Local wire shapes — provider-executed server tools (web search)
// ============================================================================

/**
 * Provenance stamp for Anthropic provider-EXECUTED tools (server tools run
 * INSIDE the model call — web search, etc.). See {@link ToolExecutor}.
 */
const PROVIDER_ANTHROPIC = "provider:anthropic";

/**
 * LOCAL wire interfaces for Anthropic's provider-executed server-tool content
 * blocks. The pinned `@anthropic-ai/sdk@0.39.0` does NOT type
 * `server_tool_use` / `web_search_tool_result` blocks nor the
 * `web_search_result_location` citation variant, yet the wire delivers them
 * (see Anthropic's published web-search tool API). These interfaces mirror
 * that published shape so {@link normalizeImpl} can detect the blocks
 * structurally and stamp provenance.
 *
 * **LOCAL UNTIL SDK TYPES LAND — replace with the SDK's own types on the bump
 * that ships server tools (~0.5x).** They are exported for fixtures only (the
 * SDK cannot type these shapes, so tests type their canned messages against
 * these interfaces); they are not part of the adapter's supported surface.
 */
export interface AnthropicServerToolUseBlockWire {
  readonly type: "server_tool_use";
  readonly id: string;
  /** The provider tool's name, e.g. `"web_search"`. */
  readonly name: string;
  readonly input?: Record<string, unknown>;
}

/** One web-search hit inside a {@link AnthropicWebSearchToolResultBlockWire}. */
export interface AnthropicWebSearchResultWire {
  readonly type: "web_search_result";
  readonly url: string;
  readonly title?: string;
  /** Opaque content the provider round-trips; not projected to canonical blocks. */
  readonly encrypted_content?: string;
  readonly page_age?: string | null;
}

/** The error variant of a {@link AnthropicWebSearchToolResultBlockWire}. */
export interface AnthropicWebSearchToolResultErrorWire {
  readonly type: "web_search_tool_result_error";
  readonly error_code: string;
}

/**
 * The provider-executed web-search RESULT block. `tool_use_id` correlates back
 * to the {@link AnthropicServerToolUseBlockWire} that requested it; `content`
 * is either the hit list (success) or a single error object.
 */
export interface AnthropicWebSearchToolResultBlockWire {
  readonly type: "web_search_tool_result";
  readonly tool_use_id: string;
  readonly content: readonly AnthropicWebSearchResultWire[] | AnthropicWebSearchToolResultErrorWire;
}

/**
 * The `web_search_result_location` citation variant that annotates text
 * blocks in a web-search turn. Absent from the SDK's `TextCitation` union;
 * carries a `url` (web source) instead of a `document_index`.
 */
export interface AnthropicWebSearchResultLocationCitationWire {
  readonly type: "web_search_result_location";
  readonly url: string;
  readonly title?: string;
  readonly cited_text?: string;
  readonly encrypted_index?: string;
}

/**
 * Map a provider-executed `web_search_tool_result` block onto a canonical
 * {@link ToolResultBlock} stamped `executedBy: "provider:anthropic"`. Each hit
 * interns a {@link Source} by URL (turn-scoped dedupe, consistent with the
 * document-citation path) and becomes a text block carrying that source + a
 * whole-block citation. The block-level `sources` roll-up carries the deduped
 * set so the message-level aggregate ({@link import("@agentick/spec").AssistantMessage.sources})
 * picks it up. The error variant folds to an `isError` result.
 */
function anthropicWebSearchResultBlock(
  block: AnthropicWebSearchToolResultBlockWire,
  toolName: string,
  interner: SourceInterner,
): ToolResultBlock {
  const content = block.content;
  // `Array.isArray` does not narrow a `readonly T[]` union member away, so
  // discriminate explicitly and cast the error branch.
  if (!Array.isArray(content)) {
    const err = content as AnthropicWebSearchToolResultErrorWire;
    return {
      type: "tool_result",
      toolUseId: block.tool_use_id,
      name: toolName,
      isError: true,
      content: [{ type: "text", text: `web search error: ${err.error_code}` }],
      executedBy: PROVIDER_ANTHROPIC,
    };
  }
  const inner: ContentBlock[] = [];
  const blockSources = new Map<string, Source>();
  for (const hit of content) {
    const source = interner.intern({
      url: hit.url,
      ...(hit.title ? { title: hit.title } : {}),
    });
    blockSources.set(source.id, source);
    inner.push({
      type: "text",
      text: hit.title ?? hit.url,
      sources: [source],
      citations: [{ sourceId: source.id }],
    });
  }
  const sources = [...blockSources.values()];
  return {
    type: "tool_result",
    toolUseId: block.tool_use_id,
    name: toolName,
    content: inner,
    executedBy: PROVIDER_ANTHROPIC,
    ...(sources.length > 0 ? { sources } : {}),
  };
}

// ============================================================================
// Anthropic Message → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput;
  if (!isAnthropicMessage(raw)) {
    throw new Error("normalize expected Anthropic Message shape");
  }
  // Provenance-half (Pass D): DOCUMENT citations are mapped in
  // `anthropicContentToContentBlocks` (text blocks carry `citations` →
  // canonical `Citation[]` via `anthropicCitationsToCitations`).
  //
  // Provider-executed web search (Pass A, optimistic): the pinned
  // `@anthropic-ai/sdk@0.39.0` still does NOT type `server_tool_use` /
  // `web_search_tool_result` blocks or the `web_search_result_location`
  // citation variant, but the wire delivers them (published Anthropic docs).
  // `anthropicContentToContentBlocks` now detects them STRUCTURALLY against the
  // local wire interfaces above and surfaces the search result as a
  // `tool_result` block stamped `executedBy: "provider:anthropic"` — replace
  // the local shapes with the SDK's own types once the server-tools bump lands.
  //
  // toolCalls EXCLUSION: the loop below extracts DISPATCHABLE function calls
  // and matches `block.type === "tool_use"` EXACTLY. A `server_tool_use` block
  // (type string `"server_tool_use"`) never satisfies that predicate, so the
  // provider-executed request-half can never leak into `toolCalls` and be
  // re-dispatched by the framework's tool executor. Proven in
  // `provider-web-search.spec.ts`.
  //
  // One interner per normalize (per turn): the same consulted document / web
  // page across many text blocks / citation spans mints one `Source` with one
  // turn-stable id, so `Citation.sourceId` resolves and the message-level
  // roll-up dedupes.
  const interner = createSourceInterner();
  const output = anthropicContentToContentBlocks(raw.content, interner);
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
  interner: SourceInterner,
): ContentBlock[] {
  const output: ContentBlock[] = [];
  if (!content) return output;
  // Correlate provider-executed server-tool requests to their results:
  // `server_tool_use` (the request half) precedes its `web_search_tool_result`
  // in the same content array, so a single forward pass suffices. Keyed by the
  // server-tool `id` → its `name` (e.g. `"web_search"`) for the result's
  // `ToolResultBlock.name`.
  const serverToolNames = new Map<string, string>();
  for (const block of content) {
    // Provider-executed server tools (web search) — wire-only shapes the pinned
    // SDK does not type. Detect STRUCTURALLY, BEFORE the SDK-typed switch.
    const wireType = (block as { type: string }).type;
    if (wireType === "server_tool_use") {
      // The REQUEST half. NOT a canonical block and NOT a dispatchable
      // `tool_use` — record its name for the result, then drop it.
      const stu = block as unknown as AnthropicServerToolUseBlockWire;
      serverToolNames.set(stu.id, stu.name);
      continue;
    }
    if (wireType === "web_search_tool_result") {
      const wstr = block as unknown as AnthropicWebSearchToolResultBlockWire;
      const toolName = serverToolNames.get(wstr.tool_use_id) ?? "web_search";
      output.push(anthropicWebSearchResultBlock(wstr, toolName, interner));
      continue;
    }
    switch (block.type) {
      case "text": {
        const tb = block as AnthropicTextBlock;
        if (tb.text.length > 0) {
          const { citations, sources } = anthropicCitationsToCitations(tb.citations, interner);
          output.push({
            type: "text",
            text: tb.text,
            ...(citations.length > 0 ? { citations, sources } : {}),
          });
        }
        break;
      }
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
          ...(t.signature ? { providerMetadata: { anthropic: { signature: t.signature } } } : {}),
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

/**
 * Pass D provenance-half: map Anthropic's `TextBlock.citations` (document
 * citations) onto the canonical {@link Citation}. All three SDK-typed
 * `TextCitation` variants (`char_location` / `page_location` /
 * `content_block_location`) carry `document_index` + `document_title` +
 * `cited_text`; only the span axis differs (char / page / block index), which
 * all fold onto {@link Citation.range}. `document_index` is an index into the
 * request's documents → {@link Source.documentIndex}.
 *
 * Sources are normalized: each citation references a {@link Source} by
 * {@link Citation.sourceId} (minted / deduped via the turn-scoped `interner`),
 * and the block's referenced `Source` entities are returned alongside for the
 * caller to attach as {@link BaseContentBlock.sources}.
 *
 * Web-search provenance (Pass A, optimistic): the pinned
 * `@anthropic-ai/sdk@0.39.0` still does NOT type the `web_search_result_location`
 * citation variant (nor the `server_tool_use` / `web_search_tool_result`
 * blocks), but the wire delivers it. It is detected STRUCTURALLY here and
 * interned by URL (a WEB source), consistent with the document-citation path
 * (interned by `documentIndex`). Replace with the SDK's own `TextCitation`
 * member once the server-tools bump lands.
 */
function anthropicCitationsToCitations(
  citations: readonly TextCitation[] | null | undefined,
  interner: SourceInterner,
): { citations: Citation[]; sources: Source[] } {
  if (!citations || citations.length === 0) return { citations: [], sources: [] };
  const out: Citation[] = [];
  const blockSources = new Map<string, Source>();
  for (const c of citations) {
    // Web-search citation (wire-only variant) — intern by URL, not documentIndex.
    if ((c as { type: string }).type === "web_search_result_location") {
      const wc = c as unknown as AnthropicWebSearchResultLocationCitationWire;
      const webSource = interner.intern({
        url: wc.url,
        ...(wc.title ? { title: wc.title } : {}),
      });
      blockSources.set(webSource.id, webSource);
      out.push({
        sourceId: webSource.id,
        ...(wc.cited_text ? { citedText: wc.cited_text } : {}),
      });
      continue;
    }
    const source = interner.intern({
      documentIndex: c.document_index,
      ...(c.document_title ? { title: c.document_title } : {}),
    });
    blockSources.set(source.id, source);
    let range: { start: number; end: number } | undefined;
    switch (c.type) {
      case "char_location":
        range = { start: c.start_char_index, end: c.end_char_index };
        break;
      case "page_location":
        range = { start: c.start_page_number, end: c.end_page_number };
        break;
      case "content_block_location":
        range = { start: c.start_block_index, end: c.end_block_index };
        break;
    }
    out.push({
      sourceId: source.id,
      ...(c.cited_text ? { citedText: c.cited_text } : {}),
      ...(range ? { range } : {}),
    });
  }
  return { citations: out, sources: [...blockSources.values()] };
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
