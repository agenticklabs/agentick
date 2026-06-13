/**
 * `AISDKExecutor` — `LanguageModelExecutor` backed by Vercel AI SDK.
 *
 * Wraps any `ai` package `LanguageModel` (whatever the user gets from
 * `openai("gpt-4o")` in `@ai-sdk/openai`, `anthropic(...)` from
 * `@ai-sdk/anthropic`, etc.) as our `LanguageModelExecutor`. The
 * progressive-adoption path — bring existing AI SDK code, get JSX
 * agents + sessions + observability for free.
 *
 * Behavior:
 *   - `project()` folds the rendered tree → AI SDK `ModelMessage[]` +
 *     tool descriptors.
 *   - `execute()` invokes `generateText({ model, messages, tools? })`.
 *     Streaming via `streamText` is a follow-up.
 *   - `normalize()` maps the AI SDK `GenerateTextResult` into our
 *     `LanguageModelExecutionResult`, translating the finishReason
 *     vocabulary and extracting tool calls.
 *   - `abort()` cancels in-flight via AbortController plumbed through
 *     AI SDK's `abortSignal` option.
 *
 * MVP scope — tools defined in JSX flow through the normal Agentick
 * tool-executor harness. Tools passed via the `aisdk({ tools })` slot
 * also register with the app's handler resolver (Phase 5.3a — see
 * factory module). This gives observability uniformity:
 * `app.events({ surface: "tool" })` sees all dispatches regardless of
 * which side declared the tool.
 *
 * @see docs/proposals/v2/blueprint/06-executor-harness.md
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

import { ulid } from "@agentick/runtime-next";
import { BaseLanguageModelExecutor, type StreamAccumulator } from "@agentick/executor-next";
import type { EventBus, MessageInbox, OperationJournal } from "@agentick/spec-next";
import type {
  AdapterDelta,
  ContentBlock,
  ExecutionTarget,
  LanguageModelExecutionResult,
  LanguageModelInput,
  LanguageModelMessage,
  LanguageModelStopReason,
  NormalizeInput,
  ToolCall,
} from "@agentick/spec-next";
import { SPEC_VERSION } from "@agentick/spec-next";

// ============================================================================
// Construction options
// ============================================================================

export interface AISDKExecutorOptions {
  /** The AI SDK `LanguageModel` to invoke. */
  readonly model: LanguageModel;
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
// AISDKExecutor
// ============================================================================

/** AI SDK's `fullStream` events — duck-typed for SDK version drift. */
type AISDKStreamPart = { type: string } & Record<string, unknown>;

interface AISDKStreamState {
  blockIndex: number;
  textBlockStarted: boolean;
  toolCallNameByCallId: Map<string, string>;
  finishReason: FinishReason | null;
}

function getAISDKState(accum: StreamAccumulator): AISDKStreamState {
  let s = accum.providerExtra as AISDKStreamState | undefined;
  if (!s) {
    s = {
      blockIndex: 0,
      textBlockStarted: false,
      toolCallNameByCallId: new Map(),
      finishReason: null,
    };
    accum.providerExtra = s;
  }
  return s;
}

export class AISDKExecutor extends BaseLanguageModelExecutor<unknown, AISDKStreamPart> {
  readonly target: ExecutionTarget;

  private readonly model: LanguageModel;

  constructor(
    scopeId: string,
    journal: OperationJournal,
    bus: EventBus,
    inbox: MessageInbox,
    options: AISDKExecutorOptions,
  ) {
    super(scopeId, journal, bus, inbox);
    this.model = options.model;
    this.target = options.target ?? deriveTarget(options.model);
  }

  // ──────── Hooks (BaseLanguageModelExecutor) ────────

  protected buildParams(input: LanguageModelInput, target: ExecutionTarget): AISDKProjectedInput {
    return toAISDKInput(input, target);
  }

  protected async callProvider(params: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const aiSdk = params as AISDKProjectedInput;
    return generateText({
      model: this.model,
      messages: aiSdk.messages,
      ...(aiSdk.tools !== undefined ? { tools: aiSdk.tools } : {}),
      ...aiSdk.generation,
      ...(aiSdk.providerOptions !== undefined ? { providerOptions: aiSdk.providerOptions } : {}),
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    }) as unknown as Promise<unknown>;
  }

  // ──────── Streaming hooks (BaseLanguageModelExecutor) ────────

  protected openStream(params: unknown, signal: AbortSignal): AsyncIterable<AISDKStreamPart> {
    const aiSdk = params as AISDKProjectedInput;
    const stream = streamText({
      model: this.model,
      messages: aiSdk.messages,
      ...(aiSdk.tools !== undefined ? { tools: aiSdk.tools } : {}),
      ...aiSdk.generation,
      ...(aiSdk.providerOptions !== undefined
        ? { providerOptions: aiSdk.providerOptions as never }
        : {}),
      abortSignal: signal,
    });
    return stream.fullStream as unknown as AsyncIterable<AISDKStreamPart>;
  }

  /**
   * AI SDK's `fullStream` vocabulary → AdapterDelta. Single text block
   * + tool calls; minor SDK version drift handled with duck-typing.
   */
  protected mapChunk(part: AISDKStreamPart, accum: StreamAccumulator): readonly AdapterDelta[] {
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
      case "finish":
      case "finish-step": {
        const fin = part.finishReason as FinishReason | undefined;
        const us = part.usage as
          | {
              inputTokens?: number;
              outputTokens?: number;
              totalTokens?: number;
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
              ...(us.cachedInputTokens !== undefined
                ? { cachedInputTokens: us.cachedInputTokens }
                : {}),
              ...(us.cacheCreationTokens !== undefined
                ? { cacheCreationTokens: us.cacheCreationTokens }
                : {}),
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
        // Reasoning, files, sources, source-document — not yet mapped.
        break;
    }
    return out;
  }

  /**
   * Synthesize an AI SDK-compatible result shape from accumulator
   * state. The non-streaming path returns the real `GenerateTextResult`;
   * the streaming path synthesizes a duck-compatible one so
   * `normalizeRaw` narrows uniformly.
   */
  protected reconstructRaw(accum: StreamAccumulator, _modelSeen: string | undefined): unknown {
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
    return {
      text,
      finishReason: (state.finishReason ?? mapBackFinishReason(accum.stopReason)) as FinishReason,
      usage: {
        inputTokens: accum.usage.inputTokens,
        outputTokens: accum.usage.outputTokens,
        totalTokens: accum.usage.totalTokens,
      },
      toolCalls,
    };
  }

  protected normalizeRaw(raw: unknown): LanguageModelExecutionResult {
    return normalizeImpl({ targetOutput: raw, target: this.target });
  }
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
  const result: AISDKProjectedInput = {
    messages,
    generation,
    ...(target.providerOptions !== undefined
      ? { providerOptions: target.providerOptions as never }
      : {}),
  };
  return result;
}

/**
 * v2 spec carries per-part `providerMetadata` keyed by provider
 * namespace (`anthropic`, `openai`, `google`). AI SDK 5 accepts the
 * same per-part shape under the field name `providerOptions`. The
 * two are 1:1 — forward by renaming the carrier field.
 */
function pmToProviderOptions(part: {
  readonly providerMetadata?: Record<string, Record<string, unknown>>;
}): { providerOptions: Record<string, Record<string, unknown>> } | object {
  return part.providerMetadata !== undefined ? { providerOptions: part.providerMetadata } : {};
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
        },
      ];
    case "user":
      return [
        {
          role: "user",
          content: m.content.map((p) => {
            if (p.type === "text") {
              return { type: "text", text: p.text, ...pmToProviderOptions(p) };
            }
            if (p.type === "image") {
              return {
                type: "image",
                image: p.imageUrl,
                ...(p.mediaType !== undefined ? { mediaType: p.mediaType } : {}),
                ...pmToProviderOptions(p),
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
          parts.push({ type: "text", text: p.text, ...pmToProviderOptions(p) });
        } else if (p.type === "tool_use") {
          parts.push({
            type: "tool-call",
            toolCallId: p.id,
            toolName: p.name,
            input: p.input,
            ...pmToProviderOptions(p),
          });
        }
      }
      return [{ role: "assistant", content: parts } as ModelMessage];
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
            ...pmToProviderOptions(p),
          });
        }
      }
      return parts.length > 0 ? [{ role: "tool", content: parts } as ModelMessage] : [];
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
