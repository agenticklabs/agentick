/**
 * Token estimation over a projected {@link LanguageModelInput} — what the
 * request will cost to SEND, measured on the last shape before the wire.
 *
 * Estimating any earlier measures the wrong thing: system text and tool
 * schemas only join the input at the executor's `project` phase, and section
 * formatting (markdown vs XML) changes the character count that feeds every
 * heuristic here.
 *
 * The default arithmetic is `chars / 4` for text and a flat per-block constant
 * for media. Both are coarse. The point is not precision — it is that nothing
 * silently counts as zero, because a systematic blind spot cannot be corrected
 * by a caller who does not know it is there.
 *
 * Accuracy comes from the adapter, which is the only layer that knows how its
 * provider bills a screenshot: it states `mediaTokens` on the target it derives
 * (data, so a deployment can override it through the model registry), and
 * `ModelInfo.tokenEstimator` remains the escape hatch for a real tokenizer.
 */

import type {
  LanguageModelInput,
  LanguageModelMessagePart,
  LanguageModelTool,
  MediaTokenRates,
  TokenEstimate,
} from "@agentick/spec";
import type { ModelInfo } from "./model-info.js";

export type { MediaTokenRates, TokenEstimate };

const CHARS_PER_TOKEN = 4;

/**
 * Per-tool overhead beyond the serialized schema: the delimiters, field names
 * and framing every provider wraps a tool declaration in.
 */
const TOOL_OVERHEAD = 8;

/**
 * The floor, for a target that describes no rates of its own.
 *
 * Every shipped adapter states its provider's rates on the target it derives —
 * that is where the knowledge is, and a table here would be closed to
 * third-party adapters. This exists so an undescribed target scores something
 * rather than nothing; it is mid-range across the shipped providers rather than
 * conservative, because an estimate that is low by default reproduces the
 * blindness it replaced, just more quietly.
 */
export const DEFAULT_MEDIA_TOKENS: MediaTokenRates = {
  image: 1_100,
  document: 1_800,
  audio: 1_900,
  video: 15_000,
};

export interface EstimateOptions {
  readonly info?: ModelInfo;
  readonly media?: Partial<MediaTokenRates>;
}

const fromChars = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

function serializedLength(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

function partChars(part: LanguageModelMessagePart, media: MediaTokenRates): number {
  switch (part.type) {
    case "text":
    case "reasoning":
      return part.text.length;
    case "tool_use":
      return part.name.length + serializedLength(part.input);
    case "tool_result":
      return part.content.reduce((n, child) => n + partChars(child, media), 0);
    // Media is priced whole rather than by character — return its cost
    // pre-multiplied so the single `fromChars` at the top level stays correct.
    case "image":
      return media.image * CHARS_PER_TOKEN;
    case "document":
      return media.document * CHARS_PER_TOKEN;
    case "audio":
      return media.audio * CHARS_PER_TOKEN;
    case "video":
      return media.video * CHARS_PER_TOKEN;
    default: {
      // A new part type breaks the build here rather than scoring zero in
      // production, which is the failure this function was written to end.
      const unreachable: never = part;
      void unreachable;
      return 0;
    }
  }
}

function toolTokens(tool: LanguageModelTool): number {
  const chars =
    tool.name.length +
    (tool.description?.length ?? 0) +
    serializedLength(tool.inputSchema) +
    serializedLength(tool.outputSchema);
  return fromChars(chars) + TOOL_OVERHEAD;
}

function normalize(estimate: number | TokenEstimate): TokenEstimate {
  return typeof estimate === "number"
    ? { messages: estimate, tools: 0, total: estimate }
    : estimate;
}

/**
 * Estimate a request's input cost, split into messages and tools.
 *
 * Delegates wholesale to {@link ModelInfo.tokenEstimator} when an adapter has
 * supplied one — an adapter that reports a bare number is taken to have
 * measured the request as a whole, so the split collapses onto `messages`.
 */
export function estimateTokenBreakdown(
  input: LanguageModelInput | string,
  options: EstimateOptions = {},
): TokenEstimate {
  const { info } = options;
  if (info?.tokenEstimator) return normalize(info.tokenEstimator(input));

  if (typeof input === "string") {
    const messages = fromChars(input.length);
    return { messages, tools: 0, total: messages };
  }

  const media = { ...DEFAULT_MEDIA_TOKENS, ...info?.mediaTokens, ...options.media };
  let chars = 0;
  for (const message of input.messages) {
    for (const part of message.content) chars += partChars(part, media);
  }
  const messages = fromChars(chars);

  // Provider-executed tools carry no schema — the provider owns their
  // arguments — so they contribute nothing an estimate could measure.
  const tools = (input.tools ?? []).reduce((n, tool) => n + toolTokens(tool), 0);

  return { messages, tools, total: messages + tools };
}

/**
 * Estimate the total input tokens for a request.
 *
 * @see estimateTokenBreakdown when the caller needs to act on one part of the
 * request rather than its size.
 */
export function estimateTokens(input: LanguageModelInput | string, info?: ModelInfo): number {
  return estimateTokenBreakdown(input, omitInfo(info)).total;
}

const omitInfo = (info?: ModelInfo): EstimateOptions => (info ? { info } : {});
