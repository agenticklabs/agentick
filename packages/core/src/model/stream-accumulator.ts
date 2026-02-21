/**
 * StreamAccumulator - Framework-provided stream accumulation
 *
 * This handles the common pattern of accumulating stream deltas into
 * a final ModelOutput. Adapters only need to map provider chunks to
 * AdapterDelta - the accumulator handles the rest.
 *
 * @module agentick/model/stream-accumulator
 */

import type { ContentBlock, UsageStats, Message } from "@agentick/shared";
import { StopReason, BlockType } from "@agentick/shared";
import type {
  StreamEvent,
  StreamEventBase,
  ContentMetadata,
  MessageStartEvent,
  MessageEndEvent,
  ContentStartEvent,
  ContentDeltaEvent,
  ContentEndEvent,
  ContentEvent,
  ReasoningStartEvent,
  ReasoningDeltaEvent,
  ReasoningEndEvent,
  ReasoningEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallEvent,
  StreamErrorEvent,
} from "@agentick/shared/streaming";
import type { ModelOutput } from "./model.js";

// ============================================================================
// AdapterDelta - Simple union type for normalized stream deltas
// ============================================================================

/**
 * AdapterDelta is the minimal interface adapters need to implement.
 * Each provider chunk maps to one of these simple delta types.
 *
 * The framework's StreamAccumulator handles:
 * - Accumulating text/reasoning into full strings
 * - Building tool call objects from start/delta/end events
 * - Emitting proper StreamEvents
 * - Producing final ModelOutput
 *
 * @example
 * ```typescript
 * // AI SDK chunk → AdapterDelta
 * function mapChunk(chunk: AiSdkChunk): AdapterDelta | null {
 *   switch (chunk.type) {
 *     case 'text-delta':
 *       return { type: 'text', delta: chunk.text };
 *     case 'tool-input-start':
 *       return { type: 'tool_call_start', id: chunk.id, name: chunk.toolName };
 *     case 'tool-input-delta':
 *       return { type: 'tool_call_delta', id: chunk.id, delta: chunk.delta };
 *     case 'finish':
 *       return { type: 'message_end', stopReason: mapStopReason(chunk.finishReason) };
 *     default:
 *       return null; // Ignore unknown chunks
 *   }
 * }
 * ```
 */
/**
 * AdapterDelta is a simplified interface for adapter authors.
 *
 * Adapters map provider chunks to these simple delta types.
 * The StreamAccumulator handles converting them into the full
 * StreamEvent lifecycle (start/delta/end/complete patterns).
 *
 * For example, when an adapter emits { type: "text", delta: "Hello" },
 * the accumulator automatically:
 * - Emits content_start on first text
 * - Emits content_delta for each text
 * - Emits content_end when the block ends
 *
 * This keeps adapter code simple - no lifecycle tracking needed.
 */
export type AdapterDelta =
  // Text content (with optional metadata for citations, annotations, etc.)
  | { type: "text"; delta: string; metadata?: ContentMetadata }
  // Reasoning/thinking content (Claude, o1) - can also have citations
  | { type: "reasoning"; delta: string; metadata?: ContentMetadata }
  // Tool calls (streamed in parts)
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; delta: string }
  | { type: "tool_call_end"; id: string; input: unknown }
  // Complete tool call (non-streamed, some providers send complete)
  | { type: "tool_call"; id: string; name: string; input: unknown }
  // Message lifecycle
  | { type: "message_start"; model?: string }
  | { type: "message_end"; stopReason: StopReason; usage?: UsageStats }
  // Usage update (can come mid-stream)
  | { type: "usage"; usage: Partial<UsageStats> }
  // Error
  | { type: "error"; error: Error | string; code?: string }
  // Raw pass-through (for provider-specific data)
  | { type: "raw"; data: unknown }
  // Content metadata update (add metadata to current content block without text)
  | { type: "content_metadata"; metadata: ContentMetadata }
  // Reasoning metadata update (add metadata to current reasoning block without text)
  | { type: "reasoning_metadata"; metadata: ContentMetadata };

// ============================================================================
// StreamAccumulator - Framework-provided accumulation
// ============================================================================

let eventIdCounter = 0;

function generateEventId(): string {
  return `evt_${Date.now()}_${++eventIdCounter}`;
}

function createEventBase(tick = 1): StreamEventBase {
  return {
    id: generateEventId(),
    sequence: 0, // Placeholder - session.emitEvent assigns actual sequence
    tick,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Tool call being accumulated from streamed parts.
 */
interface AccumulatingToolCall {
  id: string;
  name: string;
  inputJson: string;
  blockIndex: number;
}

/**
 * Options for StreamAccumulator.
 */
export interface StreamAccumulatorOptions {
  /** Model ID for events */
  modelId?: string;
  /** Current tick number */
  tick?: number;
}

/**
 * StreamAccumulator handles the common pattern of accumulating stream
 * deltas into a final ModelOutput.
 *
 * Usage:
 * 1. Create accumulator at stream start
 * 2. For each provider chunk, call accumulator.push(mapChunk(chunk))
 * 3. accumulator.push() yields StreamEvent(s) to emit
 * 4. After stream ends, call accumulator.toModelOutput()
 *
 * @example
 * ```typescript
 * const accumulator = new StreamAccumulator({ modelId: 'gpt-4' });
 *
 * for await (const chunk of providerStream) {
 *   const delta = mapChunk(chunk);
 *   if (delta) {
 *     for (const event of accumulator.push(delta)) {
 *       yield event;
 *     }
 *   }
 * }
 *
 * return accumulator.toModelOutput();
 * ```
 */
export class StreamAccumulator {
  private readonly options: StreamAccumulatorOptions;

  // Accumulated state
  private text = "";
  private reasoning = "";
  private toolCalls = new Map<string, AccumulatingToolCall>();
  private completedToolCalls: Array<{ id: string; name: string; input: unknown }> = [];
  private usage: UsageStats = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  private stopReason: StopReason = StopReason.UNSPECIFIED;
  private modelId?: string;

  // Metadata tracking (accumulated across deltas, emitted on end events)
  private contentMetadata?: ContentMetadata;
  private reasoningMetadata?: ContentMetadata;

  // Lifecycle tracking
  private messageStarted = false;
  private messageStartedAt?: string;
  private textStarted = false;
  private reasoningStarted = false;
  private blockIndex = 0;

  // Per-block text tracking (for emitting full block events)
  private currentBlockText = "";
  private currentBlockStartedAt?: string;
  private currentReasoningText = "";
  private currentReasoningStartedAt?: string;

  constructor(options: StreamAccumulatorOptions = {}) {
    this.options = options;
    this.modelId = options.modelId;
  }

  /**
   * Process an AdapterDelta and return StreamEvent(s) to emit.
   *
   * Most deltas produce a single event, but some (like message_end)
   * may produce multiple events.
   */
  push(delta: AdapterDelta): StreamEvent[] {
    const tick = this.options.tick ?? 1;
    const events: StreamEvent[] = [];

    switch (delta.type) {
      case "message_start": {
        if (!this.messageStarted) {
          this.messageStarted = true;
          this.messageStartedAt = new Date().toISOString();
          if (delta.model) this.modelId = delta.model;
          events.push({
            type: "message_start",
            ...createEventBase(tick),
            role: "assistant",
            model: this.modelId,
          } as MessageStartEvent);
        }
        break;
      }

      case "text": {
        // Auto-start message if not started
        if (!this.messageStarted) {
          events.push(...this.push({ type: "message_start" }));
        }

        // Emit content_start on first text
        if (!this.textStarted) {
          this.textStarted = true;
          this.currentBlockText = "";
          this.currentBlockStartedAt = new Date().toISOString();
          events.push({
            type: "content_start",
            ...createEventBase(tick),
            blockType: BlockType.TEXT,
            blockIndex: this.blockIndex,
            metadata: delta.metadata,
          } as ContentStartEvent);
        }

        // Accumulate metadata from deltas (merge citations/annotations)
        if (delta.metadata) {
          this.contentMetadata = this.mergeMetadata(this.contentMetadata, delta.metadata);
        }

        this.text += delta.delta;
        this.currentBlockText += delta.delta;
        events.push({
          type: "content_delta",
          ...createEventBase(tick),
          blockType: BlockType.TEXT,
          blockIndex: this.blockIndex,
          delta: delta.delta,
        } as ContentDeltaEvent);
        break;
      }

      case "reasoning": {
        // Auto-start message if not started
        if (!this.messageStarted) {
          events.push(...this.push({ type: "message_start" }));
        }

        // Emit reasoning_start on first reasoning
        if (!this.reasoningStarted) {
          this.reasoningStarted = true;
          this.currentReasoningText = "";
          this.currentReasoningStartedAt = new Date().toISOString();
          events.push({
            type: "reasoning_start",
            ...createEventBase(tick),
            blockIndex: this.blockIndex,
            metadata: delta.metadata,
          } as ReasoningStartEvent);
        }

        // Accumulate metadata from deltas (merge citations/annotations)
        if (delta.metadata) {
          this.reasoningMetadata = this.mergeMetadata(this.reasoningMetadata, delta.metadata);
        }

        this.reasoning += delta.delta;
        this.currentReasoningText += delta.delta;
        events.push({
          type: "reasoning_delta",
          ...createEventBase(tick),
          blockIndex: this.blockIndex,
          delta: delta.delta,
        } as ReasoningDeltaEvent);
        break;
      }

      case "content_metadata": {
        // Add metadata to current content block without emitting text
        this.contentMetadata = this.mergeMetadata(this.contentMetadata, delta.metadata);
        break;
      }

      case "reasoning_metadata": {
        // Add metadata to current reasoning block without emitting text
        this.reasoningMetadata = this.mergeMetadata(this.reasoningMetadata, delta.metadata);
        break;
      }

      case "tool_call_start": {
        // Auto-start message if not started
        if (!this.messageStarted) {
          events.push(...this.push({ type: "message_start" }));
        }

        // End text block if active
        if (this.textStarted) {
          const completedAt = new Date().toISOString();
          events.push({
            type: "content_end",
            ...createEventBase(tick),
            blockType: BlockType.TEXT,
            blockIndex: this.blockIndex,
            metadata: this.contentMetadata,
          } as ContentEndEvent);
          events.push({
            type: "content",
            ...createEventBase(tick),
            blockIndex: this.blockIndex,
            content: { type: "text", text: this.currentBlockText },
            metadata: this.contentMetadata,
            startedAt: this.currentBlockStartedAt || completedAt,
            completedAt,
          } as ContentEvent);
          this.textStarted = false;
          this.currentBlockText = "";
          this.currentBlockStartedAt = undefined;
          this.contentMetadata = undefined; // Reset for next block
          this.blockIndex++;
        }

        // End reasoning block if active
        if (this.reasoningStarted) {
          const completedAt = new Date().toISOString();
          events.push({
            type: "reasoning_end",
            ...createEventBase(tick),
            blockIndex: this.blockIndex,
            metadata: this.reasoningMetadata,
          } as ReasoningEndEvent);
          events.push({
            type: "reasoning",
            ...createEventBase(tick),
            blockIndex: this.blockIndex,
            reasoning: this.currentReasoningText,
            metadata: this.reasoningMetadata,
            startedAt: this.currentReasoningStartedAt || completedAt,
            completedAt,
          } as ReasoningEvent);
          this.reasoningStarted = false;
          this.currentReasoningText = "";
          this.currentReasoningStartedAt = undefined;
          this.reasoningMetadata = undefined; // Reset for next block
          this.blockIndex++;
        }

        this.toolCalls.set(delta.id, {
          id: delta.id,
          name: delta.name,
          inputJson: "",
          blockIndex: this.blockIndex,
        });

        events.push({
          type: "tool_call_start",
          ...createEventBase(tick),
          callId: delta.id,
          name: delta.name,
          blockIndex: this.blockIndex,
        } as ToolCallStartEvent);
        break;
      }

      case "tool_call_delta": {
        const tc = this.toolCalls.get(delta.id);
        if (tc) {
          tc.inputJson += delta.delta;
          events.push({
            type: "tool_call_delta",
            ...createEventBase(tick),
            callId: delta.id,
            blockIndex: tc.blockIndex,
            delta: delta.delta,
          } as ToolCallDeltaEvent);
        }
        break;
      }

      case "tool_call_end": {
        const tc = this.toolCalls.get(delta.id);
        if (tc) {
          // Parse accumulated JSON or use provided input
          const input = delta.input ?? this.parseToolInput(tc.inputJson);
          this.completedToolCalls.push({ id: tc.id, name: tc.name, input });
          this.toolCalls.delete(delta.id);
          this.blockIndex++;

          events.push({
            type: "tool_call_end",
            ...createEventBase(tick),
            callId: delta.id,
            blockIndex: tc.blockIndex,
          } as ToolCallEndEvent);

          // Also emit complete tool_call event
          events.push({
            type: "tool_call",
            ...createEventBase(tick),
            callId: delta.id,
            name: tc.name,
            input,
            blockIndex: tc.blockIndex,
            startedAt: this.messageStartedAt || new Date().toISOString(),
            completedAt: new Date().toISOString(),
          } as ToolCallEvent);
        }
        break;
      }

      case "tool_call": {
        // Complete tool call in one event (non-streamed)
        // Auto-start message if not started
        if (!this.messageStarted) {
          events.push(...this.push({ type: "message_start" }));
        }

        this.completedToolCalls.push({
          id: delta.id,
          name: delta.name,
          input: delta.input,
        });

        events.push({
          type: "tool_call",
          ...createEventBase(tick),
          callId: delta.id,
          name: delta.name,
          input: delta.input,
          blockIndex: this.blockIndex++,
          startedAt: this.messageStartedAt || new Date().toISOString(),
          completedAt: new Date().toISOString(),
        } as ToolCallEvent);
        break;
      }

      case "usage": {
        // Merge usage stats
        if (delta.usage.inputTokens !== undefined) {
          this.usage.inputTokens = Math.max(this.usage.inputTokens, delta.usage.inputTokens);
        }
        if (delta.usage.outputTokens !== undefined) {
          this.usage.outputTokens = Math.max(this.usage.outputTokens, delta.usage.outputTokens);
        }
        if (delta.usage.totalTokens !== undefined) {
          this.usage.totalTokens = Math.max(this.usage.totalTokens, delta.usage.totalTokens);
        }
        // Usage updates don't emit events, just accumulate
        break;
      }

      case "message_end": {
        // End any active blocks
        if (this.textStarted) {
          const completedAt = new Date().toISOString();
          events.push({
            type: "content_end",
            ...createEventBase(tick),
            blockType: BlockType.TEXT,
            blockIndex: this.blockIndex,
            metadata: this.contentMetadata,
          } as ContentEndEvent);
          events.push({
            type: "content",
            ...createEventBase(tick),
            blockIndex: this.blockIndex,
            content: { type: "text", text: this.currentBlockText },
            metadata: this.contentMetadata,
            startedAt: this.currentBlockStartedAt || completedAt,
            completedAt,
          } as ContentEvent);
          this.textStarted = false;
          this.currentBlockText = "";
          this.currentBlockStartedAt = undefined;
        }
        if (this.reasoningStarted) {
          const completedAt = new Date().toISOString();
          events.push({
            type: "reasoning_end",
            ...createEventBase(tick),
            blockIndex: this.blockIndex,
            metadata: this.reasoningMetadata,
          } as ReasoningEndEvent);
          events.push({
            type: "reasoning",
            ...createEventBase(tick),
            blockIndex: this.blockIndex,
            reasoning: this.currentReasoningText,
            metadata: this.reasoningMetadata,
            startedAt: this.currentReasoningStartedAt || completedAt,
            completedAt,
          } as ReasoningEvent);
          this.reasoningStarted = false;
          this.currentReasoningText = "";
          this.currentReasoningStartedAt = undefined;
        }

        // Finalize any in-progress tool calls
        // Some providers (like OpenAI) don't send explicit tool_call_end events,
        // they just send message_end with finish_reason: "tool_calls"
        for (const [, tc] of this.toolCalls) {
          const input = this.parseToolInput(tc.inputJson);
          this.completedToolCalls.push({ id: tc.id, name: tc.name, input });

          events.push({
            type: "tool_call_end",
            ...createEventBase(tick),
            callId: tc.id,
            blockIndex: tc.blockIndex,
          } as ToolCallEndEvent);

          events.push({
            type: "tool_call",
            ...createEventBase(tick),
            callId: tc.id,
            name: tc.name,
            input,
            blockIndex: tc.blockIndex,
            startedAt: this.messageStartedAt || new Date().toISOString(),
            completedAt: new Date().toISOString(),
          } as ToolCallEvent);
        }
        this.toolCalls.clear();

        this.stopReason = delta.stopReason;
        if (delta.usage) {
          this.push({ type: "usage", usage: delta.usage });
        }

        events.push({
          type: "message_end",
          ...createEventBase(tick),
          stopReason: this.stopReason,
          usage: this.usage,
        } as MessageEndEvent);
        break;
      }

      case "error": {
        const errorMessage = typeof delta.error === "string" ? delta.error : delta.error.message;
        events.push({
          type: "error",
          ...createEventBase(tick),
          error: {
            message: errorMessage,
            code: delta.code || "stream_error",
          },
        } as StreamErrorEvent);
        break;
      }

      case "raw": {
        // Pass through raw data as content_delta with raw field
        events.push({
          type: "content_delta",
          ...createEventBase(tick),
          blockType: BlockType.TEXT,
          blockIndex: this.blockIndex,
          delta: "",
          raw: delta.data,
        } as ContentDeltaEvent);
        break;
      }
    }

    return events;
  }

  /**
   * Get the accumulated content as a final ModelOutput.
   * Call this after the stream has ended.
   */
  toModelOutput(): ModelOutput {
    const content: ContentBlock[] = [];

    // Add reasoning block first if present
    if (this.reasoning) {
      content.push({ type: "reasoning", text: this.reasoning } as ContentBlock);
    }

    // Add text content
    if (this.text) {
      content.push({ type: "text", text: this.text });
    }

    // Add tool use blocks
    for (const tc of this.completedToolCalls) {
      content.push({
        type: "tool_use",
        toolUseId: tc.id,
        name: tc.name,
        input: tc.input as Record<string, unknown>,
      } as ContentBlock);
    }

    const message: Message = {
      role: "assistant",
      content,
    };

    return {
      model: this.modelId || this.options.modelId || "unknown",
      createdAt: this.messageStartedAt || new Date().toISOString(),
      message,
      messages: [message],
      usage: this.usage,
      toolCalls:
        this.completedToolCalls.length > 0
          ? this.completedToolCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              input: tc.input as Record<string, unknown>,
            }))
          : undefined,
      stopReason: this.stopReason,
      raw: {
        text: this.text,
        reasoning: this.reasoning,
        toolCalls: this.completedToolCalls,
      },
    };
  }

  /**
   * Get accumulated text (for mid-stream access).
   */
  getText(): string {
    return this.text;
  }

  /**
   * Get accumulated reasoning (for mid-stream access).
   */
  getReasoning(): string {
    return this.reasoning;
  }

  /**
   * Parse accumulated JSON string to object.
   */
  private parseToolInput(json: string): unknown {
    if (!json) return {};
    try {
      return JSON.parse(json);
    } catch {
      // Return raw string if not valid JSON
      return { raw: json };
    }
  }

  /**
   * Merge metadata objects, concatenating arrays and merging objects.
   */
  private mergeMetadata(
    existing: ContentMetadata | undefined,
    incoming: ContentMetadata,
  ): ContentMetadata {
    if (!existing) {
      return { ...incoming };
    }

    return {
      // Concatenate citations
      citations:
        existing.citations || incoming.citations
          ? [...(existing.citations || []), ...(incoming.citations || [])]
          : undefined,
      // Concatenate annotations
      annotations:
        existing.annotations || incoming.annotations
          ? [...(existing.annotations || []), ...(incoming.annotations || [])]
          : undefined,
      // Take latest language (incoming wins)
      language: incoming.language ?? existing.language,
      // Take latest mimeType (incoming wins)
      mimeType: incoming.mimeType ?? existing.mimeType,
      // Merge extensions
      extensions:
        existing.extensions || incoming.extensions
          ? { ...existing.extensions, ...incoming.extensions }
          : undefined,
    };
  }
}

// ============================================================================
// Declarative Chunk Mapping (Syntactic Sugar)
// ============================================================================

/**
 * ChunkMapping defines how to extract AdapterDelta from a provider chunk.
 * This is syntactic sugar for simple cases where the mapping is declarative.
 *
 * @example
 * ```typescript
 * const aiSdkMapping: ChunkMapping<AiSdkChunk> = {
 *   text: { type: 'text-delta', extract: (c) => c.text },
 *   reasoning: { type: 'reasoning-delta', extract: (c) => c.text },
 *   toolCallStart: { type: 'tool-input-start', extract: (c) => ({ id: c.id, name: c.toolName }) },
 *   toolCallDelta: { type: 'tool-input-delta', extract: (c) => ({ id: c.id, delta: c.delta }) },
 *   toolCallEnd: { type: 'tool-input-end', extract: (c) => ({ id: c.id }) },
 *   messageStart: { type: 'start', extract: () => ({}) },
 *   messageEnd: { type: 'finish', extract: (c) => ({ stopReason: mapStopReason(c.finishReason), usage: c.totalUsage }) },
 * };
 * ```
 */
export interface ChunkMapping<TChunk> {
  text?: { type: string; extract: (chunk: TChunk) => string };
  reasoning?: { type: string; extract: (chunk: TChunk) => string };
  toolCallStart?: { type: string; extract: (chunk: TChunk) => { id: string; name: string } };
  toolCallDelta?: { type: string; extract: (chunk: TChunk) => { id: string; delta: string } };
  toolCallEnd?: { type: string; extract: (chunk: TChunk) => { id: string; input?: unknown } };
  toolCall?: {
    type: string;
    extract: (chunk: TChunk) => { id: string; name: string; input: unknown };
  };
  messageStart?: { type: string; extract: (chunk: TChunk) => { model?: string } };
  messageEnd?: {
    type: string;
    extract: (chunk: TChunk) => { stopReason: StopReason; usage?: UsageStats };
  };
  usage?: { type: string; extract: (chunk: TChunk) => Partial<UsageStats> };
  error?: { type: string; extract: (chunk: TChunk) => { error: Error | string; code?: string } };
}

/**
 * Create a mapChunk function from a declarative ChunkMapping.
 *
 * @example
 * ```typescript
 * const mapChunk = createChunkMapper(aiSdkMapping);
 *
 * for await (const chunk of stream) {
 *   const delta = mapChunk(chunk);
 *   if (delta) yield* accumulator.push(delta);
 * }
 * ```
 */
export function createChunkMapper<TChunk extends { type: string }>(
  mapping: ChunkMapping<TChunk>,
): (chunk: TChunk) => AdapterDelta | null {
  return (chunk: TChunk): AdapterDelta | null => {
    if (mapping.text && chunk.type === mapping.text.type) {
      return { type: "text", delta: mapping.text.extract(chunk) };
    }
    if (mapping.reasoning && chunk.type === mapping.reasoning.type) {
      return { type: "reasoning", delta: mapping.reasoning.extract(chunk) };
    }
    if (mapping.toolCallStart && chunk.type === mapping.toolCallStart.type) {
      const { id, name } = mapping.toolCallStart.extract(chunk);
      return { type: "tool_call_start", id, name };
    }
    if (mapping.toolCallDelta && chunk.type === mapping.toolCallDelta.type) {
      const { id, delta } = mapping.toolCallDelta.extract(chunk);
      return { type: "tool_call_delta", id, delta };
    }
    if (mapping.toolCallEnd && chunk.type === mapping.toolCallEnd.type) {
      const { id, input } = mapping.toolCallEnd.extract(chunk);
      return { type: "tool_call_end", id, input };
    }
    if (mapping.toolCall && chunk.type === mapping.toolCall.type) {
      const { id, name, input } = mapping.toolCall.extract(chunk);
      return { type: "tool_call", id, name, input };
    }
    if (mapping.messageStart && chunk.type === mapping.messageStart.type) {
      const { model } = mapping.messageStart.extract(chunk);
      return { type: "message_start", model };
    }
    if (mapping.messageEnd && chunk.type === mapping.messageEnd.type) {
      const { stopReason, usage } = mapping.messageEnd.extract(chunk);
      return { type: "message_end", stopReason, usage };
    }
    if (mapping.usage && chunk.type === mapping.usage.type) {
      return { type: "usage", usage: mapping.usage.extract(chunk) };
    }
    if (mapping.error && chunk.type === mapping.error.type) {
      const { error, code } = mapping.error.extract(chunk);
      return { type: "error", error, code };
    }
    return null;
  };
}
