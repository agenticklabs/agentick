/**
 * SSE Transport
 *
 * Implements the ClientTransport interface using HTTP requests and Server-Sent Events.
 * This is the default transport for web browsers.
 */

import type {
  ClientTransport,
  TransportConfig,
  TransportEventData,
  TransportEventHandler,
  TransportState,
} from "./transport.js";
import { unwrapEventMessage } from "./transport-utils.js";
import type { SendInput, ChannelEvent, ToolConfirmationResponse } from "./types.js";

// ============================================================================
// SSE Transport Configuration
// ============================================================================

export interface SSETransportConfig extends TransportConfig {
  /** Override default endpoint paths */
  paths?: {
    events?: string;
    send?: string;
    subscribe?: string;
    abort?: string;
    close?: string;
    toolResponse?: string;
    channel?: string;
  };

  /** Custom fetch implementation */
  fetch?: typeof fetch;

  /** Custom EventSource constructor */
  EventSource?: typeof EventSource;

  /** Reconnection settings */
  reconnect?: {
    /** Enable auto-reconnection (default: true) */
    enabled?: boolean;
    /** Max reconnection attempts (default: 5) */
    maxAttempts?: number;
    /** Base delay between attempts in ms (default: 1000) */
    delay?: number;
  };
}

// ============================================================================
// SSE Transport Implementation
// ============================================================================

export class SSETransport implements ClientTransport {
  private config: SSETransportConfig;
  private fetchFn: typeof fetch;
  private EventSourceCtor: typeof EventSource;
  private requestHeaders: Record<string, string>;

  private _state: TransportState = "disconnected";
  private _connectionId?: string;
  private eventSource?: EventSource;
  private connectionPromise?: Promise<void>;

  private eventHandlers = new Set<TransportEventHandler>();
  private stateHandlers = new Set<(state: TransportState) => void>();
  private subscriptions = new Set<string>();
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(config: SSETransportConfig) {
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
    this.connectionPromise = this.openEventSource();

    try {
      await this.connectionPromise;
      this.setState("connected");
      this.reconnectAttempts = 0; // Reset on successful connection
    } catch (error) {
      this.setState("error");
      throw error;
    } finally {
      this.connectionPromise = undefined;
    }
  }

  disconnect(): void {
    // Cancel any pending reconnect
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
    this.closeEventSource();
  }

  private attemptReconnect(): void {
    const reconnect = this.config.reconnect;
    if (reconnect?.enabled === false) {
      return;
    }

    const maxAttempts = reconnect?.maxAttempts ?? 5;
    const baseDelay = reconnect?.delay ?? 1000;

    if (this.reconnectAttempts >= maxAttempts) {
      console.error(`SSE reconnection failed after ${maxAttempts} attempts`);
      this.setState("error");
      return;
    }

    this.reconnectAttempts++;
    const delay = baseDelay * this.reconnectAttempts; // Exponential backoff

    console.log(
      `SSE reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${maxAttempts})`,
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
        // Re-subscribe to all sessions after reconnect
        await this.resubscribeAll();
      } catch (error) {
        console.error("SSE reconnection failed:", error);
        // attemptReconnect will be called again by onError if appropriate
      }
    }, delay);
  }

  private async resubscribeAll(): Promise<void> {
    // Re-register subscriptions with the new connection
    const sessionsToResubscribe = [...this.subscriptions];

    // Clear local tracking - subscribeToSession will re-add them
    this.subscriptions.clear();

    for (const sessionId of sessionsToResubscribe) {
      try {
        await this.subscribeToSession(sessionId);
      } catch (error) {
        console.error(`Failed to resubscribe to session ${sessionId}:`, error);
      }
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
            const data = unwrapEventMessage(JSON.parse(event.data)) as TransportEventData;
            this.handleIncomingEvent(data);

            if (data.type === "connection" && data.connectionId) {
              this._connectionId = data.connectionId as string;
              if (data.subscriptions) {
                for (const sessionId of data.subscriptions as string[]) {
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
            // Connection was established but then failed - attempt reconnect
            const wasConnected = this._state === "connected";
            this.closeEventSource(false); // Preserve subscriptions for reconnect

            if (wasConnected) {
              this.attemptReconnect();
            }
          }
        };

        this.eventSource.addEventListener("message", onMessage);
        this.eventSource.addEventListener("error", onError);
      } catch (error) {
        reject(error);
      }
    });
  }

  private closeEventSource(clearSubscriptions = true): void {
    if (!this.eventSource) return;
    this.eventSource.close();
    this.eventSource = undefined;
    this._connectionId = undefined;
    if (clearSubscriptions) {
      this.subscriptions.clear();
    }
    this.setState("disconnected");
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

  send(
    input: SendInput,
    sessionId?: string,
  ): AsyncIterable<TransportEventData> & { abort: (reason?: string) => void } {
    const abortController = new AbortController();
    const self = this;

    const iterable = {
      async *[Symbol.asyncIterator](): AsyncIterator<TransportEventData> {
        const baseUrl = self.config.baseUrl.replace(/\/$/, "");
        const sendPath = self.config.paths?.send ?? "/send";

        const body: Record<string, unknown> = { ...input };
        if (sessionId) {
          body.sessionId = sessionId;
        }

        const response = await self.fetchFn(`${baseUrl}${sendPath}`, {
          method: "POST",
          headers: self.requestHeaders,
          credentials: self.config.withCredentials ? "include" : "same-origin",
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

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              try {
                const data = unwrapEventMessage(JSON.parse(line.slice(6))) as TransportEventData;
                if (data.type === "channel" || data.type === "connection") {
                  continue;
                }
                self.handleIncomingEvent(data);
                yield data;
              } catch (error) {
                console.error("Failed to parse send event:", error);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      },

      abort(reason?: string) {
        abortController.abort(reason ?? "Client aborted");
      },
    };

    return iterable;
  }

  async subscribeToSession(sessionId: string): Promise<void> {
    await this.connect();
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

  async unsubscribeFromSession(sessionId: string): Promise<void> {
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

  async abortSession(sessionId: string, reason?: string): Promise<void> {
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

    this.subscriptions.delete(sessionId);
  }

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

  async publishToChannel(sessionId: string, channel: string, event: ChannelEvent): Promise<void> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const channelPath = this.config.paths?.channel ?? "/channel";

    const response = await this.fetchFn(`${baseUrl}${channelPath}`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({
        sessionId,
        channel,
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

  async subscribeToChannel(sessionId: string, channel: string): Promise<void> {
    const baseUrl = this.config.baseUrl.replace(/\/$/, "");
    const channelPath = this.config.paths?.channel ?? "/channel";

    const response = await this.fetchFn(`${baseUrl}${channelPath}/subscribe`, {
      method: "POST",
      headers: this.requestHeaders,
      credentials: this.config.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({
        sessionId,
        channel,
        clientId: this._connectionId, // Required for event forwarding to SSE
      }),
      signal: AbortSignal.timeout(this.config.timeout ?? 30000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to subscribe to channel: ${response.status} ${text}`);
    }
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
}

// ============================================================================
// Factory Function
// ============================================================================

export function createSSETransport(config: SSETransportConfig): SSETransport {
  return new SSETransport(config);
}
