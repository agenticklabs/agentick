import type { AgentickClient, SessionAccessor } from "./client.js";
import type { ToolConfirmationResponse } from "./types.js";
import type { StreamEvent, ExecutionEndEvent, ContentBlock } from "@agentick/shared";
import { MessageSteering, type SteeringMode } from "./message-steering.js";
import { MessageLog } from "./message-log.js";
import { ToolConfirmations } from "./tool-confirmations.js";
import { AttachmentManager } from "./attachment-manager.js";
import type {
  ChatMode,
  ChatSessionState,
  ChatSessionOptions,
  ChatModeDeriver,
} from "./chat-types.js";
import { defaultDeriveMode } from "./chat-transforms.js";

/**
 * Complete chat controller — composes MessageLog, ToolConfirmations,
 * MessageSteering, and AttachmentManager into a single state snapshot.
 *
 * Owns a single event subscription and fans out to all three event-driven
 * primitives deterministically. chatMode is derived (not tracked) via
 * `ChatModeDeriver`. AttachmentManager is pure client-side state (no events).
 *
 * Generic over `TMode` for custom chat modes — defaults to
 * `"idle" | "streaming" | "confirming_tool"`.
 */
export class ChatSession<TMode extends string = ChatMode> {
  private readonly _messageLog: MessageLog;
  private readonly _confirmations: ToolConfirmations;
  private readonly _steering: MessageSteering;
  private readonly _attachments: AttachmentManager;
  private readonly _deriveMode: ChatModeDeriver<TMode>;
  private readonly _onEvent?: (event: StreamEvent) => void;
  private readonly _accessor: SessionAccessor | null = null;
  private readonly _autoSubscribed: boolean;
  private readonly _hasRenderMode: boolean;

  private _lastSubmitted: string | null = null;
  private _error: { message: string; name: string } | null = null;
  private _suppressAttachmentNotify = false;

  private _unsubscribeEvents: (() => void) | null = null;
  private _unsubscribeConfirmations: (() => void) | null = null;
  private _unsubAttachments: (() => void) | null = null;

  private _snapshot: ChatSessionState<TMode>;
  private _listeners = new Set<() => void>();

  constructor(
    client: AgentickClient,
    options: ChatSessionOptions<TMode> = {} as ChatSessionOptions<TMode>,
  ) {
    // Cast is safe: when TMode is custom, callers must provide deriveMode —
    // without it, chatMode values won't match TMode at runtime.
    this._deriveMode = options.deriveMode ?? (defaultDeriveMode as ChatModeDeriver<TMode>);
    this._onEvent = options.onEvent;
    this._hasRenderMode = !!options.renderMode;

    // Create primitives in externally-driven mode (subscribe: false).
    // ChatSession owns the single event subscription.
    this._messageLog = new MessageLog(client, {
      sessionId: options.sessionId,
      initialMessages: options.initialMessages,
      transform: options.transform,
      renderMode: options.renderMode,
      subscribe: false,
    });

    this._confirmations = new ToolConfirmations(client, {
      sessionId: options.sessionId,
      policy: options.confirmationPolicy,
      subscribe: false,
    });

    this._steering = new MessageSteering(client, {
      ...options,
      subscribe: false,
    });

    this._attachments = new AttachmentManager(options.attachments);
    this._unsubAttachments = this._attachments.onStateChange(() => {
      if (!this._suppressAttachmentNotify) this._notify();
    });

    this._snapshot = this._createSnapshot();

    // Single event subscription — fans out to all primitives
    this._autoSubscribed = options.autoSubscribe !== false;
    if (options.sessionId) {
      const accessor = client.session(options.sessionId);
      this._accessor = accessor;

      if (this._autoSubscribed) {
        accessor.subscribe();
      }

      this._unsubscribeEvents = accessor.onEvent((event) => {
        this._onEvent?.(event);
        this._steering.processEvent(event);
        this._messageLog.processEvent(event);

        if (event.type === "execution_start") {
          this._error = null;
        }

        if (event.type === "execution_end") {
          this._lastSubmitted = null;
          const endEvent = event as unknown as ExecutionEndEvent;
          if (endEvent.error) {
            this._error = endEvent.error;
          }
        }

        this._notify();
      });

      this._unsubscribeConfirmations = accessor.onToolConfirmation((request, respond) => {
        this._confirmations.handleConfirmation(request, respond);
        this._notify();
      });
    }
  }

  // --- Public API (state) ---

  get state(): ChatSessionState<TMode> {
    return this._snapshot;
  }

  get messages() {
    return this._snapshot.messages;
  }

  get chatMode(): TMode {
    return this._snapshot.chatMode;
  }

  get toolConfirmation() {
    return this._snapshot.toolConfirmation;
  }

  get lastSubmitted() {
    return this._snapshot.lastSubmitted;
  }

  get queued() {
    return this._snapshot.queued;
  }

  get isExecuting() {
    return this._snapshot.isExecuting;
  }

  get mode() {
    return this._snapshot.mode;
  }

  get error() {
    return this._snapshot.error;
  }

  get attachments(): AttachmentManager {
    return this._attachments;
  }

  // --- Public API (actions) ---

  submit(text: string): void {
    this._lastSubmitted = text;
    const extraBlocks = this._drainAttachments();
    if (this._hasRenderMode) {
      this._messageLog.pushUserMessage(text, extraBlocks);
    }
    this._steering.submit(text, extraBlocks);
    this._notify();
  }

  steer(text: string): void {
    const extraBlocks = this._drainAttachments();
    this._steering.steer(text, extraBlocks);
    this._notify();
  }

  queue(text: string): void {
    this._steering.queue(text);
    this._notify();
  }

  interrupt(text: string) {
    const extraBlocks = this._drainAttachments();
    const handle = this._steering.interrupt(text, extraBlocks);
    this._notify();
    return handle;
  }

  flush(): void {
    this._steering.flush();
    this._notify();
  }

  removeQueued(index: number): void {
    this._steering.removeQueued(index);
    this._notify();
  }

  clearQueued(): void {
    this._steering.clearQueued();
    this._notify();
  }

  setMode(mode: SteeringMode): void {
    this._steering.setMode(mode);
    this._notify();
  }

  respondToConfirmation(response: ToolConfirmationResponse): void {
    if (!this._confirmations.pending) return;
    this._confirmations.respond(response);
    this._notify();
  }

  clearMessages(): void {
    this._messageLog.clear();
    this._lastSubmitted = null;
    this._steering.clearQueued();
    this._notify();
  }

  abort(reason?: string): void {
    this._accessor?.abort(reason);
  }

  // --- Subscription ---

  onStateChange(listener: () => void): () => void {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  destroy(): void {
    this._unsubscribeEvents?.();
    this._unsubscribeConfirmations?.();
    this._unsubAttachments?.();
    if (this._autoSubscribed && this._accessor) {
      this._accessor.unsubscribe();
    }
    this._messageLog.destroy();
    this._confirmations.destroy();
    this._steering.destroy();
    this._attachments.destroy();
    this._listeners.clear();
  }

  // --- Private ---

  /** Consume attachments without triggering an intermediate _notify(). */
  private _drainAttachments(): ContentBlock[] {
    this._suppressAttachmentNotify = true;
    const blocks = this._attachments.consume();
    this._suppressAttachmentNotify = false;
    return blocks;
  }

  private _createSnapshot(): ChatSessionState<TMode> {
    const steeringState = this._steering.state;
    const logState = this._messageLog.state;
    const confirmState = this._confirmations.state;

    return {
      messages: logState.messages,
      chatMode: this._deriveMode({
        isExecuting: steeringState.isExecuting,
        hasPendingConfirmation: confirmState.pending !== null,
      }),
      toolConfirmation: confirmState.pending,
      lastSubmitted: this._lastSubmitted,
      queued: steeringState.queued,
      isExecuting: steeringState.isExecuting,
      mode: steeringState.mode,
      error: this._error,
      attachments: this._attachments.attachments,
    };
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
}
