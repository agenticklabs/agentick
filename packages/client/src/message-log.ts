import type { AgentickClient } from "./client.js";
import type {
  StreamEvent,
  ContentBlock,
  ExecutionEndEvent,
  ToolCallStartEvent,
  ToolCallDeltaEvent,
  ToolCallEndEvent,
  ToolCallEvent,
  ToolResultEvent,
  ContentEvent,
  ContentDeltaEvent,
  ReasoningEvent,
  ReasoningDeltaEvent,
  MessageEvent,
  TimelineEntry,
} from "@agentick/shared";
import type {
  ChatMessage,
  ToolCallEntry,
  MessageLogOptions,
  MessageLogState,
  MessageTransform,
  MessageTransformContext,
  RenderMode,
} from "./chat-types.js";
import { defaultTransform } from "./chat-transforms.js";

// ---------------------------------------------------------------------------
// Internal types for in-progress state
// ---------------------------------------------------------------------------

interface InProgressMessage {
  id: string;
  role: "assistant";
  content: ContentBlock[];
  toolCalls: ToolCallEntry[];
}

interface InProgressBlock {
  type: "text" | "reasoning";
  text: string;
}

interface InProgressToolCall {
  id: string;
  name: string;
  inputJson: string;
}

let messageIdCounter = 0;
function generateMessageId(): string {
  return `msg_${Date.now()}_${++messageIdCounter}`;
}

/**
 * Accumulates chat messages from execution lifecycle events.
 *
 * Tracks tool call durations (tool_call_start → tool_result) and extracts
 * messages from execution_end events via a configurable `MessageTransform`.
 *
 * When `renderMode` is set, processes stream events progressively:
 * - `"message"`: Full assistant messages appear on `message` event
 * - `"block"`: Content blocks appear one-at-a-time on `content`/`tool_call` events
 * - `"streaming"`: Token-by-token updates on `content_delta`/`tool_call_delta` events
 *
 * **Standalone:** Self-subscribes to session events by default.
 * **Composed:** Pass `subscribe: false` and call `processEvent()` from a
 * parent controller (e.g. ChatSession) for single-subscription fan-out.
 */
export class MessageLog {
  private _messages: ChatMessage[];
  private _messageCount: number;
  private _toolTimers = new Map<string, number>();
  private _toolDurations = new Map<string, number>();
  private readonly _transform: MessageTransform;
  private readonly _renderMode: RenderMode | undefined;

  // Progressive rendering state (block/streaming modes)
  private _inProgressMessage: InProgressMessage | null = null;
  private _inProgressBlock: InProgressBlock | null = null;
  private _inProgressToolCalls = new Map<string, InProgressToolCall>();
  // Count of user messages added via pushUserMessage (for dedup at execution_end)
  private _pushedUserMessageCount = 0;

  private _snapshot: MessageLogState;
  private _listeners = new Set<() => void>();
  private _unsubscribe: (() => void) | null = null;

  constructor(client: AgentickClient, options: MessageLogOptions = {}) {
    this._messages = options.initialMessages ? [...options.initialMessages] : [];
    this._messageCount = this._messages.length;
    this._transform = options.transform ?? defaultTransform;
    this._renderMode = options.renderMode;
    this._snapshot = this._createSnapshot();

    if (options.subscribe !== false && options.sessionId) {
      const accessor = client.session(options.sessionId);
      this._unsubscribe = accessor.onEvent((e) => this.processEvent(e));
    }
  }

  get state(): MessageLogState {
    return this._snapshot;
  }

  get messages(): readonly ChatMessage[] {
    return this._snapshot.messages;
  }

  /**
   * Add a user message immediately (before execution_end).
   * Used in progressive modes so user messages appear right away.
   * When extraBlocks are provided, content becomes ContentBlock[].
   */
  pushUserMessage(text: string, extraBlocks: ContentBlock[] = []): void {
    const id = generateMessageId();
    const content: string | ContentBlock[] =
      extraBlocks.length > 0 ? [...extraBlocks, { type: "text", text } as ContentBlock] : text;
    this._messages = [...this._messages, { id, role: "user", content }];
    this._messageCount++;
    this._pushedUserMessageCount++;
    this._notify();
  }

  /**
   * Process a stream event. Called automatically when self-subscribing,
   * or manually by a parent controller (ChatSession).
   */
  processEvent(event: StreamEvent): void {
    // Tool duration tracking (all modes)
    if (event.type === "tool_call_start") {
      const e = event as ToolCallStartEvent;
      this._toolTimers.set(e.callId, Date.now());
    }

    if (event.type === "tool_result") {
      const e = event as ToolResultEvent;
      const start = this._toolTimers.get(e.callId);
      if (start) {
        this._toolDurations.set(e.callId, Date.now() - start);
        this._toolTimers.delete(e.callId);
      }
    }

    // Progressive rendering
    if (this._renderMode) {
      this._processProgressive(event);
      return;
    }

    // Baseline: execution_end only
    if (event.type === "execution_end") {
      this._processExecutionEnd(event as ExecutionEndEvent);
      this._toolTimers.clear();
      this._toolDurations.clear();
      this._notify();
    }
  }

  clear(): void {
    this._messages = [];
    this._messageCount = 0;
    this._toolTimers.clear();
    this._toolDurations.clear();
    this._inProgressMessage = null;
    this._inProgressBlock = null;
    this._inProgressToolCalls.clear();
    this._pushedUserMessageCount = 0;
    this._notify();
  }

  onStateChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  destroy(): void {
    this._unsubscribe?.();
    this._unsubscribe = null;
    this._listeners.clear();
  }

  // ---------------------------------------------------------------------------
  // Progressive rendering
  // ---------------------------------------------------------------------------

  private _processProgressive(event: StreamEvent): void {
    const mode = this._renderMode!;

    switch (event.type) {
      // ---- streaming mode: content deltas ----
      case "content_start": {
        if (mode !== "streaming") break;
        this._ensureInProgressMessage();
        this._inProgressBlock = { type: "text", text: "" };
        this._notify();
        break;
      }

      case "content_delta": {
        if (mode !== "streaming") break;
        const e = event as ContentDeltaEvent;
        if (this._inProgressBlock) {
          this._inProgressBlock.text += e.delta;
        } else {
          // No content_start seen — create block on-the-fly
          this._ensureInProgressMessage();
          this._inProgressBlock = { type: "text", text: e.delta };
        }
        this._notify();
        break;
      }

      case "content_end": {
        if (mode !== "streaming") break;
        // Finalize in-progress block into the in-progress message
        if (this._inProgressBlock && this._inProgressMessage) {
          this._inProgressMessage.content.push({
            type: this._inProgressBlock.type,
            text: this._inProgressBlock.text,
          } as ContentBlock);
          this._inProgressBlock = null;
          this._notify();
        }
        break;
      }

      // ---- streaming mode: reasoning deltas ----
      case "reasoning_start": {
        if (mode !== "streaming") break;
        this._ensureInProgressMessage();
        this._inProgressBlock = { type: "reasoning", text: "" };
        this._notify();
        break;
      }

      case "reasoning_delta": {
        if (mode !== "streaming") break;
        const e = event as ReasoningDeltaEvent;
        if (this._inProgressBlock) {
          this._inProgressBlock.text += e.delta;
        } else {
          this._ensureInProgressMessage();
          this._inProgressBlock = { type: "reasoning", text: e.delta };
        }
        this._notify();
        break;
      }

      case "reasoning_end": {
        if (mode !== "streaming") break;
        if (this._inProgressBlock && this._inProgressMessage) {
          this._inProgressMessage.content.push({
            type: this._inProgressBlock.type,
            text: this._inProgressBlock.text,
          } as ContentBlock);
          this._inProgressBlock = null;
          this._notify();
        }
        break;
      }

      // ---- streaming mode: tool call deltas ----
      case "tool_call_start": {
        if (mode !== "streaming") break;
        const e = event as ToolCallStartEvent;
        this._ensureInProgressMessage();
        this._inProgressToolCalls.set(e.callId, {
          id: e.callId,
          name: e.name,
          inputJson: "",
        });
        this._notify();
        break;
      }

      case "tool_call_delta": {
        if (mode !== "streaming") break;
        const e = event as ToolCallDeltaEvent;
        const tc = this._inProgressToolCalls.get(e.callId);
        if (tc) {
          tc.inputJson += e.delta;
          this._notify();
        }
        break;
      }

      case "tool_call_end": {
        if (mode !== "streaming") break;
        const e = event as ToolCallEndEvent;
        const tc = this._inProgressToolCalls.get(e.callId);
        if (tc && this._inProgressMessage) {
          // Add tool_use content block
          this._inProgressMessage.content.push({
            type: "tool_use",
            toolUseId: tc.id,
            name: tc.name,
            input: this._parseToolInput(tc.inputJson),
          } as ContentBlock);
          // Add tool call entry
          this._inProgressMessage.toolCalls.push({
            id: tc.id,
            name: tc.name,
            status: "done" as const,
            duration: this._toolDurations.get(tc.id),
          });
          this._inProgressToolCalls.delete(e.callId);
          this._notify();
        }
        break;
      }

      // ---- block mode: full content blocks ----
      case "content": {
        // In streaming mode, content_end already finalized the block — skip.
        if (mode !== "block") break;
        const e = event as ContentEvent;
        this._ensureInProgressMessage();
        this._inProgressMessage!.content.push(e.content);
        this._notify();
        break;
      }

      // ---- block mode: full reasoning blocks ----
      case "reasoning": {
        if (mode !== "block") break;
        const e = event as ReasoningEvent;
        this._ensureInProgressMessage();
        this._inProgressMessage!.content.push({
          type: "reasoning",
          text: e.reasoning,
        } as ContentBlock);
        this._notify();
        break;
      }

      // ---- block + streaming: full tool calls ----
      case "tool_call": {
        if (mode === "message") break;
        const e = event as ToolCallEvent;
        this._ensureInProgressMessage();
        // In streaming mode, tool_call_end already finalized. Skip if already added.
        if (mode === "streaming") {
          // Check if already added via tool_call_end
          const alreadyAdded = this._inProgressMessage!.toolCalls.some((tc) => tc.id === e.callId);
          if (alreadyAdded) break;
        }
        this._inProgressMessage!.content.push({
          type: "tool_use",
          toolUseId: e.callId,
          name: e.name,
          input: e.input,
        } as ContentBlock);
        this._inProgressMessage!.toolCalls.push({
          id: e.callId,
          name: e.name,
          status: "done" as const,
          duration: this._toolDurations.get(e.callId),
        });
        this._notify();
        break;
      }

      // ---- block + streaming: tool result durations ----
      case "tool_result": {
        if (mode === "message") break;
        const e = event as ToolResultEvent;
        const duration = this._toolDurations.get(e.callId);
        if (duration === undefined) break;

        // tool_result arrives after message_end, so the tool call is likely
        // in a finalized message, not the in-progress one. Search both.
        const found = this._updateToolDuration(e.callId, duration);
        if (found) this._notify();
        break;
      }

      // ---- block mode: message_start creates in-progress ----
      case "message_start": {
        if (mode === "message") break;
        this._ensureInProgressMessage();
        break;
      }

      // ---- block + streaming: message_end finalizes ----
      case "message_end": {
        if (mode === "message") break;
        this._finalizeInProgressMessage();
        break;
      }

      // ---- message mode: full message ----
      case "message": {
        // All modes can receive this as a fallback (non-streaming responses)
        const e = event as MessageEvent;
        // If we already have an in-progress message (from block/streaming events),
        // finalize it instead of duplicating
        if (this._inProgressMessage) {
          this._finalizeInProgressMessage();
          break;
        }
        const msg: ChatMessage = {
          id: generateMessageId(),
          role: "assistant",
          content: e.message.content,
        };
        this._messages = [...this._messages, msg];
        this._messageCount++;
        this._notify();
        break;
      }

      // ---- execution_end: extract user messages, skip already-rendered assistant messages ----
      case "execution_end": {
        this._processProgressiveExecutionEnd(event as ExecutionEndEvent);
        this._toolTimers.clear();
        this._toolDurations.clear();
        this._notify();
        break;
      }
    }
  }

  /**
   * Update a tool call's duration in either the in-progress message or
   * a recently-finalized message. Returns true if the tool call was found.
   *
   * Tool results arrive after message_end (which finalizes the in-progress
   * message into _messages), so we search finalized messages in reverse.
   */
  private _updateToolDuration(callId: string, duration: number): boolean {
    // Check in-progress message first
    if (this._inProgressMessage) {
      const tc = this._inProgressMessage.toolCalls.find((t) => t.id === callId);
      if (tc) {
        tc.duration = duration;
        return true;
      }
    }

    // Search finalized messages in reverse (most recent first)
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const msg = this._messages[i];
      if (msg.role !== "assistant" || !msg.toolCalls) continue;
      const tc = msg.toolCalls.find((t) => t.id === callId);
      if (tc) {
        tc.duration = duration;
        return true;
      }
    }

    return false;
  }

  /**
   * Ensure an in-progress assistant message exists.
   */
  private _ensureInProgressMessage(): void {
    if (!this._inProgressMessage) {
      this._inProgressMessage = {
        id: generateMessageId(),
        role: "assistant",
        content: [],
        toolCalls: [],
      };
    }
  }

  /**
   * Finalize in-progress message: push to _messages and clear state.
   */
  private _finalizeInProgressMessage(): void {
    // Finalize any in-progress block first (streaming mode)
    if (this._inProgressBlock && this._inProgressMessage) {
      this._inProgressMessage.content.push({
        type: this._inProgressBlock.type,
        text: this._inProgressBlock.text,
      } as ContentBlock);
      this._inProgressBlock = null;
    }

    // Finalize any in-progress tool calls (streaming mode)
    for (const [, tc] of this._inProgressToolCalls) {
      if (this._inProgressMessage) {
        this._inProgressMessage.content.push({
          type: "tool_use",
          toolUseId: tc.id,
          name: tc.name,
          input: this._parseToolInput(tc.inputJson),
        } as ContentBlock);
        this._inProgressMessage.toolCalls.push({
          id: tc.id,
          name: tc.name,
          status: "done" as const,
        });
      }
    }
    this._inProgressToolCalls.clear();

    if (this._inProgressMessage) {
      const msg: ChatMessage = {
        id: this._inProgressMessage.id,
        role: "assistant",
        content: this._inProgressMessage.content,
        toolCalls:
          this._inProgressMessage.toolCalls.length > 0
            ? this._inProgressMessage.toolCalls
            : undefined,
      };
      this._messages = [...this._messages, msg];
      this._messageCount++;
      this._inProgressMessage = null;
      this._notify();
    }
  }

  /**
   * At execution_end in progressive mode: extract user messages from timeline
   * that weren't already added via pushUserMessage. Skip assistant messages
   * (already handled by stream events).
   */
  private _processProgressiveExecutionEnd(event: ExecutionEndEvent): void {
    const context: MessageTransformContext = {
      toolDurations: this._toolDurations,
    };

    // Finalize any leftover in-progress state
    if (this._inProgressMessage) {
      this._finalizeInProgressMessage();
    }

    // Extract user messages from timeline
    const delta = event.newTimelineEntries as TimelineEntry[] | undefined;
    if (delta && delta.length > 0) {
      const allMsgs = this._transform(delta, context);
      const userMsgs = allMsgs.filter((m) => m.role === "user");
      // Skip the ones already added via pushUserMessage (FIFO order)
      const newUserMsgs = userMsgs.slice(this._pushedUserMessageCount);
      if (newUserMsgs.length > 0) {
        this._messages = [...this._messages, ...newUserMsgs];
        this._messageCount += newUserMsgs.length;
      }
    } else {
      // Fallback: full timeline — only add user messages beyond messageCount
      const output = event.output as { timeline?: TimelineEntry[] } | undefined;
      const timeline = output?.timeline;
      if (Array.isArray(timeline)) {
        const all = this._transform(timeline, context);
        const newMsgs = all.slice(this._messageCount);
        // Only user messages — assistant messages already rendered progressively
        const userMsgs = newMsgs.filter((m) => m.role === "user");
        if (userMsgs.length > 0) {
          this._messages = [...this._messages, ...userMsgs];
          this._messageCount += userMsgs.length;
        }
      }
    }

    // Reset for next execution
    this._pushedUserMessageCount = 0;
  }

  // ---------------------------------------------------------------------------
  // Baseline (no renderMode)
  // ---------------------------------------------------------------------------

  private _processExecutionEnd(event: ExecutionEndEvent): void {
    const context: MessageTransformContext = {
      toolDurations: this._toolDurations,
    };

    // Prefer delta (new entries only)
    const delta = event.newTimelineEntries as TimelineEntry[] | undefined;
    if (delta && delta.length > 0) {
      const newMsgs = this._transform(delta, context);
      if (newMsgs.length > 0) {
        this._messages = [...this._messages, ...newMsgs];
        this._messageCount += newMsgs.length;
      }
      return;
    }

    // Fallback: full timeline with messageCount dedup
    const output = event.output as { timeline?: TimelineEntry[] } | undefined;
    const timeline = output?.timeline;
    if (Array.isArray(timeline)) {
      const all = this._transform(timeline, context);
      const newMsgs = all.slice(this._messageCount);
      if (newMsgs.length > 0) {
        this._messages = [...this._messages, ...newMsgs];
        this._messageCount += newMsgs.length;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Snapshot & notification
  // ---------------------------------------------------------------------------

  private _createSnapshot(): MessageLogState {
    const messages = [...this._messages];

    // Include in-progress message in snapshot (progressive modes)
    if (this._inProgressMessage) {
      const content = [...this._inProgressMessage.content];

      // In streaming mode, include the in-progress block
      if (this._inProgressBlock) {
        content.push({
          type: this._inProgressBlock.type,
          text: this._inProgressBlock.text,
        } as ContentBlock);
      }

      messages.push({
        id: this._inProgressMessage.id,
        role: "assistant",
        content,
        toolCalls:
          this._inProgressMessage.toolCalls.length > 0
            ? this._inProgressMessage.toolCalls
            : undefined,
      });
    }

    return { messages };
  }

  private _notify(): void {
    this._snapshot = this._createSnapshot();
    for (const listener of this._listeners) {
      try {
        listener();
      } catch (e) {
        console.error("Error in message log listener:", e);
      }
    }
  }

  private _parseToolInput(json: string): Record<string, unknown> {
    if (!json) return {};
    try {
      return JSON.parse(json) as Record<string, unknown>;
    } catch {
      return { raw: json };
    }
  }
}
