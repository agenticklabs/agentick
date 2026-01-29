/**
 * TentickleClient - Main client for connecting to Tentickle servers.
 *
 * Provides:
 * - Pluggable transport (HTTP/SSE default, WebSocket optional)
 * - Framework channel methods (send, tick, abort, onEvent)
 * - Generic channel access (subscribe, publish, request)
 * - Session lifecycle management
 *
 * @module @tentickle/client
 */

import type {
  ConnectionState,
  Transport,
  ChannelAccessor,
  EventHandler,
  ResultHandler,
  ToolConfirmationHandler,
  ClientEventName,
  ClientEventHandlerMap,
  StreamEventType,
  StreamEventHandler,
  StreamingTextState,
  StreamingTextHandler,
  ChannelEvent,
  ConnectionMetadata,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  CreateSessionResponse,
  SessionState,
  StreamEvent,
} from "./types.js";
import { FrameworkChannels } from "@tentickle/shared";
import type { ContentBlock, Message, SessionMessagePayload, TextBlock } from "@tentickle/shared";
import { HTTPTransport, type HTTPTransportConfig } from "./transports/http.js";

// ============================================================================
// Utilities
// ============================================================================

/** Browser-compatible UUID generation */
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

  /** @internal - Called when event is received on this channel */
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
        pending.reject(new Error((event.payload as { message?: string })?.message ?? "Request failed"));
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

  /** @internal - Cleanup */
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
// TentickleClient
// ============================================================================

/**
 * Options for creating a session.
 */
export interface CreateSessionOptions {
  /** Optional session ID (generated if not provided) */
  sessionId?: string;
  /** Initial props for the session */
  props?: Record<string, unknown>;
}

/**
 * TentickleClient - Connect to Tentickle servers.
 *
 * @example
 * ```typescript
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 *   userId: 'user_123',
 * });
 *
 * // Create or get session
 * const { sessionId } = await client.createSession();
 *
 * // Connect to the session
 * await client.connect(sessionId);
 *
 * // Send messages
 * client.send('Hello!');
 *
 * // Listen for events
 * client.onEvent((event) => {
 *   if (event.type === 'content_delta') {
 *     console.log(event.delta);
 *   }
 * });
 *
 * // Trigger execution
 * client.tick();
 * ```
 */
export class TentickleClient {
  private readonly config: HTTPTransportConfig;
  private readonly transport: Transport;
  private readonly requestHeaders: Record<string, string>;
  private readonly fetchFn: typeof fetch;
  private _sessionId?: string;
  private channels = new Map<string, ChannelAccessorImpl>();
  private stateHandlers = new Set<(state: ConnectionState) => void>();
  private eventHandlers = new Set<EventHandler>();
  private resultHandlers = new Set<ResultHandler>();
  private toolConfirmationHandler?: ToolConfirmationHandler;
  private streamingTextHandlers = new Set<StreamingTextHandler>();
  private _streamingText: StreamingTextState = { text: "", isStreaming: false };
  private unsubscribeTransport?: () => void;
  private unsubscribeState?: () => void;

  constructor(config: HTTPTransportConfig, transport?: Transport) {
    this.config = config;

    // Build request headers - custom headers take precedence, token is convenience for Bearer
    this.requestHeaders = { ...config.headers };
    if (config.token && !this.requestHeaders["Authorization"]) {
      this.requestHeaders["Authorization"] = `Bearer ${config.token}`;
    }

    // Use custom fetch or fall back to global
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);

    // Use provided transport or create default HTTP transport
    // HTTPTransport accepts custom fetch/EventSource/headers via config
    this.transport = transport ?? new HTTPTransport(config);

    // Setup receive handler
    this.unsubscribeTransport = this.transport.onReceive((event) => {
      this.handleIncomingEvent(event);
    });

    // Forward transport state changes
    this.unsubscribeState = this.transport.onStateChange((state) => {
      this.notifyStateChange(state);
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Connection Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  /** Current connection state */
  get state(): ConnectionState {
    return this.transport.state;
  }

  /** Current session ID */
  get sessionId(): string | undefined {
    return this._sessionId;
  }

  /**
   * Create a new session on the server.
   */
  async createSession(options?: CreateSessionOptions): Promise<CreateSessionResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.requestHeaders,
    };

    const sessionsPath = this.config.paths?.sessions ?? "/sessions";
    const response = await this.fetchFn(`${this.config.baseUrl}${sessionsPath}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: options?.sessionId,
        props: options?.props,
      }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to create session: ${response.status} ${text}`);
    }

    return response.json() as Promise<CreateSessionResponse>;
  }

  /**
   * Get session state from the server.
   */
  async getSessionState(sessionId: string): Promise<SessionState> {
    const headers: Record<string, string> = {
      ...this.requestHeaders,
    };

    const sessionsPath = this.config.paths?.sessions ?? "/sessions";
    const response = await this.fetchFn(`${this.config.baseUrl}${sessionsPath}/${sessionId}`, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to get session state: ${response.status} ${text}`);
    }

    return response.json() as Promise<SessionState>;
  }

  /**
   * Connect to a session.
   */
  async connect(sessionId: string): Promise<void> {
    if (this.transport.state === "connected") {
      throw new Error("Already connected");
    }

    this._sessionId = sessionId;

    const metadata: ConnectionMetadata = {
      sessionId,
      userId: this.config.userId,
    };

    await this.transport.connect(sessionId, metadata);
  }

  /**
   * Disconnect from the server.
   */
  async disconnect(): Promise<void> {
    await this.transport.disconnect();
    this._sessionId = undefined;
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

  private notifyStateChange(state: ConnectionState): void {
    for (const handler of this.stateHandlers) {
      try {
        handler(state);
      } catch (error) {
        console.error("Error in connection state handler:", error);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Framework Channels
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send a message to the session.
   */
  async send(
    input:
      | string
      | string[]
      | ContentBlock
      | ContentBlock[]
      | Message
      | Message[]
      | SessionMessagePayload,
  ): Promise<void> {
    const payload = this.normalizeSendInput(input);

    await this.transport.send({
      channel: FrameworkChannels.MESSAGES,
      type: "message",
      payload,
    });
  }

  private normalizeSendInput(
    input:
      | string
      | string[]
      | ContentBlock
      | ContentBlock[]
      | Message
      | Message[]
      | SessionMessagePayload,
  ): SessionMessagePayload {
    if (typeof input === "string") {
      return { message: { role: "user", content: [{ type: "text", text: input }] } };
    }
    if (Array.isArray(input)) {
      if (input.length === 0) {
        return { messages: [] };
      }
      if (typeof input[0] === "string") {
        const blocks = (input as string[]).map((text) => ({ type: "text", text } as TextBlock));
        return { message: { role: "user", content: blocks } };
      }
      if (typeof (input[0] as Message).role === "string") {
        return { messages: input as Message[] };
      }
      return { message: { role: "user", content: input as ContentBlock[] } };
    }
    if (typeof input === "object" && input && "role" in input && "content" in input) {
      return { message: input as Message };
    }
    return input as SessionMessagePayload;
  }

  /**
   * Trigger a tick with optional props.
   */
  async tick(props?: Record<string, unknown>): Promise<void> {
    await this.transport.send({
      channel: FrameworkChannels.CONTROL,
      type: "tick",
      payload: { props },
    });
  }

  /**
   * Abort the current execution.
   */
  async abort(reason?: string): Promise<void> {
    await this.transport.send({
      channel: FrameworkChannels.CONTROL,
      type: "abort",
      payload: { reason },
    });
  }

  /**
   * Subscribe to stream events from the session.
   */
  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Ergonomic event subscription.
   *
   * @example
   * ```typescript
   * client.on("result", (result) => {
   *   console.log(result.response);
   * });
   * ```
   */
  on<T extends ClientEventName>(
    eventName: T,
    handler: ClientEventHandlerMap[T],
  ): () => void {
    switch (eventName) {
      case "event":
        return this.onEvent(handler as EventHandler);
      case "result":
        return this.onResult(handler as ResultHandler);
      case "tool_confirmation":
        return this.onToolConfirmation(handler as ToolConfirmationHandler);
      case "state":
        return this.onConnectionChange(handler as (state: ConnectionState) => void);
      default: {
        const streamType = eventName as StreamEventType;
        const streamHandler = handler as StreamEventHandler<typeof streamType>;
        return this.onEvent((event) => {
          if (event.type === streamType) {
            streamHandler(event as any);
          }
        });
      }
    }
  }

  /**
   * Subscribe to execution results.
   */
  onResult(handler: ResultHandler): () => void {
    this.resultHandlers.add(handler);
    return () => {
      this.resultHandlers.delete(handler);
    };
  }

  /**
   * Register handler for tool confirmations.
   */
  onToolConfirmation(handler: ToolConfirmationHandler): () => void {
    this.toolConfirmationHandler = handler;
    return () => {
      this.toolConfirmationHandler = undefined;
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Application Channels
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get a channel accessor for generic pub/sub.
   *
   * @example
   * ```typescript
   * const todoChannel = client.channel('todo_list');
   *
   * // Subscribe to events
   * todoChannel.subscribe((payload, event) => {
   *   if (event.type === 'tasks_updated') {
   *     updateUI(payload.tasks);
   *   }
   * });
   *
   * // Publish events
   * await todoChannel.publish('create_task', { title: 'Buy milk' });
   *
   * // Request/response
   * const tasks = await todoChannel.request('get_tasks', {});
   * ```
   */
  channel(name: string): ChannelAccessor {
    let channel = this.channels.get(name);
    if (!channel) {
      channel = new ChannelAccessorImpl(name, (event) => this.transport.send(event));
      this.channels.set(name, channel);
    }
    return channel;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Streaming Text
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Current streaming text state.
   *
   * Automatically updated from tick_start, content_delta, tick_end, and
   * execution_end events.
   */
  get streamingText(): StreamingTextState {
    return this._streamingText;
  }

  /**
   * Subscribe to streaming text state changes.
   *
   * @example
   * ```typescript
   * client.onStreamingText(({ text, isStreaming }) => {
   *   element.textContent = text;
   *   cursor.style.display = isStreaming ? 'inline' : 'none';
   * });
   * ```
   */
  onStreamingText(handler: StreamingTextHandler): () => void {
    this.streamingTextHandlers.add(handler);
    // Immediately notify with current state
    handler(this._streamingText);
    return () => {
      this.streamingTextHandlers.delete(handler);
    };
  }

  /**
   * Clear the accumulated streaming text.
   */
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
  // Internal Methods
  // ══════════════════════════════════════════════════════════════════════════

  private handleIncomingEvent(event: ChannelEvent): void {
    const channelName = event.channel;

    // Route to framework handlers
    if (channelName === FrameworkChannels.EVENTS) {
      const streamEvent = event.payload as StreamEvent;

      // Update streaming text state
      this.updateStreamingText(streamEvent);

      for (const handler of this.eventHandlers) {
        try {
          handler(streamEvent);
        } catch (error) {
          console.error("Error in event handler:", error);
        }
      }
      return;
    }

    if (channelName === FrameworkChannels.RESULT) {
      const result = event.payload as SessionResultPayload;
      for (const handler of this.resultHandlers) {
        try {
          handler(result);
        } catch (error) {
          console.error("Error in result handler:", error);
        }
      }
      return;
    }

    if (channelName === FrameworkChannels.TOOL_CONFIRMATION && event.type === "request") {
      if (this.toolConfirmationHandler) {
        const request = event.payload as ToolConfirmationRequest;
        this.toolConfirmationHandler(request, async (response: ToolConfirmationResponse) => {
          await this.transport.send({
            channel: FrameworkChannels.TOOL_CONFIRMATION,
            type: "response",
            id: event.id,
            payload: response,
          });
        });
      }
      return;
    }

    // Route to application channel handlers
    const channel = this.channels.get(channelName);
    if (channel) {
      channel._handleEvent(event);
    }
  }

  /**
   * Cleanup and close the client.
   */
  destroy(): void {
    // Unsubscribe from transport
    this.unsubscribeTransport?.();
    this.unsubscribeState?.();

    // Disconnect transport
    this.transport.disconnect();

    // Cleanup channels
    for (const channel of this.channels.values()) {
      channel._destroy();
    }
    this.channels.clear();

    // Clear handlers
    this.stateHandlers.clear();
    this.eventHandlers.clear();
    this.resultHandlers.clear();
    this.streamingTextHandlers.clear();
    this.toolConfirmationHandler = undefined;
    this._streamingText = { text: "", isStreaming: false };
  }
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create a new TentickleClient.
 *
 * @example
 * ```typescript
 * // Default HTTP/SSE transport
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 *   userId: 'user_123',
 * });
 *
 * // With custom headers (any auth scheme, API keys, etc.)
 * const clientWithApiKey = createClient({
 *   baseUrl: 'https://api.example.com',
 *   headers: { 'X-API-Key': 'my-api-key' },
 * });
 *
 * const clientWithBasicAuth = createClient({
 *   baseUrl: 'https://api.example.com',
 *   headers: { Authorization: 'Basic ' + btoa('user:pass') },
 * });
 *
 * // With Bearer token (convenience shorthand)
 * const clientWithToken = createClient({
 *   baseUrl: 'https://api.example.com',
 *   token: 'my-jwt-token', // Adds Authorization: Bearer my-jwt-token
 * });
 *
 * // With custom fetch (e.g., for credentials)
 * const clientWithCredentials = createClient({
 *   baseUrl: 'https://api.example.com',
 *   fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
 * });
 *
 * // Node.js with polyfills
 * import EventSource from 'eventsource';
 *
 * const nodeClient = createClient({
 *   baseUrl: 'https://api.example.com',
 *   EventSource,
 * });
 *
 * // Fully custom transport
 * import { createWebSocketTransport } from '@tentickle/client';
 *
 * const wsClient = createClient(
 *   { baseUrl: 'wss://api.example.com' },
 *   createWebSocketTransport({ baseUrl: 'wss://api.example.com' }),
 * );
 * ```
 */
export function createClient(config: HTTPTransportConfig, transport?: Transport): TentickleClient {
  return new TentickleClient(config, transport);
}
