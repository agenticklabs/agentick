/**
 * `chatjimmy(model?, options?)` — the ChatJimmy `LanguageModelAdapter` (ADR 52).
 *
 * ChatJimmy fronts Taalas's hardware-embodied Llama at
 * `POST https://chatjimmy.ai/api/chat`. The wire is its own: a `{ messages,
 * chatOptions, attachment }` body in, raw completion text plus one
 * `<|stats|>{…}<|/stats|>` trailer out. No auth, no SDK, text only. The
 * model decodes at ~16k tokens/s, so a whole reply usually arrives in one
 * network chunk; the streaming path exists for contract parity, not latency.
 *
 * ```ts
 * const app = await createApp(<Agent />, { model: chatjimmy() });
 * ```
 */

import {
  defaultFinalizeStream,
  defineLanguageModelAdapter,
  lowerSemanticRole,
  type LanguageModelAdapter,
  type StreamAccumulatorView,
} from "@agentick/model";
import type {
  AdapterDelta,
  ExecuteInput,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelMessagePart,
  LanguageModelMessageRole,
  LanguageModelStopReason,
  ProviderOptions,
  RateCard,
  UsageStats,
} from "@agentick/spec";
import { mergeProviderOptions, SPEC_VERSION } from "@agentick/spec";
import * as blocks from "@agentick/spec/blocks";
import { omitUndefined } from "@agentick/utils";

import { splitStatsTrailer, StatsTrailerSplitter, type StatsTrailer } from "./stats-trailer.js";

// ============================================================================
// Wire shapes
// ============================================================================

export interface ChatJimmyMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface ChatJimmyChatOptions {
  readonly selectedModel: string;
  readonly systemPrompt: string;
  readonly topK: number;
}

export interface ChatJimmyRequest {
  readonly messages: readonly ChatJimmyMessage[];
  readonly chatOptions: ChatJimmyChatOptions;
  readonly attachment: null;
}

/** The `<|stats|>` trailer, verbatim. Only the fields normalize reads are named. */
export interface ChatJimmyStats extends StatsTrailer {
  readonly done_reason?: string;
  readonly prefill_tokens?: number;
  readonly decode_tokens?: number;
  readonly total_tokens?: number;
}

export interface ChatJimmyResponse {
  readonly text: string;
  readonly stats?: ChatJimmyStats;
  readonly model: string;
}

/** One streamed piece — text already separated from the trailer. */
export interface ChatJimmyChunk {
  readonly text?: string;
  readonly stats?: ChatJimmyStats;
}

// ============================================================================
// ProviderOptions augmentation
// ============================================================================

export interface ChatJimmyClientOptions {
  /** Default `https://chatjimmy.ai`. */
  readonly baseURL?: string;
  /** Sent on every request over the defaults (`Origin`, `Referer`, `Content-Type`). */
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof fetch;
}

declare module "@agentick/spec" {
  interface ProviderClientOptions {
    readonly chatjimmy?: ChatJimmyClientOptions;
  }
  interface ProviderOptions {
    readonly chatjimmy?: Partial<ChatJimmyChatOptions>;
  }
}

// ============================================================================
// Construction
// ============================================================================

export interface ChatJimmyAdapterOptions {
  readonly clientOptions?: ChatJimmyClientOptions;
  /** `chatOptions.topK` default. The site sends 8. */
  readonly topK?: number;
  /** Drive the streaming call from `execute()` too. Default false. */
  readonly stream?: boolean;
  readonly target?: ExecutionTarget;
  readonly rates?: RateCard;
  readonly providerOptions?: ProviderOptions;
}

export const DEFAULT_CHATJIMMY_MODEL = "llama3.1-8B";
export const DEFAULT_CHATJIMMY_BASE_URL = "https://chatjimmy.ai";
const DEFAULT_TOP_K = 8;

const DEFAULT_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "application/json",
  Accept: "text/event-stream",
  Origin: DEFAULT_CHATJIMMY_BASE_URL,
  Referer: `${DEFAULT_CHATJIMMY_BASE_URL}/`,
};

/** A non-2xx answer. `status` is what the executor's default classification reads. */
export class ChatJimmyHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`chatjimmy: HTTP ${status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    this.name = "ChatJimmyHttpError";
  }
}

export function chatjimmy(
  model: string = DEFAULT_CHATJIMMY_MODEL,
  options: ChatJimmyAdapterOptions = {},
): LanguageModelAdapter<ChatJimmyResponse, ChatJimmyChunk, ChatJimmyRequest> {
  const baseTarget: ExecutionTarget = options.target ?? {
    kind: "language-model",
    provider: "chatjimmy",
    modelId: model,
    capabilities: {
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsStreaming: true,
      supportsJsonSchema: false,
      media: {},
    },
  };
  const target: ExecutionTarget = {
    ...baseTarget,
    ...omitUndefined({
      rates: options.rates,
      providerOptions: mergeProviderOptions(baseTarget.providerOptions, options.providerOptions),
    }),
  };
  const client = options.clientOptions ?? {};
  const baseURL = (client.baseURL ?? DEFAULT_CHATJIMMY_BASE_URL).replace(/\/$/, "");
  const headers = { ...DEFAULT_HEADERS, ...client.headers };
  const fetchImpl = client.fetch ?? fetch;
  const topK = options.topK ?? DEFAULT_TOP_K;

  const post = async (request: ChatJimmyRequest, signal: AbortSignal | undefined) => {
    const response = await fetchImpl(`${baseURL}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new ChatJimmyHttpError(response.status, await response.text());
    return response;
  };

  return defineLanguageModelAdapter<ChatJimmyResponse, ChatJimmyChunk, ChatJimmyRequest>({
    provider: "chatjimmy",
    target,
    streamByDefault: options.stream ?? false,

    prepareRequest(input) {
      return toRequest(input, model, topK);
    },

    async send(request, signal) {
      const response = await post(request, signal);
      const { text, stats } = splitStatsTrailer(await response.text());
      return { text, model: request.chatOptions.selectedModel, ...(stats ? { stats } : {}) };
    },

    async openStream(request, signal) {
      const response = await post(request, signal);
      return chunksOf(response);
    },

    mapChunk(chunk, accum) {
      const deltas: AdapterDelta[] = [];
      if (chunk.stats) accum.providerExtra = chunk.stats;
      if (chunk.text) {
        if (!accum.openBlocks.has(0) && !accum.textByBlock.has(0)) {
          deltas.push({ type: "content-start", blockIndex: 0, blockType: "text" });
        }
        deltas.push({ type: "content-delta", blockIndex: 0, delta: chunk.text });
      }
      return deltas;
    },

    finalizeStream(accum) {
      const stats = statsOf(accum);
      accum.stopReason = stopReasonOf(stats);
      accum.usage = usageOf(stats);
      return defaultFinalizeStream(accum);
    },

    reconstructRaw(accum, modelSeen) {
      const stats = statsOf(accum);
      return {
        text: accum.totalText(),
        model: modelSeen ?? model,
        ...(stats ? { stats } : {}),
      };
    },

    normalize(raw) {
      return normalizeResponse(raw);
    },

    extractMetadata(raw) {
      return raw.stats ? { chatjimmy: raw.stats } : undefined;
    },
  });
}

// ============================================================================
// Request assembly
// ============================================================================

/**
 * `system` is legal anywhere in ChatJimmy's message list, which makes it the
 * landing for `grounding` too. A tool result is text the model should read
 * as a turn, so it goes in as `user` with the flattened body.
 */
const CHATJIMMY_ROLES = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "user",
  grounding: "system",
  event: "user",
} as const satisfies Record<LanguageModelMessageRole, ChatJimmyMessage["role"]>;

function toRequest(
  input: ExecuteInput<LanguageModelInput>,
  defaultModel: string,
  topK: number,
): ChatJimmyRequest {
  const overrides = mergeProviderOptions(
    input.target.providerOptions,
    input.targetInput.providerOptions,
  )?.chatjimmy;
  return {
    messages: input.targetInput.messages.map(toMessage),
    chatOptions: {
      selectedModel: input.target.modelId ?? defaultModel,
      systemPrompt: "",
      topK,
      ...omitUndefined(overrides ?? {}),
    },
    attachment: null,
  };
}

function toMessage(message: LanguageModelMessage): ChatJimmyMessage {
  return {
    role: lowerSemanticRole(message.role, CHATJIMMY_ROLES),
    content: message.content
      .map(textOf)
      .filter((text) => text.length > 0)
      .join("\n\n"),
  };
}

function textOf(part: LanguageModelMessagePart): string {
  switch (part.type) {
    case "text":
      return part.text;
    case "tool_use":
      return `[tool_use ${part.name}] ${JSON.stringify(part.input ?? {})}`;
    case "tool_result": {
      const text = part.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      return text || (part.isError ? "[error]" : "[done]");
    }
    default:
      return "";
  }
}

// ============================================================================
// Response normalization
// ============================================================================

async function* chunksOf(response: Response): AsyncIterable<ChatJimmyChunk> {
  const splitter = new StatsTrailerSplitter();
  if (response.body === null) {
    const split = splitStatsTrailer(await response.text());
    if (split.text || split.stats) yield split;
    return;
  }
  const decoder = new TextDecoder();
  for await (const bytes of response.body) {
    const piece = splitter.push(decoder.decode(bytes, { stream: true }));
    if (piece.text || piece.stats) yield piece;
  }
  const tail = splitter.push(decoder.decode()).text + splitter.flush();
  if (tail) yield { text: tail };
}

function statsOf(accum: StreamAccumulatorView): ChatJimmyStats | undefined {
  const extra = accum.providerExtra;
  return typeof extra === "object" && extra !== null ? (extra as ChatJimmyStats) : undefined;
}

function normalizeResponse(raw: ChatJimmyResponse): LanguageModelExecutionResult {
  return {
    specVersion: SPEC_VERSION,
    output: raw.text.length > 0 ? [blocks.text(raw.text)] : [],
    stopReason: stopReasonOf(raw.stats),
    usage: usageOf(raw.stats),
    raw,
  };
}

function stopReasonOf(stats: ChatJimmyStats | undefined): LanguageModelStopReason {
  switch (stats?.done_reason) {
    case undefined:
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    default:
      return "other";
  }
}

function usageOf(stats: ChatJimmyStats | undefined): UsageStats {
  const inputTokens = stats?.prefill_tokens ?? 0;
  const outputTokens = stats?.decode_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: stats?.total_tokens ?? inputTokens + outputTokens,
  };
}
