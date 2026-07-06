/**
 * `aisdk(model, options?)` — the Vercel AI SDK bridge as a
 * `LanguageModelAdapter` (ADR 52).
 *
 * Wraps any `ai` package `LanguageModel` (whatever the user gets from
 * `openai("gpt-4o")` in `@ai-sdk/openai`, `anthropic(...)` from
 * `@ai-sdk/anthropic`, etc.) as the provider-normalization part
 * consumed by our `LanguageModelExecutor`. The progressive-adoption
 * path — bring existing AI SDK provider setup, get JSX agents +
 * sessions + observability for free.
 *
 *   - `buildParams` folds canonical `LanguageModelInput` → AI SDK
 *     `ModelMessage[]` + generation params.
 *   - `call` invokes `generateText`; `openStream` invokes `streamText`
 *     and yields its `fullStream` parts.
 *   - `mapChunk` translates the `fullStream` vocabulary to
 *     `AdapterDelta`s (duck-typed against SDK version drift).
 *   - `normalize` maps `GenerateTextResult` →
 *     `LanguageModelExecutionResult` (finishReason vocabulary + tool
 *     calls).
 *
 * NOTE: this adapter uses the AI SDK as a PROVIDER LIBRARY — one model
 * call per executor round; agentick runs the loop. The alternative
 * "AI SDK as the execution engine" (their loop, their tool dispatch)
 * is a different ADR 52 archetype and a separate follow-up.
 *
 * @see docs/proposals/v2/blueprint/52-executors-and-model-adapters.md
 */

import {
  generateText,
  streamText,
  type GenerateTextResult,
  type LanguageModel,
  type FinishReason,
  type ModelMessage,
  type ToolSet,
} from "ai";

import { ulid } from "@agentick/utils-next";
import type { LanguageModelAdapter, StreamAccumulatorView } from "@agentick/model-next";
import type {
  AdapterDelta,
  ContentBlock,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelStopReason,
  MediaSource,
  NormalizeInput,
  ProviderOptions,
  ToolCall,
} from "@agentick/spec-next";
import { mergeProviderOptions, SPEC_VERSION } from "@agentick/spec-next";
import { omitUndefined } from "@agentick/utils-next";

// ============================================================================
// Construction options
// ============================================================================

export interface AISDKAdapterOptions {
  /**
   * Optional self-described target. Defaults are inferred from the
   * model's `provider` + `modelId` (when the model is a model handle,
   * not just a string id). Override for non-stock providers or to
   * advertise additional capabilities.
   */
  readonly target?: ExecutionTarget;
}

// ============================================================================
// Internals
// ============================================================================

/**
 * The AI SDK input shape produced by `project()`. Kept opaque to
 * downstream phases — `execute()` consumes it, `normalize()` doesn't
 * see it.
 */
interface AISDKProjectedInput {
  readonly messages: ModelMessage[];
  readonly tools?: ToolSet;
  /**
   * Generation parameters mapped to AI SDK call-level fields (temperature,
   * maxOutputTokens, topP, frequencyPenalty, presencePenalty,
   * stopSequences). Spread onto the streamText/generateText call.
   */
  readonly generation: Record<string, unknown>;
  /**
   * Forwarded directly as AI SDK's `providerOptions` — adopter escape
   * hatch for provider-specific knobs (Anthropic cache control, OpenAI
   * reasoning effort, etc.). Sourced from `target.providerOptions`. Cast
   * to `never` at call sites — the spec carries the looser
   * `Record<string, unknown>` shape than AI SDK's strict
   * `SharedV2ProviderOptions`; runtime shape is the same.
   */
  readonly providerOptions?: never;
}

// ============================================================================
// aisdk() — the adapter factory
// ============================================================================

/** AI SDK's `fullStream` events — duck-typed for SDK version drift. */
type AISDKStreamPart = { type: string } & Record<string, unknown>;

interface AISDKStreamState {
  blockIndex: number;
  textBlockStarted: boolean;
  reasoningBlockStarted: boolean;
  toolCallNameByCallId: Map<string, string>;
  finishReason: FinishReason | null;
}

// AI SDK emits reasoning BEFORE text — reserve a distinct block index so
// it never collides with the text block (0) or tool-call blocks. Mirrors
// the OpenAI adapter's RESERVED_REASONING_BLOCK_INDEX (#213).
const RESERVED_REASONING_BLOCK_INDEX = -1;

function getAISDKState(accum: StreamAccumulatorView): AISDKStreamState {
  let s = accum.providerExtra as AISDKStreamState | undefined;
  if (!s) {
    s = {
      blockIndex: 0,
      textBlockStarted: false,
      reasoningBlockStarted: false,
      toolCallNameByCallId: new Map(),
      finishReason: null,
    };
    accum.providerExtra = s;
  }
  return s;
}

/**
 * Wrap an AI SDK `LanguageModel` as a `LanguageModelAdapter`. Pass it
 * wherever an adapter is accepted — the app's `executor:` slot,
 * `generate({ model: aisdk(openai("gpt-4o")), ... })`, or a
 * hand-constructed `LanguageModelExecutor`.
 *
 * ```ts
 * import { openai } from "@ai-sdk/openai";
 * import { aisdk } from "@agentick/model-ai-sdk-next";
 *
 * const app = await createApp(<Agent />, {
 *   model: aisdk(openai("gpt-4o")),
 * });
 * ```
 */
export function aisdk(
  model: LanguageModel,
  options: AISDKAdapterOptions = {},
): LanguageModelAdapter<unknown, AISDKStreamPart> {
  const target: ExecutionTarget = options.target ?? deriveTarget(model);

  return {
    provider: "ai-sdk",
    target,

    buildParams(input: LanguageModelInput, target: ExecutionTarget): AISDKProjectedInput {
      return toAISDKInput(input, target);
    },

    async call(params: unknown, signal: AbortSignal | undefined): Promise<unknown> {
      const aiSdk = params as AISDKProjectedInput;
      return generateText({
        model: model,
        messages: aiSdk.messages,
        ...omitUndefined({ tools: aiSdk.tools }),
        ...aiSdk.generation,
        ...omitUndefined({ providerOptions: aiSdk.providerOptions, abortSignal: signal }),
      }) as unknown as Promise<unknown>;
    },

    openStream(params: unknown, signal: AbortSignal | undefined): AsyncIterable<AISDKStreamPart> {
      const aiSdk = params as AISDKProjectedInput;
      const stream = streamText({
        model: model,
        messages: aiSdk.messages,
        ...omitUndefined({ tools: aiSdk.tools }),
        ...aiSdk.generation,
        ...(aiSdk.providerOptions !== undefined
          ? { providerOptions: aiSdk.providerOptions as never }
          : {}),
        abortSignal: signal,
      });
      return stream.fullStream as unknown as AsyncIterable<AISDKStreamPart>;
    },

    /**
     * AI SDK's `fullStream` vocabulary → AdapterDelta. Single text block
     * + tool calls; minor SDK version drift handled with duck-typing.
     */
    mapChunk(part: AISDKStreamPart, accum: StreamAccumulatorView): readonly AdapterDelta[] {
      const state = getAISDKState(accum);
      const out: AdapterDelta[] = [];
      switch (part.type) {
        case "text-start": {
          if (!state.textBlockStarted) {
            state.textBlockStarted = true;
            out.push({
              type: "content-start",
              blockIndex: state.blockIndex,
              blockType: "text",
            });
          }
          break;
        }
        case "text-delta":
        case "text": {
          const delta =
            (part as { text?: string; delta?: string }).text ??
            (part as { delta?: string }).delta ??
            "";
          if (!state.textBlockStarted) {
            state.textBlockStarted = true;
            out.push({
              type: "content-start",
              blockIndex: state.blockIndex,
              blockType: "text",
            });
          }
          if (delta.length > 0) {
            out.push({ type: "content-delta", blockIndex: state.blockIndex, delta });
          }
          break;
        }
        case "text-end":
          // text-end closes a streaming text block; finalize emits the
          // symmetric content/content-end summary.
          break;
        case "tool-input-start": {
          const callId =
            (part.toolCallId as string | undefined) ??
            (part.id as string | undefined) ??
            `tc_${ulid()}`;
          const name = (part.toolName as string | undefined) ?? "";
          state.toolCallNameByCallId.set(callId, name);
          out.push({
            type: "tool-call-start",
            callId,
            name,
            blockIndex: state.blockIndex,
          });
          break;
        }
        case "tool-input-delta": {
          const callId =
            (part.toolCallId as string | undefined) ?? (part.id as string | undefined) ?? "";
          const delta =
            (part.argsTextDelta as string | undefined) ?? (part.delta as string | undefined) ?? "";
          if (callId && delta) {
            out.push({ type: "tool-call-delta", callId, delta });
          }
          break;
        }
        case "tool-input-end":
        case "tool-call": {
          const callId =
            (part.toolCallId as string | undefined) ?? (part.id as string | undefined) ?? "";
          const name =
            (part.toolName as string | undefined) ?? state.toolCallNameByCallId.get(callId) ?? "";
          if (!accum.toolCalls.has(callId)) {
            // Provider skipped tool-input-start; synthesize for symmetry.
            out.push({ type: "tool-call-start", callId, name, blockIndex: state.blockIndex });
          }
          // tool-call-end + tool-call (with parsed input) — accumulator
          // resolves input via argsBuffer + the optional `input` field.
          const inputObj =
            (part.input as Readonly<Record<string, unknown>> | undefined) ??
            (part.args as Readonly<Record<string, unknown>> | undefined);
          out.push({ type: "tool-call-end", callId });
          out.push({
            type: "tool-call",
            callId,
            name,
            input: inputObj ?? accum.toolCallInput(callId),
          });
          break;
        }
        case "reasoning-start": {
          // AI SDK 5 reasoning stream (#213). One reserved reasoning block
          // holds the concatenated thinking; the accumulator surfaces it
          // as a `reasoning` ContentBlock on finalize.
          if (!state.reasoningBlockStarted) {
            state.reasoningBlockStarted = true;
            out.push({ type: "reasoning-start", blockIndex: RESERVED_REASONING_BLOCK_INDEX });
          }
          break;
        }
        case "reasoning-delta":
        case "reasoning": {
          const delta =
            (part as { delta?: string }).delta ?? (part as { text?: string }).text ?? "";
          if (!state.reasoningBlockStarted) {
            state.reasoningBlockStarted = true;
            out.push({ type: "reasoning-start", blockIndex: RESERVED_REASONING_BLOCK_INDEX });
          }
          if (delta.length > 0) {
            out.push({
              type: "reasoning-delta",
              blockIndex: RESERVED_REASONING_BLOCK_INDEX,
              delta,
            });
          }
          break;
        }
        case "reasoning-end": {
          if (state.reasoningBlockStarted) {
            out.push({ type: "reasoning-end", blockIndex: RESERVED_REASONING_BLOCK_INDEX });
          }
          break;
        }
        case "finish":
        case "finish-step": {
          const fin = part.finishReason as FinishReason | undefined;
          const us = part.usage as
            | {
                inputTokens?: number;
                outputTokens?: number;
                totalTokens?: number;
                reasoningTokens?: number;
                cachedInputTokens?: number;
                cacheCreationTokens?: number;
              }
            | undefined;
          if (fin) state.finishReason = fin;
          if (us) {
            out.push({
              type: "usage",
              usage: {
                inputTokens: us.inputTokens ?? 0,
                outputTokens: us.outputTokens ?? 0,
                totalTokens: us.totalTokens ?? 0,
                ...omitUndefined({
                  reasoningTokens: us.reasoningTokens,
                  cachedInputTokens: us.cachedInputTokens,
                  cacheCreationTokens: us.cacheCreationTokens,
                }),
              },
            });
          }
          break;
        }
        case "error": {
          const err = part.error;
          out.push({
            type: "error",
            error: { message: err instanceof Error ? err.message : String(err) },
          });
          break;
        }
        default:
          // Files, sources, source-document — not yet mapped. (Reasoning
          // is handled above, #213.)
          break;
      }
      return out;
    },

    /**
     * Synthesize an AI SDK-compatible result shape from accumulator
     * state. The non-streaming path returns the real `GenerateTextResult`;
     * the streaming path synthesizes a duck-compatible one so
     * `normalizeRaw` narrows uniformly.
     */
    reconstructRaw(accum: StreamAccumulatorView, _modelSeen: string | undefined): unknown {
      const state = getAISDKState(accum);
      const text = accum.totalText();
      const toolCalls = Array.from(accum.toolCalls.values()).map((tc) => {
        let parsed: Readonly<Record<string, unknown>> = {};
        try {
          parsed =
            tc.input ?? (JSON.parse(tc.argsBuffer || "{}") as Readonly<Record<string, unknown>>);
        } catch {
          parsed = tc.input ?? {};
        }
        return { toolCallId: tc.callId, toolName: tc.name, input: parsed };
      });
      // Re-embed accumulated reasoning so `normalize` surfaces it on the
      // streaming path too (#213) — mirrors OpenAI reconstructing
      // `reasoning_content`. Shaped as the AI SDK `reasoning` parts +
      // `reasoningText` string that `normalizeImpl` reads.
      const reasoningText = accum.totalReasoning();
      return {
        text,
        finishReason: (state.finishReason ?? mapBackFinishReason(accum.stopReason)) as FinishReason,
        ...(reasoningText.length > 0
          ? { reasoning: [{ type: "reasoning", text: reasoningText }], reasoningText }
          : {}),
        usage: {
          inputTokens: accum.usage.inputTokens,
          outputTokens: accum.usage.outputTokens,
          totalTokens: accum.usage.totalTokens,
          ...(accum.usage.reasoningTokens !== undefined
            ? { reasoningTokens: accum.usage.reasoningTokens }
            : {}),
        },
        toolCalls,
      };
    },

    normalize(raw: unknown): LanguageModelExecutionResult {
      return normalizeImpl({ targetOutput: raw, target });
    },
  };
}

// ============================================================================
// LanguageModelInput → AI SDK input
// ============================================================================

function toAISDKInput(input: LanguageModelInput, target: ExecutionTarget): AISDKProjectedInput {
  const messages: ModelMessage[] = [];
  for (const m of input.messages) {
    messages.push(...toAISDKMessage(m));
  }
  const p = input.parameters;
  const generation: Record<string, unknown> = {};
  if (p?.temperature !== undefined) generation.temperature = p.temperature;
  if (p?.maxOutputTokens !== undefined) generation.maxOutputTokens = p.maxOutputTokens;
  if (p?.topP !== undefined) generation.topP = p.topP;
  if (p?.frequencyPenalty !== undefined) generation.frequencyPenalty = p.frequencyPenalty;
  if (p?.presencePenalty !== undefined) generation.presencePenalty = p.presencePenalty;
  if (p?.stopSequences !== undefined) {
    generation.stopSequences = [...p.stopSequences];
  }
  // #176: fold `input.providerOptions` (project-time tree-over-target)
  // over the target's own bag; merged defensively so a direct
  // `buildParams(input, target)` still forwards the escape hatch.
  const providerOptions = mergeProviderOptions(target.providerOptions, input.providerOptions);
  const result: AISDKProjectedInput = {
    messages,
    generation,
    ...(providerOptions !== undefined ? { providerOptions: providerOptions as never } : {}),
  };
  return result;
}

/**
 * v2 spec carries the per-part **input** provider-knob channel as
 * `providerOptions` (ADR 57 §2 — "what you send"), keyed by provider
 * namespace (`anthropic`, `openai`, `google`). AI SDK 5 accepts the
 * same per-part shape under the same field name — forward it verbatim.
 */
/**
 * Project a {@link MediaSource} to AI SDK 5's `file` part `data` field.
 * base64 payloads pass through as the raw string; every other source
 * (url / gcs / s3 / reference) becomes a URL the SDK fetches or forwards.
 */
function aiSDKFileData(source: MediaSource): { data: string } {
  switch (source.type) {
    case "base64":
      return { data: source.data };
    case "url":
      return { data: source.url };
    case "gcs":
      return { data: `gs://${source.bucket}/${source.object}` };
    case "s3":
      return { data: `s3://${source.bucket}/${source.key}` };
    case "reference":
      return { data: source.fileId };
  }
}

function partProviderOptions(part: {
  readonly providerOptions?: ProviderOptions;
}): { providerOptions: Record<string, Record<string, unknown>> } | object {
  return part.providerOptions !== undefined
    ? { providerOptions: part.providerOptions as Record<string, Record<string, unknown>> }
    : {};
}

/**
 * Message-level provider knobs (#173). Carried from
 * `MessageEntry.metadata.providerMetadata` onto `LanguageModelMessage.
 * providerOptions` at projection; AI SDK's `ModelMessage.providerOptions`
 * is the 1:1 destination (the other adapters have no message-level slot
 * and ignore it).
 */
function messageProviderOptions(m: {
  readonly providerOptions?: ProviderOptions;
}): { providerOptions: NonNullable<ModelMessage["providerOptions"]> } | object {
  return m.providerOptions !== undefined
    ? { providerOptions: m.providerOptions as NonNullable<ModelMessage["providerOptions"]> }
    : {};
}

function toAISDKMessage(m: LanguageModelMessage): ModelMessage[] {
  // AI SDK splits messages by role with specific content shapes.
  switch (m.role) {
    case "system":
      return [
        {
          role: "system",
          content: m.content
            .filter((p): p is { type: "text"; text: string } => p.type === "text")
            .map((p) => p.text)
            .join("\n"),
          ...messageProviderOptions(m),
        },
      ];
    case "user":
      return [
        {
          role: "user",
          ...messageProviderOptions(m),
          content: m.content.map((p) => {
            if (p.type === "text") {
              return { type: "text", text: p.text, ...partProviderOptions(p) };
            }
            if (p.type === "image") {
              return {
                type: "image",
                image: p.imageUrl,
                ...omitUndefined({ mediaType: p.mediaType }),
                ...partProviderOptions(p),
              };
            }
            if (p.type === "document" || p.type === "audio" || p.type === "video") {
              // AI SDK 5 carries all non-image binary modalities as a
              // `file` part (data + mediaType).
              return {
                type: "file",
                ...aiSDKFileData(p.source),
                mediaType: p.mediaType ?? p.source.mimeType ?? "application/octet-stream",
                ...partProviderOptions(p),
              };
            }
            // Fallback — flatten to text.
            return {
              type: "text",
              text: JSON.stringify(p),
            };
          }),
        } as ModelMessage,
      ];
    case "assistant": {
      const parts: unknown[] = [];
      for (const p of m.content) {
        if (p.type === "text") {
          parts.push({ type: "text", text: p.text, ...partProviderOptions(p) });
        } else if (p.type === "reasoning") {
          // AI SDK 5 replays reasoning as a `reasoning` part; the signed
          // payload rides `providerOptions` for providers that require it.
          parts.push({ type: "reasoning", text: p.text, ...partProviderOptions(p) });
        } else if (p.type === "tool_use") {
          parts.push({
            type: "tool-call",
            toolCallId: p.id,
            toolName: p.name,
            input: p.input,
            ...partProviderOptions(p),
          });
        }
      }
      return [{ role: "assistant", content: parts, ...messageProviderOptions(m) } as ModelMessage];
    }
    case "tool": {
      // Each tool_result block becomes its own tool-result part. AI SDK
      // expects one ToolModelMessage per turn carrying all results.
      const parts: unknown[] = [];
      for (const p of m.content) {
        if (p.type === "tool_result") {
          const textOnly = p.content
            .filter((c): c is { type: "text"; text: string } => c.type === "text")
            .map((c) => c.text)
            .join("\n");
          parts.push({
            type: "tool-result",
            toolCallId: p.toolUseId,
            toolName: "unknown",
            output: { type: "text", value: textOnly || "[done]" },
            ...partProviderOptions(p),
          });
        }
      }
      return parts.length > 0
        ? [{ role: "tool", content: parts, ...messageProviderOptions(m) } as ModelMessage]
        : [];
    }
    default:
      return [];
  }
}

// ============================================================================
// AI SDK result → LanguageModelExecutionResult
// ============================================================================

function normalizeImpl(input: NormalizeInput<unknown>): LanguageModelExecutionResult {
  const raw = input.targetOutput as GenerateTextResult<ToolSet, unknown>;
  if (!raw || typeof raw !== "object") {
    throw new Error("normalize expected an AI SDK GenerateTextResult");
  }

  const output: ContentBlock[] = [];
  // Reasoning rides before text — v1 parity (adapter.ts:354) and matches
  // the other three adapters (#213). AI SDK 5 surfaces reasoning parts on
  // `raw.reasoning` (typed) with `reasoningText` as the concatenation;
  // preserve per-block signatures where present.
  const reasoningParts = (raw as { reasoning?: ReadonlyArray<{ text?: string }> }).reasoning;
  if (Array.isArray(reasoningParts) && reasoningParts.length > 0) {
    for (const rp of reasoningParts) {
      if (typeof rp.text === "string" && rp.text.length > 0) {
        output.push({ type: "reasoning", text: rp.text });
      }
    }
  } else {
    const reasoningText = (raw as { reasoningText?: unknown }).reasoningText;
    if (typeof reasoningText === "string" && reasoningText.length > 0) {
      output.push({ type: "reasoning", text: reasoningText });
    }
  }
  if (typeof raw.text === "string" && raw.text.length > 0) {
    output.push({ type: "text", text: raw.text });
  }

  const toolCalls: ToolCall[] = [];
  for (const tc of raw.toolCalls ?? []) {
    const tcAny = tc as {
      toolCallId: string;
      toolName: string;
      input: unknown;
    };
    const inputObj =
      tcAny.input && typeof tcAny.input === "object" && !Array.isArray(tcAny.input)
        ? (tcAny.input as Record<string, unknown>)
        : { value: tcAny.input };
    toolCalls.push({
      id: tcAny.toolCallId,
      name: tcAny.toolName,
      input: inputObj,
    });
    output.push({
      type: "tool_use",
      toolUseId: tcAny.toolCallId,
      name: tcAny.toolName,
      input: inputObj,
    });
  }

  const rawUsage = raw.usage as
    | {
        inputTokens?: number;
        outputTokens?: number;
        totalTokens?: number;
        reasoningTokens?: number;
        cachedInputTokens?: number;
        cacheCreationTokens?: number;
      }
    | undefined;
  const result: LanguageModelExecutionResult = {
    specVersion: SPEC_VERSION,
    output,
    stopReason: mapFinishReason(raw.finishReason),
    usage: {
      inputTokens: rawUsage?.inputTokens ?? 0,
      outputTokens: rawUsage?.outputTokens ?? 0,
      totalTokens: rawUsage?.totalTokens ?? 0,
      // v1 surfaced reasoningTokens (adapter.ts:391) — restore parity (#217).
      ...(rawUsage?.reasoningTokens !== undefined
        ? { reasoningTokens: rawUsage.reasoningTokens }
        : {}),
      ...(rawUsage?.cachedInputTokens !== undefined
        ? { cachedInputTokens: rawUsage.cachedInputTokens }
        : {}),
      ...(rawUsage?.cacheCreationTokens !== undefined
        ? { cacheCreationTokens: rawUsage.cacheCreationTokens }
        : {}),
    },
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
    raw,
  };
  return result;
}

function mapFinishReason(reason: FinishReason): LanguageModelStopReason {
  switch (reason) {
    case "stop":
      return "end";
    case "length":
      return "max_tokens";
    case "content-filter":
      return "content_filter";
    case "tool-calls":
      return "tool_use";
    default:
      return "other";
  }
}

function mapBackFinishReason(reason: LanguageModelStopReason): FinishReason {
  switch (reason) {
    case "end":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool-calls";
    case "content_filter":
      return "content-filter";
    default:
      return "stop";
  }
}

// ============================================================================
// Helpers
// ============================================================================

function deriveTarget(model: LanguageModel): ExecutionTarget {
  if (typeof model === "string") {
    return {
      kind: "language-model",
      provider: "ai-sdk",
      modelId: model,
      capabilities: { supportsTools: true, supportsStreaming: true },
    };
  }
  return {
    kind: "language-model",
    provider: model.provider ?? "ai-sdk",
    modelId: model.modelId ?? "unknown",
    capabilities: { supportsTools: true, supportsStreaming: true },
  };
}
