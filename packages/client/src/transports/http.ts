/**
 * HTTP/SSE Transport - Default transport implementation
 *
 * - Server → Client: Server-Sent Events (SSE)
 * - Client → Server: HTTP POST
 *
 * @module @tentickle/client/transports/http
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
 * Custom fetch function signature.
 * Allows replacing the default fetch with axios, ky, or a custom wrapper.
 */
export type FetchFn = typeof fetch;

/**
 * EventSource constructor signature.
 * Allows replacing the default EventSource (e.g., for polyfills or custom implementations).
 */
export interface EventSourceConstructor {
  new (url: string | URL, init?: { withCredentials?: boolean }): EventSource;
}

/**
 * HTTP transport configuration.
 */
export interface HTTPTransportConfig extends ClientConfig {
  /**
   * Custom headers to include in all requests.
   * These are merged with defaults (Content-Type: application/json).
   * User-provided headers take precedence over defaults.
   *
   * Use this for custom auth schemes, API keys, or any other headers.
   *
   * @example
   * ```typescript
   * // Basic auth
   * const transport = createHTTPTransport({
   *   baseUrl: 'https://api.example.com',
   *   headers: { Authorization: 'Basic ' + btoa('user:pass') },
   * });
   *
   * // API key
   * const transport = createHTTPTransport({
   *   baseUrl: 'https://api.example.com',
   *   headers: { 'X-API-Key': 'my-api-key' },
   * });
   * ```
   */
  headers?: Record<string, string>;

  /**
   * Send cookies with requests and SSE (EventSource withCredentials).
   * Defaults to false.
   */
  withCredentials?: boolean;

  /**
   * Include auth token in SSE query params (EventSource lacks headers).
   * Defaults to false to avoid token leakage in logs.
   */
  authTokenInQuery?: boolean;

  /**
   * Custom fetch implementation.
   * Use this to inject axios, ky, or a fetch wrapper with custom credentials/interceptors.
   *
   * @example
   * ```typescript
   * import ky from 'ky';
   *
   * const transport = createHTTPTransport({
   *   baseUrl: 'https://api.example.com',
   *   fetch: ky as unknown as FetchFn,
   * });
   * ```
   */
  fetch?: FetchFn;

  /**
   * Custom EventSource constructor.
   * Use this for polyfills (e.g., eventsource package in Node.js) or custom implementations.
   *
   * @example
   * ```typescript
   * import EventSource from 'eventsource';
   *
   * const transport = createHTTPTransport({
   *   baseUrl: 'https://api.example.com',
   *   EventSource: EventSource,
   * });
   * ```
   */
  EventSource?: EventSourceConstructor;
}

/**
 * HTTP/SSE Transport implementation.
 *
 * This is the default transport for Tentickle clients.
 * Uses SSE for server-to-client streaming and HTTP POST for client-to-server messages.
 *
 * Supports custom fetch and EventSource implementations for:
 * - Server-side (Node.js) usage with polyfills
 * - Custom HTTP clients (axios, ky, got)
 * - Credentials/interceptors
 * - Testing with mocks
 */
export class HTTPTransport implements Transport {
  readonly name = "http";

  private _state: ConnectionState = "disconnected";
  private sessionId?: string;
  private metadata?: ConnectionMetadata;
  private eventSource?: EventSource;
  private reconnectAttempts = 0;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private receiveHandlers = new Set<(event: ChannelEvent) => void>();
  private stateHandlers = new Set<(state: ConnectionState) => void>();

  private readonly baseUrl: string;
  private readonly eventsPath: string;
  private readonly timeout: number;
  private readonly reconnectDelay: number;
  private readonly maxReconnectAttempts: number;
  private readonly withCredentials: boolean;
  private readonly authTokenInQuery: boolean;

  /** Token for SSE query param auth (EventSource doesn't support headers) */
  private readonly token?: string;
  /** Custom headers to merge with defaults for fetch requests */
  private readonly customHeaders: Record<string, string>;
  /** Custom fetch implementation (defaults to global fetch) */
  private readonly fetchFn: FetchFn;
  /** Custom EventSource constructor (defaults to global EventSource) */
  private readonly EventSourceCtor: EventSourceConstructor;

  constructor(config: HTTPTransportConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, ""); // Remove trailing slash
    this.eventsPath = config.paths?.events ?? "/events";
    this.timeout = config.timeout ?? 30000;
    this.reconnectDelay = config.reconnectDelay ?? 1000;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 10;
    this.withCredentials = config.withCredentials ?? false;
    this.authTokenInQuery = config.authTokenInQuery ?? false;

    // Token is used for SSE query param (EventSource doesn't support custom headers)
    this.token = config.token;

    // Build custom headers for fetch requests - token adds Bearer auth if no custom Authorization
    this.customHeaders = { ...config.headers };
    if (config.token && !this.customHeaders["Authorization"]) {
      this.customHeaders["Authorization"] = `Bearer ${config.token}`;
    }

    // Use custom implementations or fall back to globals
    this.fetchFn = config.fetch ?? globalThis.fetch.bind(globalThis);
    this.EventSourceCtor = config.EventSource ?? globalThis.EventSource;
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
   * Connect to the SSE stream.
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
      await this.connectSSE();
      this.setState("connected");
    } catch (error) {
      this.setState("error");
      throw error;
    }
  }

  private async connectSSE(): Promise<void> {
    if (!this.sessionId) {
      throw new Error("Session ID required");
    }

    // Close existing connection
    this.closeEventSource();

    // Build SSE URL with query params
    const url = new URL(`${this.baseUrl}${this.eventsPath}`);
    url.searchParams.set("sessionId", this.sessionId);
    if (this.metadata?.userId) {
      url.searchParams.set("userId", String(this.metadata.userId));
    }
    if (this.token && this.authTokenInQuery) {
      url.searchParams.set("token", this.token);
    }

    return new Promise((resolve, reject) => {
      try {
        this.eventSource = new this.EventSourceCtor(url.toString(), {
          withCredentials: this.withCredentials,
        });

        const onOpen = () => {
          this.reconnectAttempts = 0;
          resolve();
        };

        const onMessage = (event: MessageEvent) => {
          try {
            const channelEvent: ChannelEvent = JSON.parse(event.data);
            this.notifyReceive(channelEvent);
          } catch (error) {
            console.error("Failed to parse SSE event:", error);
          }
        };

        const onError = () => {
          if (this._state === "connecting") {
            this.closeEventSource();
            reject(new Error("SSE connection failed"));
          } else {
            this.handleReconnect();
          }
        };

        this.eventSource.addEventListener("open", onOpen);
        this.eventSource.addEventListener("message", onMessage);
        this.eventSource.addEventListener("error", onError);
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
    const delay = this.reconnectDelay * Math.min(this.reconnectAttempts, 5); // Cap backoff

    this.reconnectTimer = setTimeout(() => {
      if (this.sessionId && this._state !== "disconnected") {
        this.connectSSE()
          .then(() => this.setState("connected"))
          .catch((error) => {
            console.error("Reconnection failed:", error);
          });
      }
    }, delay);
  }

  private closeEventSource(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = undefined;
    }
  }

  /**
   * Disconnect from the server.
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    this.closeEventSource();
    this.sessionId = undefined;
    this.metadata = undefined;
    this.reconnectAttempts = 0;
    this.setState("disconnected");
  }

  /**
   * Send event via HTTP POST.
   */
  async send(event: ChannelEvent): Promise<void> {
    if (!this.sessionId) {
      throw new Error("Not connected");
    }

    // Merge default headers with custom headers (custom takes precedence)
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.customHeaders,
    };

    const response = await this.fetchFn(`${this.baseUrl}${this.eventsPath}`, {
      method: "POST",
      headers,
      credentials: this.withCredentials ? "include" : "same-origin",
      body: JSON.stringify({
        ...event,
        metadata: {
          ...event.metadata,
          sessionId: this.sessionId,
          userId: this.metadata?.userId,
          timestamp: Date.now(),
        },
      }),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to send event: ${response.status} ${text}`);
    }
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
 * Create HTTP/SSE transport.
 *
 * @example
 * ```typescript
 * // Default usage
 * const transport = createHTTPTransport({
 *   baseUrl: 'https://api.example.com',
 * });
 *
 * // With custom headers (API key, Basic auth, etc.)
 * const transportWithApiKey = createHTTPTransport({
 *   baseUrl: 'https://api.example.com',
 *   headers: { 'X-API-Key': 'my-api-key' },
 * });
 *
 * const transportWithBasicAuth = createHTTPTransport({
 *   baseUrl: 'https://api.example.com',
 *   headers: { Authorization: 'Basic ' + btoa('user:pass') },
 * });
 *
 * // With Bearer token (convenience - same as headers: { Authorization: 'Bearer ...' })
 * const transportWithToken = createHTTPTransport({
 *   baseUrl: 'https://api.example.com',
 *   token: 'my-jwt-token',
 * });
 *
 * // With custom fetch (e.g., for credentials)
 * const transportWithCredentials = createHTTPTransport({
 *   baseUrl: 'https://api.example.com',
 *   fetch: (url, init) => fetch(url, { ...init, credentials: 'include' }),
 * });
 *
 * // With cookie-based auth for SSE + POST
 * const transportWithCookies = createHTTPTransport({
 *   baseUrl: 'https://api.example.com',
 *   withCredentials: true,
 * });
 *
 * // If you must pass auth token to SSE via query params
 * const transportWithQueryToken = createHTTPTransport({
 *   baseUrl: 'https://api.example.com',
 *   token: 'my-jwt-token',
 *   authTokenInQuery: true,
 * });
 *
 * // Node.js with polyfills
 * import EventSource from 'eventsource';
 *
 * const nodeTransport = createHTTPTransport({
 *   baseUrl: 'https://api.example.com',
 *   EventSource,
 * });
 * ```
 */
export function createHTTPTransport(config: HTTPTransportConfig): Transport {
  return new HTTPTransport(config);
}