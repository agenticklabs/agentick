/**
 * TentickleClient - Multiplexed session client
 *
 * Connects to a Tentickle server with a single SSE connection
 * that multiplexes events for multiple sessions.
 *
 * @module @tentickle/client
 */

import type {
  ConnectionState,
  ChannelAccessor,
  GlobalEventHandler,
  SessionEventHandler,
  SessionResultHandler,
  SessionToolConfirmationHandler,
  ClientEventName,
  ClientEventHandlerMap,
  StreamEventType,
  GlobalStreamEventHandler,
  StreamingTextState,
  StreamingTextHandler,
  ChannelEvent,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  StreamEvent,
  SessionStreamEvent,
  SendInput,
  ClientExecutionHandle,
} from "./types";
import type { ContentBlock, Message } from "@tentickle/shared";

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Configuration for TentickleClient.
 */
export interface TentickleClientConfig {
  /** Base URL for the server (e.g., https://api.example.com or ws://localhost:18789) */
  baseUrl: string;

  /**
   * Transport to use for communication.
   * - "sse": HTTP/SSE transport (default for http:// and https:// URLs)
   * - "websocket": WebSocket transport (default for ws:// and wss:// URLs)
   * - "auto": Auto-detect based on URL scheme (default)
   * @default "auto"
   */
  transport?: "sse" | "websocket" | "auto";

  /** Override default endpoint paths (SSE transport only) */
  paths?: {
    /** SSE stream endpoint (default: /events) */
    events?: string;
    /** Send endpoint (default: /send) */
    send?: string;
    /** Invoke endpoint for custom methods (default: /invoke) */
    invoke?: string;
    /** Subscribe endpoint (default: /subscribe) */
    subscribe?: string;
    /** Abort endpoint (default: /abort) */
    abort?: string;
    /** Close endpoint (default: /close) */
    close?: string;
    /** Tool response endpoint (default: /tool-response) */
    toolResponse?: string;
    /** Channel endpoint (default: /channel) */
    channel?: string;
  };

  /** Authentication token (adds Authorization: Bearer header) */
  token?: string;

  /** Custom headers for all requests */
  headers?: Record<string, string>;

  /** Request timeout in ms (default: 30000) */
  timeout?: number;

  /** Custom fetch implementation (SSE transport only) */
  fetch?: typeof fetch;

  /** Custom EventSource constructor (SSE transport only, for Node.js polyfills) */
  EventSource?: typeof EventSource;

  /** Custom WebSocket constructor (WebSocket transport only, for Node.js) */
  WebSocket?: typeof WebSocket;

  /** Send cookies with requests and SSE */
  withCredentials?: boolean;

  /** Client ID for WebSocket connections */
  clientId?: string;
}

// ============================================================================
// Session Accessor
// ============================================================================

/**
 * Session accessor for interacting with a specific session.
 *
 * Cold accessor (from `client.session(id)`) - no server subscription
 * Hot accessor (from `client.subscribe(id)`) - actively receiving events
 */
export interface SessionAccessor {
  /** Session ID */
  readonly sessionId: string;

  /** Whether this accessor is subscribed (hot) */
  readonly isSubscribed: boolean;

  /**
   * Subscribe to session events.
   * Makes this a "hot" accessor.
   */
  subscribe(): void;

  /**
   * Unsubscribe from session events.
   * Makes this a "cold" accessor.
   */
  unsubscribe(): void;

  /**
   * Send a message to this session.
   */
  send(input: SendInput): ClientExecutionHandle;

  /**
   * Abort the current execution.
   */
  abort(reason?: string): Promise<void>;

  /**
   * Close the session.
   */
  close(): Promise<void>;

  /**
   * Submit a tool confirmation response.
   */
  submitToolResult(toolUseId: string, result: ToolConfirmationResponse): void;

  /**
   * Subscribe to events for this session only.
   */
  onEvent(handler: SessionEventHandler): () => void;

  /**
   * Subscribe to results for this session only.
   */
  onResult(handler: SessionResultHandler): () => void;

  /**
   * Subscribe to tool confirmation requests for this session.
   */
  onToolConfirmation(handler: SessionToolConfirmationHandler): () => void;

  /**
   * Get a channel accessor scoped to this session.
   * Allows pub/sub communication with the server for this session.
   */
  channel(name: string): ChannelAccessor;

  /**
   * Invoke a custom method with auto-injected sessionId.
   */
  invoke<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;

  /**
   * Invoke a streaming method with auto-injected sessionId.
   */
  stream<T = unknown>(method: string, params?: Record<string, unknown>): AsyncGenerator<T>;
}

// ============================================================================
// Channel Accessor Implementation
// ============================================================================

class ChannelAccessorImpl implements ChannelAccessor {
  readonly name: string;
  private handlers = new Set<(payload: unknown, event: ChannelEvent) => void>();
  private pendingRequests = new Map<
    string,
    {
      resolve: (payload: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(
    name: string,
    private readonly sendFn: (event: ChannelEvent) => Promise<void>,
  ) {
    this.name = name;
  }

  subscribe<T = unknown>(handler: (payload: T, event: ChannelEvent<T>) => void): () => void {
    this.handlers.add(handler as (payload: unknown, event: ChannelEvent) => void);
    return () => {
      this.handlers.delete(handler as (payload: unknown, event: ChannelEvent) => void);
    };
  }

  async publish<T = unknown>(type: string, payload: T): Promise<void> {
    await this.sendFn({
      channel: this.name,
      type,
      payload,
      metadata: { timestamp: Date.now() },
    });
  }

  async request<TReq = unknown, TRes = unknown>(
    type: string,
    payload: TReq,
    timeoutMs = 30000,
  ): Promise<TRes> {
    const requestId = generateId();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: resolve as (payload: unknown) => void,
        reject,
        timeout,
      });

      this.sendFn({
        channel: this.name,
        type,
        payload,
        id: requestId,
        metadata: { timestamp: Date.now() },
      }).catch((error) => {
        this.pendingRequests.delete(requestId);
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  /** @internal */
  _handleEvent(event: ChannelEvent): void {
    // Check for response to pending request
    if (event.type === "response" && event.id) {
      const pending = this.pendingRequests.get(event.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(event.id);
        pending.resolve(event.payload);
        return;
      }
    }

    // Check for error response
    if (event.type === "error" && event.id) {
      const pending = this.pendingRequests.get(event.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(event.id);
        pending.reject(
          new Error((event.payload as { message?: string })?.message ?? "Request failed"),
        );
        return;
      }
    }

    // Notify subscribers
    for (const handler of this.handlers) {
      try {
        handler(event.payload, event);
      } catch (error) {
        console.error(`Error in channel handler for ${this.name}:`, error);
      }
    }
  }

  /** @internal */
  _destroy(): void {
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Channel destroyed"));
    }
    this.pendingRequests.clear();
    this.handlers.clear();
  }
}

// ============================================================================
// Async Event Queue (single-consumer)
// ============================================================================

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(value: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      if (resolver) {
        resolver({ value: undefined as unknown as T, done: true });
      }
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffer.length > 0) {
          const value = this.buffer.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

// ============================================================================
// Client Execution Handle
// ============================================================================

class ClientExecutionHandleImpl implements ClientExecutionHandle {
  private readonly queue = new AsyncEventQueue<StreamEvent>();
  private readonly resultPromise: Promise<SessionResultPayload>;
  private resolveResult!: (result: SessionResultPayload) => void;
  private rejectResult!: (error: Error) => void;
  private _status: "running" | "completed" | "aborted" | "error" = "running";
  private _sessionId: string;
  private _executionId: string = "pending";
  private hasResult = false;

  constructor(
    private readonly client: TentickleClient,
    private readonly abortController: AbortController,
    sessionId?: string,
  ) {
    this._sessionId = sessionId ?? "pending";
    this.resultPromise = new Promise<SessionResultPayload>((resolve, reject) => {
      this.resolveResult = resolve;
      this.rejectResult = reject;
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  get executionId(): string {
    return this._executionId;
  }

  get status(): "running" | "completed" | "aborted" | "error" {
    return this._status;
  }

  get result(): Promise<SessionResultPayload> {
    return this.resultPromise;
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this.queue[Symbol.asyncIterator]();
  }

  abort(reason?: string): void {
    if (this._status !== "running") return;
    this._status = "aborted";
    this.abortController.abort(reason ?? "Client aborted execution");
    if (this._sessionId !== "pending") {
      void this.client.abort(this._sessionId, reason).catch(() => {});
    }
    this.queue.close();
    this.rejectResult(new Error(reason ?? "Execution aborted"));
  }

  queueMessage(message: Message): void {
    if (this._sessionId === "pending") {
      throw new Error("Cannot queue message before sessionId is known");
    }
    const handle = this.client.send({ message }, { sessionId: this._sessionId });
    void handle.result.catch(() => {});
  }

  submitToolResult(toolUseId: string, result: ToolConfirmationResponse): void {
    if (this._sessionId === "pending") {
      throw new Error("Cannot submit tool result before sessionId is known");
    }
    void this.client.submitToolResult(this._sessionId, toolUseId, result).catch(() => {});
  }

  /** @internal */
  _handleEvent(event: SessionStreamEvent): void {
    if (event.sessionId) {
      this._sessionId = event.sessionId;
    }
    if ("executionId" in event && event.executionId) {
      this._executionId = event.executionId;
    }

    const streamEvent = event as unknown as StreamEvent;
    this.queue.push(streamEvent);

    if (event.type === "result") {
      this.hasResult = true;
      this._status = "completed";
      this.resolveResult(event.result);
    }

    if (event.type === "execution_end") {
      if (this._status === "running") {
        this._status = "completed";
      }
      this.queue.close();
    }
  }

  /** @internal */
  _fail(error: Error): void {
    if (this._status === "running") {
      this._status = "error";
    }
    this.queue.close();
    if (!this.hasResult) {
      this.rejectResult(error);
    }
  }

  /** @internal */
  _complete(): void {
    if (this._status === "running") {
      this._status = "completed";
    }
    this.queue.close();
    if (!this.hasResult) {
      this.rejectResult(new Error("Execution completed without result"));
    }
  }
}

// ============================================================================
// Session Accessor Implementation
// ============================================================================

class SessionAccessorImpl implements SessionAccessor {
  readonly sessionId: string;
  private _isSubscribed = false;
  private eventHandlers = new Set<SessionEventHandler>();
  private resultHandlers = new Set<SessionResultHandler>();
  private toolConfirmationHandlers = new Set<SessionToolConfirmationHandler>();
  private channels = new Map<string, ChannelAccessorImpl>();

  constructor(
    sessionId: string,
    private readonly client: TentickleClient,
  ) {
    this.sessionId = sessionId;
  }

  get isSubscribed(): boolean {
    return this._isSubscribed;
  }

  subscribe(): void {
    if (this._isSubscribed) return;
    this._isSubscribed = true;
    this.client._subscribeToSession(this.sessionId).catch((error) => {
      this._isSubscribed = false;
      console.error(`Failed to subscribe to session ${this.sessionId}:`, error);
    });
  }

  unsubscribe(): void {
    if (!this._isSubscribed) return;
    this._isSubscribed = false;
    this.client._unsubscribeFromSession(this.sessionId).catch((error) => {
      console.error(`Failed to unsubscribe from session ${this.sessionId}:`, error);
    });
  }

  send(input: SendInput): ClientExecutionHandle {
    return this.client.send(input, { sessionId: this.sessionId });
  }

  async abort(reason?: string): Promise<void> {
    await this.client.abort(this.sessionId, reason);
  }

  async close(): Promise<void> {
    await this.client.closeSession(this.sessionId);
  }

  submitToolResult(toolUseId: string, result: ToolConfirmationResponse): void {
    void this.client.submitToolResult(this.sessionId, toolUseId, result).catch(() => {});
  }

  onEvent(handler: SessionEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onResult(handler: SessionResultHandler): () => void {
    this.resultHandlers.add(handler);
    return () => {
      this.resultHandlers.delete(handler);
    };
  }

  onToolConfirmation(handler: SessionToolConfirmationHandler): () => void {
    this.toolConfirmationHandlers.add(handler);
    return () => {
      this.toolConfirmationHandlers.delete(handler);
    };
  }

  /** @internal - Called by client when event is received for this session */
  _handleEvent(event: StreamEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("Error in session event handler:", error);
      }
    }
  }

  /** @internal - Called by client when result is received for this session */
  _handleResult(result: SessionResultPayload): void {
    for (const handler of this.resultHandlers) {
      try {
        handler(result);
      } catch (error) {
        console.error("Error in session result handler:", error);
      }
    }
  }

  /** @internal - Called by client when channel event is received for this session */
  _handleChannelEvent(channelName: string, event: ChannelEvent): void {
    const channelAccessor = this.channels.get(channelName);
    if (channelAccessor) {
      channelAccessor._handleEvent(event);
    }
  }

  /** @internal - Called by client when tool confirmation is requested */
  _handleToolConfirmation(request: ToolConfirmationRequest): void {
    const respond = (response: ToolConfirmationResponse) => {
      this.submitToolResult(request.toolUseId, response);
    };
    for (const handler of this.toolConfirmationHandlers) {
      try {
        handler(request, respond);
      } catch (error) {
        console.error("Error in tool confirmation handler:", error);
      }
    }
  }

  channel(name: string): ChannelAccessor {
    let channelAccessor = this.channels.get(name);
    if (!channelAccessor) {
      channelAccessor = new ChannelAccessorImpl(name, async (event) => {
        await this.client._publishToChannel(this.sessionId, name, event);
      });
      this.channels.set(name, channelAccessor);
      // Subscribe to this channel on the server
      this.client._subscribeToChannel(this.sessionId, name).catch((err) => {
        console.error(`Failed to subscribe to channel ${name}:`, err);
      });
    }
    return channelAccessor;
  }

  /**
   * Invoke a custom method with auto-injected sessionId.
   *
   * @example
   * ```typescript
   * const session = client.session("main");
   * const tasks = await session.invoke("tasks:list");
   * const newTask = await session.invoke("tasks:create", { title: "Buy groceries" });
   * ```
   */
  async invoke<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.client.invoke<T>(method, {
      ...params,
      sessionId: this.sessionId,
    });
  }

  /**
   * Invoke a streaming method with auto-injected sessionId.
   *
   * @example
   * ```typescript
   * const session = client.session("main");
   * for await (const change of session.stream("tasks:watch")) {
   *   console.log("Task changed:", change);
   * }
   * ```
   */
  async *stream<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): AsyncGenerator<T> {
    yield* this.client.stream<T>(method, {
      ...params,
      sessionId: this.sessionId,
    });
  }

  /** @internal */
  _destroy(): void {
    this.eventHandlers.clear();
    this.resultHandlers.clear();
    this.toolConfirmationHandlers.clear();
    for (const channel of this.channels.values()) {
      channel._destroy();
    }
    this.channels.clear();
  }
}

// ============================================================================
// Utilities
// ============================================================================

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================================
// TentickleClient
// ============================================================================

/**
 * TentickleClient - Multiplexed session client.
 *
 * Connects to a Tentickle server with a single SSE connection that
 * can manage multiple session subscriptions.
 *
 * @example
 * ```typescript
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 * });
 *
 * // Get session accessor (cold - no subscription)
 * const session = client.session('conv-123');
 *
 * // Subscribe to receive events (hot)
 * session.subscribe();
 *
 * // Listen for events
 * session.onEvent((event) => {
 *   console.log(event);
 * });
 *
 * // Send a message
 * const handle = session.send({ message: { role: 'user', content: [...] } });
 * await handle.result;
 *
 * // Or use ephemeral send (creates session, executes, closes)
 * const ephemeral = client.send({ message: {...} });
 * await ephemeral.result;
 * ```
 */
export class TentickleClient {
  private readonly config: TentickleClientConfig;
  private readonly fetchFn: typeof fetch;
  private readonly EventSourceCtor: typeof EventSource;
  private readonly requestHeaders: Record<string, string>;

  private _state: ConnectionState = "disconnected";
  private _connectionId?: string;
  private eventSource?: EventSource;
  private connectionPromise?: Promise<void>;

  private stateHandlers = new Set<(state: ConnectionState) => void>();
  private eventHandlers = new Set<GlobalEventHandler>();
  private streamingTextHandlers = new Set<StreamingTextHandler>();
  private _streamingText: StreamingTextState = { text: "", isStreaming: false };

  private sessions = new Map<string, SessionAccessorImpl>();
  private subscriptions = new Set<string>();
  private seenEventIds = new Set<string>();
  private seenEventIdsOrder: string[] = [];
  private readonly maxSeenEventIds = 5000;

  constructor(config: TentickleClientConfig) {
    this.config = config;

    // Build request headers
    this.requestHeaders = { "Content-Type": "application/json", ...config.headers };
    if (config.token && !this.requestHeaders["Authorization"]) {
      this.requestHeaders["Authorization"] = `Bearer ${config.token}`;
    }

    // Use custom implementations or fall back to globals
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.EventSourceCtor = config.EventSource ?? globalThis.EventSource;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Connection State
  // ══════════════════════════════════════════════════════════════════════════

  /** Current connection state */
  get state(): ConnectionState {
    return this._state;
  }

  private setState(state: ConnectionState): void {
    if (this._state === state) return;
    this._state = state;
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch (error) {
        console.error("Error in state handler:", error);
      }
    }
  }

  /**
   * Subscribe to connection state changes.
   */
  onConnectionChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Connection Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Ensure the SSE connection is established.
   * This is called lazily when subscribing to sessions.
   */
  private async ensureConnection(): Promise<void> {
    if (this._state === "connected") {
      return;
    }
    if (this.connectionPromise) {
      await this.connectionPromise;
      return;
    }

    this.setState("connecting");
    this.connectionPromise = this.openEventSource();

    try {
      await this.connectionPromise;
      this.setState("connected");
    } catch (error) {
      this.setState("error");
      throw error;
    } finally {
      this.connectionPromise = undefined;
    }
  }

  private async openEventSource(): Promise<void> {
    this.closeEventSource();

    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const eventsPath = this.config.paths?.events ?? "/events";
    const url = `${baseUrl}${eventsPath}`;

    return new Promise((resolve, reject) => {
      try {
        this.eventSource = new this.EventSourceCtor(url, {
          withCredentials: this.config.withCredentials,
        });

        const onMessage = (event: MessageEvent) => {
          try {
            const data = JSON.parse(event.data);
            this.handleIncomingEvent(data);

            if (data.type === "connection" && data.connectionId) {
              this._connectionId = data.connectionId;
              if (data.subscriptions) {
                for (const sessionId of data.subscriptions) {
                  this.subscriptions.add(sessionId);
                }
              }
              resolve();
            }
          } catch (error) {
            console.error("Failed to parse SSE event:", error);
          }
        };

        const onError = () => {
          if (this._state === "connecting") {
            this.closeEventSource();
            reject(new Error("SSE connection failed"));
          } else {
            this.setState("error");
          }
        };

        this.eventSource.addEventListener("message", onMessage);
        this.eventSource.addEventListener("error", onError);
      } catch (error) {
        reject(error);
      }
    });
  }

  private closeEventSource(): void {
    if (!this.eventSource) return;
    this.eventSource.close();
    this.eventSource = undefined;
    this._connectionId = undefined;
    this.subscriptions.clear();
    this.setState("disconnected");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Session Management
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get a session accessor (cold - no subscription).
   *
   * Call `accessor.subscribe()` to receive events.
   */
  session(sessionId: string): SessionAccessor {
    let accessor = this.sessions.get(sessionId);
    if (!accessor) {
      accessor = new SessionAccessorImpl(sessionId, this);
      this.sessions.set(sessionId, accessor);
    }
    return accessor;
  }

  /**
   * Subscribe to a session and get accessor (hot).
   */
  subscribe(sessionId: string): SessionAccessor {
    const accessor = this.session(sessionId);
    accessor.subscribe();
    return accessor;
  }

  /** @internal - Called by SessionAccessor */
  async _subscribeToSession(sessionId: string): Promise<void> {
    await this.ensureConnection();
    if (this.subscriptions.has(sessionId)) {
      return;
    }

    if (!this._connectionId) {
      throw new Error("Connection not established");
    }

    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const subscribePath = this.config.paths?.subscribe ?? "/subscribe";

    const response = await this.fetchFn(`${baseUrl}${subscribePath}`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({
        connectionId: this._connectionId,
        add: [sessionId],
      }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to subscribe: ${response.status} ${text}`);
    }

    this.subscriptions.add(sessionId);
  }

  /** @internal - Called by SessionAccessor */
  async _unsubscribeFromSession(sessionId: string): Promise<void> {
    if (!this._connectionId) {
      return;
    }
    if (!this.subscriptions.has(sessionId)) {
      return;
    }

    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const subscribePath = this.config.paths?.subscribe ?? "/subscribe";

    await this.fetchFn(`${baseUrl}${subscribePath}`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({
        connectionId: this._connectionId,
        remove: [sessionId],
      }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    this.subscriptions.delete(sessionId);
  }

  /** @internal - Called by SessionAccessor to publish to a channel */
  async _publishToChannel(
    sessionId: string,
    channelName: string,
    event: ChannelEvent,
  ): Promise<void> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const channelPath = this.config.paths?.channel ?? "/channel";

    const response = await this.fetchFn(`${baseUrl}${channelPath}`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({
        sessionId,
        channel: channelName,
        type: event.type,
        payload: event.payload,
        id: event.id,
        metadata: event.metadata,
      }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to publish to channel: ${response.status} ${text}`);
    }
  }

  /** @internal - Called by SessionAccessor to subscribe to a channel */
  async _subscribeToChannel(sessionId: string, channelName: string): Promise<void> {
    // Ensure we have a connection before subscribing
    await this.ensureConnection();

    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const channelPath = this.config.paths?.channel ?? "/channel";

    const response = await this.fetchFn(`${baseUrl}${channelPath}/subscribe`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({
        sessionId,
        channel: channelName,
        clientId: this._connectionId,
      }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to subscribe to channel: ${response.status} ${text}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Message Operations
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send a message.
   *
   * @param input - Message input (message or messages)
   * @param options - Options including optional sessionId
   */
  send(
    input: string | ContentBlock | ContentBlock[] | Message | Message[] | SendInput,
    options?: { sessionId?: string },
  ): ClientExecutionHandle {
    const payload = this.normalizeSendInput(input);
    const abortController = new AbortController();
    const handle = new ClientExecutionHandleImpl(this, abortController, options?.sessionId);

    void this.performSend(payload, options, handle, abortController);

    return handle;
  }

  private async performSend(
    payload: SendInput,
    options: { sessionId?: string } | undefined,
    handle: ClientExecutionHandleImpl,
    abortController: AbortController,
  ): Promise<void> {
    try {
      const baseUrl = this.config.baseUrl.replace(/\/$/, "");
      const sendPath = this.config.paths?.send ?? "/send";

      const body: Record<string, unknown> = { ...payload };
      if (options?.sessionId) {
        body.sessionId = options.sessionId;
      }

      const response = await this.fetchFn(`${baseUrl}${sendPath}`, {
        method: "POST",
        headers: this.requestHeaders,
        credentials: this.config.withCredentials ? "include" : "same-origin",
        body: JSON.stringify(body),
        signal: abortController.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to send: ${response.status} ${text}`);
      }

      if (!response.body) {
        throw new Error("No response body for send");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (data.type === "channel" || data.type === "connection") {
              continue;
            }
            const event = data as unknown as SessionStreamEvent;
            handle._handleEvent(event);
            this.handleIncomingEvent(data);
          } catch (error) {
            console.error("Failed to parse send event:", error);
          }
        }
      }

      handle._complete();
    } catch (error) {
      handle._fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private normalizeSendInput(
    input: string | ContentBlock | ContentBlock[] | Message | Message[] | SendInput,
  ): SendInput {
    if (typeof input === "string") {
      return { message: { role: "user", content: [{ type: "text", text: input }] } };
    }
    if (Array.isArray(input)) {
      if (input.length === 0) {
        return { messages: [] };
      }
      if (typeof (input[0] as Message).role === "string") {
        return { messages: input as Message[] };
      }
      return { message: { role: "user", content: input as ContentBlock[] } };
    }
    if (typeof input === "object" && input && "role" in input && "content" in input) {
      return { message: input as Message };
    }
    return input as SendInput;
  }

  /**
   * Abort a session's current execution.
   */
  async abort(sessionId: string, reason?: string): Promise<void> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const abortPath = this.config.paths?.abort ?? "/abort";

    const response = await this.fetchFn(`${baseUrl}${abortPath}`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({ sessionId, reason }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to abort: ${response.status} ${text}`);
    }
  }

  /**
   * Close a session.
   */
  async closeSession(sessionId: string): Promise<void> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const closePath = this.config.paths?.close ?? "/close";

    const response = await this.fetchFn(`${baseUrl}${closePath}`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({ sessionId }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to close: ${response.status} ${text}`);
    }

    // Clean up accessor
    const accessor = this.sessions.get(sessionId);
    if (accessor) {
      accessor._destroy();
      this.sessions.delete(sessionId);
    }
    this.subscriptions.delete(sessionId);
  }

  /**
   * Submit a tool confirmation response.
   */
  async submitToolResult(
    sessionId: string,
    toolUseId: string,
    result: ToolConfirmationResponse,
  ): Promise<void> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const toolResponsePath = this.config.paths?.toolResponse ?? "/tool-response";

    const response = await this.fetchFn(`${baseUrl}${toolResponsePath}`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({ sessionId, toolUseId, result }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to submit tool result: ${response.status} ${text}`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Event Handling
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Subscribe to all stream events (from all sessions).
   */
  onEvent(handler: GlobalEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Ergonomic event subscription.
   */
  on<T extends ClientEventName>(eventName: T, handler: ClientEventHandlerMap[T]): () => void {
    switch (eventName) {
      case "event":
        return this.onEvent(handler as GlobalEventHandler);
      case "state":
        return this.onConnectionChange(handler as (state: ConnectionState) => void);
      default: {
        const streamType = eventName as StreamEventType;
        const streamHandler = handler as GlobalStreamEventHandler<typeof streamType>;
        return this.onEvent((event: SessionStreamEvent) => {
          if (event.type === streamType) {
            streamHandler(event as any);
          }
        });
      }
    }
  }

  private handleIncomingEvent(data: Record<string, unknown>): void {
    const sessionId = data.sessionId as string | undefined;
    const type = data.type as string;

    // Handle connection event
    if (type === "connection") {
      return;
    }

    // Handle channel events (from server → client)
    if (type === "channel" && sessionId) {
      const channelName = data.channel as string;
      const channelEvent = data.event as ChannelEvent;
      if (channelName && channelEvent) {
        const accessor = this.sessions.get(sessionId);
        if (accessor) {
          accessor._handleChannelEvent(channelName, channelEvent);
        }
      }
      return;
    }

    // Route stream events
    const streamEvent = data as unknown as StreamEvent;
    const eventId = (streamEvent as { id?: string }).id;
    if (eventId) {
      if (this.seenEventIds.has(eventId)) {
        return;
      }
      this.seenEventIds.add(eventId);
      this.seenEventIdsOrder.push(eventId);
      if (this.seenEventIdsOrder.length > this.maxSeenEventIds) {
        const oldest = this.seenEventIdsOrder.shift();
        if (oldest) {
          this.seenEventIds.delete(oldest);
        }
      }
    }

    // Update streaming text state
    this.updateStreamingText(streamEvent);

    // Notify global handlers
    if (sessionId) {
      const sessionEvent = streamEvent as SessionStreamEvent;
      for (const handler of this.eventHandlers) {
        try {
          handler(sessionEvent);
        } catch (error) {
          console.error("Error in event handler:", error);
        }
      }
    }

    // Notify session-specific handlers
    if (sessionId) {
      const accessor = this.sessions.get(sessionId);
      if (accessor) {
        accessor._handleEvent(streamEvent);
      }
    }

    // Handle result events
    if (type === "result" && "result" in data) {
      if (sessionId) {
        const accessor = this.sessions.get(sessionId);
        if (accessor) {
          accessor._handleResult(data.result as SessionResultPayload);
        }
      }
    }

    // Handle tool confirmation requests
    if (type === "tool_confirmation_required" && sessionId) {
      const required = data as unknown as {
        callId: string;
        name: string;
        input: Record<string, unknown>;
        message?: string;
      };
      const request: ToolConfirmationRequest = {
        toolUseId: required.callId,
        name: required.name,
        arguments: required.input,
        message: required.message,
      };
      const accessor = this.sessions.get(sessionId);
      if (accessor) {
        accessor._handleToolConfirmation(request);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Streaming Text
  // ══════════════════════════════════════════════════════════════════════════

  /** Current streaming text state */
  get streamingText(): StreamingTextState {
    return this._streamingText;
  }

  /**
   * Subscribe to streaming text state changes.
   */
  onStreamingText(handler: StreamingTextHandler): () => void {
    this.streamingTextHandlers.add(handler);
    handler(this._streamingText);
    return () => {
      this.streamingTextHandlers.delete(handler);
    };
  }

  /** Clear the accumulated streaming text */
  clearStreamingText(): void {
    this.setStreamingText({ text: "", isStreaming: false });
  }

  private setStreamingText(state: StreamingTextState): void {
    this._streamingText = state;
    for (const handler of this.streamingTextHandlers) {
      try {
        handler(state);
      } catch (error) {
        console.error("Error in streaming text handler:", error);
      }
    }
  }

  private updateStreamingText(event: StreamEvent): void {
    switch (event.type) {
      case "tick_start":
        this.setStreamingText({ text: "", isStreaming: true });
        break;

      case "content_delta":
        this.setStreamingText({
          text: this._streamingText.text + (event as { delta: string }).delta,
          isStreaming: true,
        });
        break;

      case "tick_end":
      case "execution_end":
        this.setStreamingText({
          text: this._streamingText.text,
          isStreaming: false,
        });
        break;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Custom Method Invocation
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Invoke a custom Gateway method.
   * For session-scoped methods, use session.invoke() instead.
   *
   * @example
   * ```typescript
   * // Invoke a custom method
   * const result = await client.invoke("tasks:list", { status: "active" });
   *
   * // Invoke with admin method
   * const stats = await client.invoke("admin:stats");
   * ```
   */
  async invoke<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const invokePath = this.config.paths?.invoke ?? "/invoke";

    const response = await this.fetchFn(`${baseUrl}${invokePath}`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({
        method,
        params,
      }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to invoke method: ${response.status} ${text}`);
    }

    const result = await response.json();
    return result as T;
  }

  /**
   * Invoke a streaming method, returns async iterator.
   * Yields values as they arrive from the server.
   *
   * @example
   * ```typescript
   * // Stream task updates
   * for await (const change of client.stream("tasks:watch")) {
   *   console.log("Task changed:", change);
   * }
   * ```
   */
  async *stream<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): AsyncGenerator<T> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const invokePath = this.config.paths?.invoke ?? "/invoke";

    const response = await this.fetchFn(`${baseUrl}${invokePath}`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({
        method,
        params,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to invoke streaming method: ${response.status} ${text}`);
    }

    if (!response.body) {
      throw new Error("No response body for streaming method");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const data = JSON.parse(line.slice(6)) as Record<string, unknown>;
          if (data.type === "method:chunk") {
            yield data.chunk as T;
          } else if (data.type === "method:end") {
            return;
          }
        } catch (error) {
          console.error("Failed to parse stream event:", error);
        }
      }
    }
  }

  /**
   * Get authorization headers for use with fetch.
   * Useful for making authenticated requests to custom routes.
   *
   * @example
   * ```typescript
   * // Make authenticated request to custom API
   * const response = await fetch("/api/custom", {
   *   headers: client.getAuthHeaders(),
   * });
   * ```
   */
  getAuthHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.config.token) {
      headers["Authorization"] = `Bearer ${this.config.token}`;
    }
    return headers;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Cleanup
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Cleanup and close the client.
   */
  destroy(): void {
    this.closeEventSource();

    for (const accessor of this.sessions.values()) {
      accessor._destroy();
    }
    this.sessions.clear();

    this.stateHandlers.clear();
    this.eventHandlers.clear();
    this.streamingTextHandlers.clear();
    this._streamingText = { text: "", isStreaming: false };
    this.seenEventIds.clear();
    this.seenEventIdsOrder = [];
    this.subscriptions.clear();
  }
}

// ============================================================================
// Transport Detection
// ============================================================================

/**
 * Detect the appropriate transport based on URL scheme.
 */
function detectTransport(baseUrl: string): "sse" | "websocket" {
  const url = baseUrl.toLowerCase();
  if (url.startsWith("ws://") || url.startsWith("wss://")) {
    return "websocket";
  }
  return "sse";
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a new TentickleClient.
 *
 * Transport is auto-detected from the URL scheme:
 * - http:// or https:// -> SSE transport
 * - ws:// or wss:// -> WebSocket transport
 *
 * You can also explicitly set the transport in the config.
 *
 * @example
 * ```typescript
 * // Auto-detect transport (SSE for http://)
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 * });
 *
 * // Auto-detect transport (WebSocket for ws://)
 * const wsClient = createClient({
 *   baseUrl: 'ws://localhost:18789',
 * });
 *
 * // Force WebSocket transport
 * const wsClient2 = createClient({
 *   baseUrl: 'http://localhost:3000',
 *   transport: 'websocket',
 * });
 *
 * // Subscribe to a session
 * const session = client.subscribe('conv-123');
 *
 * // Send a message
 * const handle = session.send({ message: { role: 'user', content: [...] } });
 * await handle.result;
 * ```
 */
export function createClient(config: TentickleClientConfig): TentickleClient {
  const transport =
    config.transport === "auto" || !config.transport
      ? detectTransport(config.baseUrl)
      : config.transport;

  if (transport === "websocket") {
    // Log warning - WebSocket transport requires using the WSTransport directly
    // or the gateway client for full functionality
    console.warn(
      "[TentickleClient] WebSocket URL detected. For full WebSocket support, " +
        "use createWSTransport() directly or connect to a Gateway. " +
        "Falling back to SSE transport with URL conversion.",
    );

    // Convert ws:// to http:// for SSE fallback
    let baseUrl = config.baseUrl;
    if (baseUrl.startsWith("ws://")) {
      baseUrl = baseUrl.replace("ws://", "http://");
    } else if (baseUrl.startsWith("wss://")) {
      baseUrl = baseUrl.replace("wss://", "https://");
    }

    return new TentickleClient({ ...config, baseUrl });
  }

  return new TentickleClient(config);
}
