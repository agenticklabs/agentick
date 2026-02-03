/**
 * Simple Adapter - Minimal API for creating model adapters
 *
 * This provides the simplest possible API for creating adapters.
 * Adapters only need to implement:
 * 1. prepareInput - convert engine input to provider format
 * 2. mapChunk - convert provider chunk to AdapterDelta
 * 3. execute/executeStream - call the provider
 *
 * The framework handles everything else (accumulation, events, etc.).
 *
 * @module tentickle/model/simple-adapter
 */

import type { COMInput } from "../com/types";
import type { EngineResponse } from "../engine/engine-response";
import type { EngineModel, ModelInput, ModelOutput, ModelMetadata } from "./model";
import { createLanguageModel } from "./model";
import {
  StreamAccumulator,
  type AdapterDelta,
  type ChunkMapping,
  createChunkMapper,
} from "./stream-accumulator";
import type { StreamEvent } from "@tentickle/shared/streaming";
import { fromEngineState, toEngineState } from "./utils/language-model";

// ============================================================================
// Simple Adapter Options
// ============================================================================

/**
 * Options for createSimpleAdapter.
 *
 * This is the minimal interface for creating an adapter. Compare to the
 * full createModel API which requires implementing transformers.processChunk,
 * transformers.processOutput, transformers.processStream, etc.
 *
 * @example
 * ```typescript
 * const model = createSimpleAdapter({
 *   metadata: { id: 'openai:gpt-4', provider: 'openai', capabilities: [{ stream: true, toolCalls: true }] },
 *
 *   prepareInput: (input) => ({
 *     model: 'gpt-4',
 *     messages: input.messages.map(toOpenAIMessage),
 *     tools: input.tools?.map(toOpenAITool),
 *   }),
 *
 *   mapChunk: (chunk) => {
 *     if (chunk.choices?.[0]?.delta?.content) {
 *       return { type: 'text', delta: chunk.choices[0].delta.content };
 *     }
 *     return null;
 *   },
 *
 *   execute: async (input) => openai.chat.completions.create(input),
 *   executeStream: (input) => openai.chat.completions.create({ ...input, stream: true }),
 * });
 * ```
 */
export interface SimpleAdapterOptions<TProviderInput, TProviderOutput, TChunk> {
  /** Model metadata */
  metadata: ModelMetadata;

  /**
   * Convert engine ModelInput to provider-specific input format.
   * This is the only complex transformation you need to implement.
   */
  prepareInput: (input: ModelInput) => TProviderInput | Promise<TProviderInput>;

  /**
   * Map a provider stream chunk to an AdapterDelta.
   * Return null to skip/ignore the chunk.
   *
   * This replaces the 200+ line switch statement in typical adapters.
   *
   * @example
   * ```typescript
   * mapChunk: (chunk) => {
   *   if (chunk.type === 'text-delta') return { type: 'text', delta: chunk.text };
   *   if (chunk.type === 'tool-call') return { type: 'tool_call', id: chunk.id, name: chunk.name, input: chunk.args };
   *   if (chunk.type === 'finish') return { type: 'message_end', stopReason: StopReason.STOP };
   *   return null;
   * }
   * ```
   */
  mapChunk: (chunk: TChunk) => AdapterDelta | null;

  /**
   * Execute non-streaming generation.
   */
  execute: (input: TProviderInput) => Promise<TProviderOutput>;

  /**
   * Execute streaming generation.
   * Returns an async iterable of provider chunks.
   */
  executeStream?: (input: TProviderInput) => AsyncIterable<TChunk>;

  /**
   * Convert non-streaming provider output to ModelOutput.
   * Optional - if not provided, streaming will be used and accumulated.
   */
  processOutput?: (output: TProviderOutput) => ModelOutput | Promise<ModelOutput>;

  /**
   * Custom fromEngineState (optional).
   * Converts COMInput to ModelInput before prepareInput.
   * Most adapters don't need this - the default handles standard transformations.
   */
  fromEngineState?: (input: COMInput) => ModelInput | Promise<ModelInput>;

  /**
   * Custom toEngineState (optional).
   * Converts ModelOutput to EngineResponse.
   * Most adapters don't need this - the default handles standard transformations.
   */
  toEngineState?: (output: ModelOutput) => EngineResponse | Promise<EngineResponse>;
}

/**
 * Declarative options using ChunkMapping instead of mapChunk function.
 */
export interface DeclarativeAdapterOptions<TProviderInput, TProviderOutput, TChunk> extends Omit<
  SimpleAdapterOptions<TProviderInput, TProviderOutput, TChunk>,
  "mapChunk"
> {
  /**
   * Declarative chunk mapping.
   * Alternative to mapChunk for simple cases.
   */
  chunkMapping: ChunkMapping<TChunk>;
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an adapter with the simplest possible API.
 *
 * This wraps createLanguageModel with sensible defaults:
 * - Uses StreamAccumulator for stream handling (no manual accumulation)
 * - Uses default fromEngineState/toEngineState (standard transformations)
 * - Automatically generates StreamEvents from AdapterDeltas
 *
 * @example
 * ```typescript
 * import { createSimpleAdapter, StopReason } from '@tentickle/core/model';
 * import { openai } from '@ai-sdk/openai';
 *
 * const model = createSimpleAdapter({
 *   metadata: {
 *     id: 'ai-sdk:gpt-4',
 *     provider: 'ai-sdk',
 *     capabilities: [{ stream: true, toolCalls: true }],
 *   },
 *
 *   prepareInput: (input) => ({
 *     model: openai('gpt-4'),
 *     messages: toAiSdkMessages(input.messages),
 *     tools: convertToolsToToolSet(input.tools),
 *   }),
 *
 *   mapChunk: (chunk) => {
 *     switch (chunk.type) {
 *       case 'text-delta': return { type: 'text', delta: chunk.text };
 *       case 'reasoning-delta': return { type: 'reasoning', delta: chunk.text };
 *       case 'tool-call': return { type: 'tool_call', id: chunk.toolCallId, name: chunk.toolName, input: chunk.args };
 *       case 'finish': return { type: 'message_end', stopReason: StopReason.STOP, usage: chunk.totalUsage };
 *       default: return null;
 *     }
 *   },
 *
 *   execute: (input) => generateText(input),
 *   executeStream: (input) => streamText(input).fullStream,
 * });
 * ```
 */
export function createSimpleAdapter<TProviderInput, TProviderOutput, TChunk>(
  options: SimpleAdapterOptions<TProviderInput, TProviderOutput, TChunk>,
): EngineModel<ModelInput, ModelOutput> {
  const { metadata, prepareInput, mapChunk, execute, executeStream, processOutput } = options;

  return createLanguageModel<ModelInput, ModelOutput, TProviderInput, TProviderOutput, TChunk>({
    metadata,

    transformers: {
      prepareInput,

      processOutput: processOutput
        ? processOutput
        : // If no processOutput, we'll use streaming and accumulate
          undefined,

      processChunk: (chunk: TChunk): StreamEvent => {
        // This won't be called directly when using StreamAccumulator
        // but createLanguageModel requires it for backward compatibility
        const delta = mapChunk(chunk);
        if (!delta) {
          // Return a no-op event for ignored chunks
          return {
            type: "content_delta",
            id: `ignored_${Date.now()}`,
            tick: 1,
            timestamp: new Date().toISOString(),
            blockType: "text",
            blockIndex: 0,
            delta: "",
          } as StreamEvent;
        }
        // For simple cases, create basic events
        // The real work is done in the custom stream handler below
        return createBasicEvent(delta);
      },

      // processStream aggregates events into ModelOutput (fallback path)
      processStream: (async (events: StreamEvent[]): Promise<ModelOutput> => {
        let text = "";
        const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
        let stopReason: any = "unspecified";
        const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

        for (const event of events) {
          if (event.type === "content_delta" && "delta" in event) {
            text += (event as any).delta;
          }
          if (event.type === "tool_call" && "callId" in event) {
            const tc = event as any;
            toolCalls.push({
              id: tc.callId,
              name: tc.name,
              input: (tc.input as Record<string, unknown>) || {},
            });
          }
          if (event.type === "message_end" && "usage" in event) {
            const endEvent = event as any;
            if (endEvent.usage) {
              usage.inputTokens = endEvent.usage.inputTokens || 0;
              usage.outputTokens = endEvent.usage.outputTokens || 0;
              usage.totalTokens = endEvent.usage.totalTokens || 0;
            }
            stopReason = endEvent.stopReason;
          }
        }

        return {
          model: metadata.id,
          createdAt: new Date().toISOString(),
          message: { role: "assistant", content: [{ type: "text", text }] },
          messages: [{ role: "assistant", content: [{ type: "text", text }] }],
          usage,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          stopReason,
          raw: events,
        };
      }) as any, // Cast needed due to TChunk generic
    },

    executors: {
      execute: async (input: TProviderInput) => {
        const result = await execute(input);
        return result;
      },

      // executeStream wraps provider stream with StreamAccumulator
      executeStream: executeStream
        ? (((input: TProviderInput) => {
            return createAccumulatedStream(executeStream(input), mapChunk, metadata.id);
          }) as any) // Cast needed: we return StreamEvent, not TChunk
        : undefined,
    },

    fromEngineState: options.fromEngineState
      ? async (input: COMInput) => options.fromEngineState!(input)
      : async (input: COMInput) => {
          // Use default transformation with model metadata for config
          const modelInstance = { metadata } as any;
          return fromEngineState(input, undefined, modelInstance) as Promise<ModelInput>;
        },

    toEngineState: options.toEngineState
      ? async (output: ModelOutput) => options.toEngineState!(output)
      : (output: ModelOutput) => toEngineState(output),
  });
}

/**
 * Create an adapter using declarative chunk mapping.
 *
 * This is even simpler than createSimpleAdapter for cases where
 * chunk mapping can be expressed declaratively.
 *
 * @example
 * ```typescript
 * const model = createDeclarativeAdapter({
 *   metadata: { id: 'my-model', ... },
 *   prepareInput: (input) => ({ ... }),
 *   execute: (input) => provider.call(input),
 *   executeStream: (input) => provider.stream(input),
 *   chunkMapping: {
 *     text: { type: 'text-delta', extract: (c) => c.text },
 *     toolCall: { type: 'tool-call', extract: (c) => ({ id: c.id, name: c.name, input: c.args }) },
 *     messageEnd: { type: 'finish', extract: (c) => ({ stopReason: StopReason.STOP }) },
 *   },
 * });
 * ```
 */
export function createDeclarativeAdapter<
  TProviderInput,
  TProviderOutput,
  TChunk extends { type: string },
>(
  options: DeclarativeAdapterOptions<TProviderInput, TProviderOutput, TChunk>,
): EngineModel<ModelInput, ModelOutput> {
  const { chunkMapping, ...rest } = options;
  const mapChunk = createChunkMapper(chunkMapping);

  return createSimpleAdapter({
    ...rest,
    mapChunk,
  });
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Create a basic StreamEvent from an AdapterDelta.
 * Used for backward compatibility with createLanguageModel.
 *
 * Note: This is only used when NOT using StreamAccumulator.
 * Most adapters use createAccumulatedStream which handles lifecycle properly.
 */
function createBasicEvent(delta: AdapterDelta): StreamEvent {
  const base = {
    id: `evt_${Date.now()}`,
    tick: 1,
    sequence: 0,
    timestamp: new Date().toISOString(),
  };

  switch (delta.type) {
    case "text":
      return {
        type: "content_delta",
        ...base,
        blockType: "text",
        blockIndex: 0,
        delta: delta.delta,
        // Note: metadata is tracked by StreamAccumulator, not emitted on deltas
      } as StreamEvent;
    case "reasoning":
      return {
        type: "reasoning_delta",
        ...base,
        blockIndex: 0,
        delta: delta.delta,
      } as StreamEvent;
    case "tool_call":
      return {
        type: "tool_call",
        ...base,
        callId: delta.id,
        name: delta.name,
        input: delta.input,
        blockIndex: 0,
        startedAt: base.timestamp,
        completedAt: base.timestamp,
      } as StreamEvent;
    case "message_start":
      return { type: "message_start", ...base, role: "assistant" } as StreamEvent;
    case "message_end":
      return {
        type: "message_end",
        ...base,
        stopReason: delta.stopReason,
        usage: delta.usage,
      } as StreamEvent;
    case "error":
      return {
        type: "error",
        ...base,
        error: {
          message: typeof delta.error === "string" ? delta.error : delta.error.message,
          code: delta.code,
        },
      } as StreamEvent;
    case "content_metadata":
    case "reasoning_metadata":
      // Metadata deltas don't emit events directly - handled by accumulator
      return {
        type: "content_delta",
        ...base,
        blockType: "text",
        blockIndex: 0,
        delta: "",
      } as StreamEvent;
    default:
      return {
        type: "content_delta",
        ...base,
        blockType: "text",
        blockIndex: 0,
        delta: "",
      } as StreamEvent;
  }
}

/**
 * Create an async iterable that uses StreamAccumulator to process chunks.
 */
async function* createAccumulatedStream<TChunk>(
  providerStream: AsyncIterable<TChunk>,
  mapChunk: (chunk: TChunk) => AdapterDelta | null,
  modelId?: string,
): AsyncIterable<StreamEvent> {
  const accumulator = new StreamAccumulator({ modelId });

  for await (const chunk of providerStream) {
    const delta = mapChunk(chunk);
    if (delta) {
      const events = accumulator.push(delta);
      for (const event of events) {
        yield event;
      }
    }
  }

  // If we never got a message_end, emit one now with accumulated content
  // This handles providers that don't send explicit end events
}
