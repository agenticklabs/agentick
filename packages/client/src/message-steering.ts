import type { AgentickClient } from "./client.js";
import type { SendInput, ClientExecutionHandle, Message, StreamEvent } from "./types.js";

export type SteeringMode = "queue" | "steer";
export type FlushMode = "sequential" | "batched";

export interface MessageSteeringOptions {
  sessionId?: string;
  mode?: SteeringMode;
  flushMode?: FlushMode;
  autoFlush?: boolean;
  /** When false, caller must call processEvent() manually. Default: true. */
  subscribe?: boolean;
}

export interface MessageSteeringState {
  readonly queued: readonly Message[];
  readonly isExecuting: boolean;
  readonly mode: SteeringMode;
}

function textToMessage(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function textToSendInput(text: string): SendInput {
  return { messages: [textToMessage(text)] };
}

export class MessageSteering {
  private _queued: Message[] = [];
  private _isExecuting = false;
  private _mode: SteeringMode;
  private readonly _flushMode: FlushMode;
  private readonly _autoFlush: boolean;
  private readonly _sessionId: string | undefined;
  private readonly _client: AgentickClient;

  private _snapshot: MessageSteeringState;
  private _listeners = new Set<() => void>();
  private _unsubscribeEvents: (() => void) | null = null;

  constructor(client: AgentickClient, options: MessageSteeringOptions = {}) {
    this._client = client;
    this._sessionId = options.sessionId;
    this._mode = options.mode ?? "steer";
    this._flushMode = options.flushMode ?? "sequential";
    this._autoFlush = options.autoFlush ?? true;
    this._snapshot = this._createSnapshot();

    if (options.subscribe !== false && this._sessionId) {
      const accessor = client.session(this._sessionId);
      this._unsubscribeEvents = accessor.onEvent((e) => this.processEvent(e));
    }
  }

  /**
   * Process a stream event for execution tracking.
   * Called automatically when self-subscribing (default),
   * or manually by a parent controller (e.g. ChatSession).
   */
  processEvent(event: StreamEvent): void {
    if (event.type === "execution_start") {
      this._isExecuting = true;
      this._notify();
    }
    if (event.type === "execution_end") {
      this._isExecuting = false;
      if (this._autoFlush) this._flushNext();
      this._notify();
    }
  }

  get state(): MessageSteeringState {
    return this._snapshot;
  }

  get queued(): readonly Message[] {
    return this._snapshot.queued;
  }

  get isExecuting(): boolean {
    return this._snapshot.isExecuting;
  }

  get mode(): SteeringMode {
    return this._snapshot.mode;
  }

  submit(text: string): void {
    if (this._isExecuting && this._mode === "queue") {
      this._addToQueue(text);
    } else {
      this._sendToSession(text);
    }
  }

  steer(text: string): void {
    this._sendToSession(text);
  }

  queue(text: string): void {
    this._addToQueue(text);
  }

  async interrupt(text: string): Promise<ClientExecutionHandle> {
    if (!this._sessionId) {
      return this._client.send(textToSendInput(text));
    }
    const accessor = this._client.session(this._sessionId);
    return accessor.interrupt(textToSendInput(text));
  }

  flush(): void {
    if (this._queued.length === 0) return;
    this._flushNext();
    this._notify();
  }

  removeQueued(index: number): void {
    if (index < 0 || index >= this._queued.length) return;
    this._queued = this._queued.filter((_, i) => i !== index);
    this._notify();
  }

  clearQueued(): void {
    this._queued = [];
    this._notify();
  }

  setMode(mode: SteeringMode): void {
    this._mode = mode;
    this._notify();
  }

  onStateChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  destroy(): void {
    this._unsubscribeEvents?.();
    this._unsubscribeEvents = null;
    this._listeners.clear();
  }

  private _notify(): void {
    this._snapshot = this._createSnapshot();
    for (const listener of this._listeners) {
      try {
        listener();
      } catch {
        // Listeners should not throw
      }
    }
  }

  private _createSnapshot(): MessageSteeringState {
    return {
      queued: [...this._queued],
      isExecuting: this._isExecuting,
      mode: this._mode,
    };
  }

  private _send(input: SendInput): void {
    const handle = this._sessionId
      ? this._client.send(input, { sessionId: this._sessionId })
      : this._client.send(input);
    // Prevent unhandled rejection — errors propagate via execution_end events
    void handle.result.catch(() => {});
  }

  private _sendToSession(text: string): void {
    this._send(textToSendInput(text));
  }

  private _sendMessages(messages: Message[]): void {
    this._send({ messages });
  }

  private _addToQueue(text: string): void {
    this._queued = [...this._queued, textToMessage(text)];
    this._notify();
  }

  private _flushNext(): void {
    if (this._queued.length === 0) return;

    if (this._flushMode === "batched") {
      this._sendMessages(this._queued);
      this._queued = [];
    } else {
      const [first, ...rest] = this._queued;
      this._sendMessages([first]);
      this._queued = rest;
    }
  }
}
