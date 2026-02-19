/**
 * WebSocket Transport
 *
 * Implements the ClientTransport interface using WebSocket connections.
 * Compatible with the Gateway's WebSocket protocol.
 */

import type {
  ClientTransport,
  TransportConfig,
  TransportEventData,
  TransportEventHandler,
  TransportState,
} from "./transport.js";
import type { SendInput, ChannelEvent, ToolConfirmationResponse } from "./types.js";
import { unwrapEventMessage } from "./transport-utils.js";

// ============================================================================
// WebSocket Transport Configuration
// ============================================================================

export interface WSTransportConfig extends TransportConfig {
  /** Client ID to use for connection */
  clientId?: string;

  /** WebSocket implementation (for Node.js compatibility) */
  WebSocket?: typeof WebSocket;

  /** Reconnection settings */
  reconnect?: {
    /** Enable auto-reconnection (default: true) */
    enabled?: boolean;
    /** Max reconnection attempts (default: 5) */
    maxAttempts?: number;
    /** Delay between attempts in ms (default: 1000) */
    delay?: number;
  };
}

// ============================================================================
// Request Queue
// ============================================================================

interface PendingRequest {
  resolve: (response: TransportEventData) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// ============================================================================
// WebSocket Transport Implementation
// ============================================================================

export class WSTransport implements ClientTransport {
  private config: WSTransportConfig;
  private WSCtor: typeof WebSocket;
  private socket?: WebSocket;

  private _state: TransportState = "disconnected";
  private _connectionId?: string;
  private connectionPromise?: Promise<void>;
  private reconnectAttempts = 0;

  private requestCounter = 0;
  private pendingRequests = new Map<string, PendingRequest>();
  private eventHandlers = new Set<TransportEventHandler>();
  private stateHandlers = new Set<(state: TransportState) => void>();
  private subscriptions = new Set<string>();

  // For streaming sends - map executionId to queue
  private sendStreams = new Map<
    string,
    {
      events: TransportEventData[];
      resolvers: Array<(result: IteratorResult<TransportEventData>) => void>;
      closed: boolean;
    }
  >();

  constructor(config: WSTransportConfig) {
    this.config = config;
    this.WSCtor = config.WebSocket ?? globalThis.WebSocket;
  }

  get state(): TransportState {
    return this._state;
  }

  get connectionId(): string | undefined {
    return this._connectionId;
  }

  private setState(state: TransportState): void {
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

  async connect(): Promise<void> {
    if (this._state === "connected") {
      return;
    }
    if (this.connectionPromise) {
      await this.connectionPromise;
      return;
    }

    this.setState("connecting");
    this.connectionPromise = this.openWebSocket();

    try {
      await this.connectionPromise;
      this.setState("connected");
      this.reconnectAttempts = 0;
    } catch (error) {
      this.setState("error");
      throw error;
    } finally {
      this.connectionPromise = undefined;
    }
  }

  disconnect(): void {
    this.closeWebSocket();
  }

  private async openWebSocket(): Promise<void> {
    this.closeWebSocket();

    // Convert http:// to ws:// or https:// to wss://
    let url = this.config.baseUrl.replace(/\/$/, "");
    if (url.startsWith("http://")) {
      url = url.replace("http://", "ws://");
    } else if (url.startsWith("https://")) {
      url = url.replace("https://", "wss://");
    }

    return new Promise((resolve, reject) => {
      try {
        this.socket = new this.WSCtor(url);

        this.socket.onopen = () => {
          // Send connect message
          this.sendRaw({
            type: "connect",
            clientId: this.config.clientId ?? `client-${Date.now().toString(36)}`,
            token: this.config.token,
          });

          // Set connection ID immediately (will be updated if server sends one)
          this._connectionId = this.config.clientId ?? `client-${Date.now().toString(36)}`;
          resolve();
        };

        this.socket.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data as string);
            this.handleMessage(data);
          } catch (error) {
            console.error("Failed to parse WebSocket message:", error);
          }
        };

        this.socket.onerror = () => {
          if (this._state === "connecting") {
            reject(new Error("WebSocket connection failed"));
          }
        };

        this.socket.onclose = () => {
          this.handleClose();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private closeWebSocket(): void {
    if (!this.socket) return;

    // Clear all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    this.pendingRequests.clear();

    // Close all send streams
    for (const [, stream] of this.sendStreams) {
      stream.closed = true;
      for (const resolver of stream.resolvers) {
        resolver({ value: undefined as unknown as TransportEventData, done: true });
      }
    }
    this.sendStreams.clear();

    this.socket.close();
    this.socket = undefined;
    this._connectionId = undefined;
    this.subscriptions.clear();
    this.setState("disconnected");
  }

  private handleClose(): void {
    const wasConnected = this._state === "connected";
    this._connectionId = undefined;
    this.subscriptions.clear();
    this.setState("disconnected");

    // Attempt reconnection
    const reconnect = this.config.reconnect;
    if (wasConnected && reconnect?.enabled !== false) {
      const maxAttempts = reconnect?.maxAttempts ?? 5;
      const delay = reconnect?.delay ?? 1000;

      if (this.reconnectAttempts < maxAttempts) {
        this.reconnectAttempts++;
        setTimeout(() => {
          this.connect().catch((error) => {
            console.error("Reconnection failed:", error);
          });
        }, delay * this.reconnectAttempts);
      }
    }
  }

  private handleMessage(data: TransportEventData): void {
    const type = data.type;

    // Handle response to pending request
    if (type === "res") {
      const id = data.id as string;
      const pending = this.pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(id);
        pending.resolve(data);
        return;
      }
    }

    // Handle pong
    if (type === "pong") {
      return;
    }

    // Handle error
    if (type === "error") {
      console.error("Gateway error:", data.message);
      return;
    }

    // Handle session events (from event subscription or send streaming)
    if (type === "event") {
      const eventData = unwrapEventMessage(data) as TransportEventData;

      // Check if this event is for an active send stream
      // We use sessionId to find the stream since executionId may not be set yet
      for (const [, stream] of this.sendStreams) {
        if (!stream.closed) {
          const resolver = stream.resolvers.shift();
          if (resolver) {
            resolver({ value: eventData, done: false });
          } else {
            stream.events.push(eventData);
          }
        }
      }

      // Also notify general event handlers
      this.handleIncomingEvent(eventData);
      return;
    }

    // Forward other events to handlers
    this.handleIncomingEvent(data);
  }

  private handleIncomingEvent(data: TransportEventData): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(data);
      } catch (error) {
        console.error("Error in event handler:", error);
      }
    }
  }

  private sendRaw(data: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(data));
    }
  }

  private async sendRequest(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<TransportEventData> {
    await this.connect();

    const id = `req-${++this.requestCounter}`;
    const timeout = this.config.timeout ?? 30000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timeout: timer });

      this.sendRaw({
        type: "req",
        id,
        method,
        params,
      });
    });
  }

  send(
    input: SendInput,
    sessionId?: string,
  ): AsyncIterable<TransportEventData> & { abort: (reason?: string) => void } {
    const streamId = `stream-${++this.requestCounter}`;
    const stream = {
      events: [] as TransportEventData[],
      resolvers: [] as Array<(result: IteratorResult<TransportEventData>) => void>,
      closed: false,
    };
    this.sendStreams.set(streamId, stream);

    const self = this;
    let sessionIdFromResponse: string | undefined;
    let aborted = false;

    // Start the send request
    const sendPromise = this.sendRequest("send", {
      sessionId: sessionId ?? "main",
      message:
        typeof input === "string"
          ? input
          : "message" in input && input.message
            ? (() => {
                const msg = input.message;
                if (typeof msg === "string") return msg;
                if (
                  msg &&
                  typeof msg === "object" &&
                  "content" in msg &&
                  Array.isArray(msg.content)
                ) {
                  const textBlock = msg.content.find(
                    (b): b is { type: "text"; text: string } => b.type === "text",
                  );
                  return textBlock?.text ?? "";
                }
                return "";
              })()
            : "",
    });

    sendPromise
      .then((response) => {
        if (response.ok && response.payload) {
          sessionIdFromResponse = (response.payload as { sessionId?: string }).sessionId;
        }
      })
      .catch((error) => {
        // Close stream on error
        stream.closed = true;
        const errorEvent = { type: "error", error: error.message };
        const resolver = stream.resolvers.shift();
        if (resolver) {
          resolver({ value: errorEvent, done: false });
        }
        // Then close
        for (const r of stream.resolvers) {
          r({ value: undefined as unknown as TransportEventData, done: true });
        }
        stream.resolvers = [];
      });

    const iterable = {
      async *[Symbol.asyncIterator](): AsyncIterator<TransportEventData> {
        try {
          while (!stream.closed && !aborted) {
            // Check for buffered events
            if (stream.events.length > 0) {
              const event = stream.events.shift()!;
              yield event;

              // Check for end events
              if (event.type === "execution_end" || event.type === "message_end") {
                break;
              }
              continue;
            }

            // Wait for next event
            const result = await new Promise<IteratorResult<TransportEventData>>((resolve) => {
              stream.resolvers.push(resolve);
            });

            if (result.done) {
              break;
            }

            yield result.value;

            // Check for end events
            if (result.value.type === "execution_end" || result.value.type === "message_end") {
              break;
            }
          }
        } finally {
          stream.closed = true;
          self.sendStreams.delete(streamId);
        }
      },

      abort(reason?: string) {
        aborted = true;
        stream.closed = true;

        // Close all waiting resolvers
        for (const resolver of stream.resolvers) {
          resolver({ value: undefined as unknown as TransportEventData, done: true });
        }
        stream.resolvers = [];

        // Send abort request to server
        if (sessionIdFromResponse) {
          self.abortSession(sessionIdFromResponse, reason).catch(() => {});
        }
      },
    };

    return iterable;
  }

  async subscribeToSession(sessionId: string): Promise<void> {
    if (this.subscriptions.has(sessionId)) {
      return;
    }

    await this.sendRequest("subscribe", { sessionId });
    this.subscriptions.add(sessionId);
  }

  async unsubscribeFromSession(sessionId: string): Promise<void> {
    if (!this.subscriptions.has(sessionId)) {
      return;
    }

    await this.sendRequest("unsubscribe", { sessionId });
    this.subscriptions.delete(sessionId);
  }

  async abortSession(sessionId: string, reason?: string): Promise<void> {
    await this.sendRequest("abort", { sessionId, reason });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.sendRequest("close", { sessionId });
    this.subscriptions.delete(sessionId);
  }

  async submitToolResult(
    sessionId: string,
    toolUseId: string,
    result: ToolConfirmationResponse,
  ): Promise<void> {
    await this.sendRequest("tool-response", { sessionId, toolUseId, result });
  }

  async publishToChannel(sessionId: string, channel: string, event: ChannelEvent): Promise<void> {
    await this.sendRequest("channel", {
      sessionId,
      channel,
      type: event.type,
      payload: event.payload,
      id: event.id,
      metadata: event.metadata,
    });
  }

  async subscribeToChannel(sessionId: string, channel: string): Promise<void> {
    await this.sendRequest("channel-subscribe", { sessionId, channel });
  }

  onEvent(handler: TransportEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  /** Send a ping to keep connection alive */
  ping(): void {
    this.sendRaw({ type: "ping", timestamp: Date.now() });
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createWSTransport(config: WSTransportConfig): WSTransport {
  return new WSTransport(config);
}
