import type { AgentickClient } from "./client.js";
import type {
  StreamEvent,
  ExecutionEndEvent,
  ToolCallStartEvent,
  ToolResultEvent,
  TimelineEntry,
} from "@agentick/shared";
import type {
  ChatMessage,
  MessageLogOptions,
  MessageLogState,
  MessageTransform,
  MessageTransformContext,
} from "./chat-types.js";
import { defaultTransform } from "./chat-transforms.js";

/**
 * Accumulates chat messages from execution lifecycle events.
 *
 * Tracks tool call durations (tool_call_start → tool_result) and extracts
 * messages from execution_end events via a configurable `MessageTransform`.
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

  private _snapshot: MessageLogState;
  private _listeners = new Set<() => void>();
  private _unsubscribe: (() => void) | null = null;

  constructor(client: AgentickClient, options: MessageLogOptions = {}) {
    this._messages = options.initialMessages ? [...options.initialMessages] : [];
    this._messageCount = this._messages.length;
    this._transform = options.transform ?? defaultTransform;
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
   * Process a stream event. Called automatically when self-subscribing,
   * or manually by a parent controller (ChatSession).
   */
  processEvent(event: StreamEvent): void {
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

  private _createSnapshot(): MessageLogState {
    return {
      messages: [...this._messages],
    };
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
}
