/**
 * WebSocket Transport - Alternative transport implementation
 *
 * Bidirectional communication over WebSocket.
 * Use when you need lower latency or when SSE is not available.
 *
 * @module @tentickle/client/transports/websocket
 */

import type {
  Transport,
  ClientConfig,
  ConnectionState,
  ConnectionMetadata,
  ChannelEvent,
} from "../types.js";

// ============================================================================
// Types for Custom Implementations
// ============================================================================

/**
 * WebSocket constructor signature.
 * Allows replacing the default WebSocket (e.g., with 'ws' package in Node.js).
 */
export interface WebSocketConstructor {
  new (url: string | URL, protocols?: string | string[]): WebSocket;
}

/**
 * WebSocket transport configuration.
 */
export interface WebSocketConfig extends ClientConfig {
  /** WebSocket URL (ws:// or wss://) - overrides baseUrl */
  wsUrl?: string;
  /** WebSocket protocols */
  protocols?: string[];
  /**
   * Custom WebSocket constructor.
   * Use this for Node.js (ws package) or custom implementations.
   *
   * @example
   * ```typescript
   * import WebSocket from 'ws';
   *
   * const transport = createWebSocketTransport({
   *   baseUrl: 'wss://api.example.com',
   *   WebSocket: WebSocket as unknown as WebSocketConstructor,
   * });
   * ```
   */
  WebSocket?: WebSocketConstructor;
}

/**
 * WebSocket Transport implementation.
 *
 * Use this when:
 * - You need bidirectional real-time communication
 * - SSE is blocked or unavailable
 * - You want lower latency
 */
export class WebSocketTransport implements Transport {
  readonly name = "websocket";

  private _state: ConnectionState = "disconnected";
  private sessionId?: string;
  private metadata?: ConnectionMetadata;
  private ws?: WebSocket;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private receiveHandlers = new Set<(event: ChannelEvent) => void>();
  private stateHandlers = new Set<(state: ConnectionState) => void>();

  private readonly wsUrl: string;
  private readonly protocols?: string[];
  private readonly token?: string;
  private readonly reconnectDelay: number;
  private readonly maxReconnectAttempts: number;

  /** Custom WebSocket constructor (defaults to global WebSocket) */
  private readonly WebSocketCtor: WebSocketConstructor;

  constructor(config: WebSocketConfig) {
    // Convert HTTP URL to WebSocket URL if needed
    const baseUrl = config.wsUrl ?? config.baseUrl;
    this.wsUrl = baseUrl
      .replace(/^http:/, "ws:")
      .replace(/^https:/, "wss:")
      .replace(/\/$/, "");

    this.protocols = config.protocols;
    this.token = config.token;
    this.reconnectDelay = config.reconnectDelay ?? 1000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;

    // Use custom implementation or fall back to global
    this.WebSocketCtor = config.WebSocket ?? globalThis.WebSocket;
  }

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
   * Connect to WebSocket server.
   */
  async connect(sessionId: string, metadata?: ConnectionMetadata): Promise<void> {
    if (this._state === "connected") {
      throw new Error("Already connected");
    }

    this.sessionId = sessionId;
    this.metadata = metadata;
    this.reconnectAttempts = 0;
    this.setState("connecting");

    try {
      await this.connectWebSocket();
      this.setState("connected");
    } catch (error) {
      this.setState("error");
      throw error;
    }
  }

  private async connectWebSocket(): Promise<void> {
    if (!this.sessionId) {
      throw new Error("Session ID required");
    }

    // Close existing connection
    this.closeWebSocket();

    // Build WebSocket URL with query params
    const url = new URL(this.wsUrl);
    url.searchParams.set("sessionId", this.sessionId);
    if (this.metadata?.userId) {
      url.searchParams.set("userId", String(this.metadata.userId));
    }
    if (this.token) {
      url.searchParams.set("token", this.token);
    }

    return new Promise((resolve, reject) => {
      try {
        this.ws = new this.WebSocketCtor(url.toString(), this.protocols);

        this.ws.onopen = () => {
          this.reconnectAttempts = 0;
          resolve();
        };

        this.ws.onmessage = (event) => {
          try {
            const channelEvent: ChannelEvent = JSON.parse(event.data);
            this.notifyReceive(channelEvent);
          } catch (error) {
            console.error("Failed to parse WebSocket message:", error);
          }
        };

        this.ws.onerror = () => {
          if (this._state === "connecting") {
            reject(new Error("WebSocket connection failed"));
          }
        };

        this.ws.onclose = () => {
          if (this._state === "disconnected") {
            // Intentional disconnect
            return;
          }
          this.handleReconnect();
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      this.setState("error");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5);

    this.reconnectTimer = setTimeout(() => {
      if (this.sessionId && this._state !== "disconnected") {
        this.connectWebSocket()
          .then(() => this.setState("connected"))
          .catch((error) => {
            console.error("Reconnection failed:", error);
          });
      }
    }, delay);
  }

  private closeWebSocket(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = undefined;
    }
  }

  /**
   * Disconnect from server.
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.setState("disconnected"); // Set before close to prevent reconnect
    this.closeWebSocket();
    this.sessionId = undefined;
    this.metadata = undefined;
    this.reconnectAttempts = 0;
  }

  /**
   * Send event via WebSocket.
   */
  async send(event: ChannelEvent): Promise<void> {
    if (!this.ws || this._state !== "connected") {
      throw new Error("Not connected");
    }

    this.ws.send(
      JSON.stringify({
        ...event,
        metadata: {
          ...event.metadata,
          sessionId: this.sessionId,
          userId: this.metadata?.userId,
          timestamp: Date.now(),
        },
      }),
    );
  }

  /**
   * Register receive handler.
   */
  onReceive(handler: (event: ChannelEvent) => void): () => void {
    this.receiveHandlers.add(handler);
    return () => {
      this.receiveHandlers.delete(handler);
    };
  }

  /**
   * Register state change handler.
   */
  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.add(handler);
    return () => {
      this.stateHandlers.delete(handler);
    };
  }

  private notifyReceive(event: ChannelEvent): void {
    for (const handler of this.receiveHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("Error in receive handler:", error);
      }
    }
  }
}

/**
 * Create WebSocket transport.
 *
 * @example
 * ```typescript
 * // Browser usage
 * const transport = createWebSocketTransport({
 *   baseUrl: 'wss://api.example.com',
 * });
 *
 * // Node.js with ws package
 * import WebSocket from 'ws';
 *
 * const nodeTransport = createWebSocketTransport({
 *   baseUrl: 'wss://api.example.com',
 *   WebSocket: WebSocket as unknown as WebSocketConstructor,
 * });
 * ```
 */
export function createWebSocketTransport(config: WebSocketConfig): Transport {
  return new WebSocketTransport(config);
}
