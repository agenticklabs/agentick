/**
 * Gateway Transport Interface
 *
 * Abstracts the transport layer (WebSocket, HTTP/SSE) from gateway business logic.
 * This allows the same GatewayCore to serve clients via different protocols.
 */

import type { Message } from "@tentickle/shared";
import type { GatewayMessage, ClientMessage } from "./protocol.js";
import type { AuthConfig, AuthResult, ClientState } from "./types.js";

// ============================================================================
// Transport Interface
// ============================================================================

/**
 * A connected client from the transport's perspective.
 */
export interface TransportClient {
  /** Unique client identifier */
  readonly id: string;

  /** Client state (auth, subscriptions, etc.) */
  readonly state: ClientState;

  /** Send a message to this client */
  send(message: GatewayMessage): void;

  /** Close the connection */
  close(code?: number, reason?: string): void;

  /** Check if connected */
  readonly isConnected: boolean;
}

/**
 * Events emitted by a transport.
 */
export interface TransportEvents {
  /** Client connected (may not be authenticated yet) */
  connection: (client: TransportClient) => void;

  /** Client disconnected */
  disconnect: (clientId: string, reason?: string) => void;

  /** Message received from authenticated client */
  message: (clientId: string, message: ClientMessage) => void;

  /** Transport error */
  error: (error: Error) => void;
}

/**
 * Transport configuration.
 */
export interface TransportConfig {
  /** Port to listen on */
  port: number;

  /** Host to bind to */
  host: string;

  /** Authentication configuration */
  auth?: AuthConfig;

  /**
   * Direct send handler for HTTP transport.
   * Called instead of routing through message handler when streaming response is needed.
   * Accepts full Message object to support multimodal content (images, audio, video, docs).
   */
  onDirectSend?: (
    sessionId: string,
    message: Message,
  ) => AsyncIterable<{ type: string; data?: unknown }>;
}

/**
 * Transport interface - abstracts WebSocket vs HTTP/SSE.
 */
export interface Transport {
  /** Start the transport server */
  start(): Promise<void>;

  /** Stop the transport server */
  stop(): Promise<void>;

  /** Register event handlers */
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void;

  /** Get a client by ID */
  getClient(id: string): TransportClient | undefined;

  /** Get all connected clients */
  getClients(): TransportClient[];

  /** Get authenticated clients */
  getAuthenticatedClients(): TransportClient[];

  /** Broadcast to all authenticated clients */
  broadcast(message: GatewayMessage): void;

  /** Send to clients subscribed to a session */
  sendToSubscribers(sessionId: string, message: GatewayMessage): void;

  /** Number of connected clients */
  readonly clientCount: number;
}

// ============================================================================
// Base Transport Implementation (shared logic)
// ============================================================================

/**
 * Base class with shared transport functionality.
 */
export abstract class BaseTransport implements Transport {
  protected clients = new Map<string, TransportClient>();
  protected handlers: Partial<TransportEvents> = {};
  protected config: TransportConfig;
  protected clientIdCounter = 0;

  constructor(config: TransportConfig) {
    this.config = config;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): void {
    this.handlers[event] = handler;
  }

  getClient(id: string): TransportClient | undefined {
    return this.clients.get(id);
  }

  getClients(): TransportClient[] {
    return Array.from(this.clients.values());
  }

  getAuthenticatedClients(): TransportClient[] {
    return this.getClients().filter((c) => c.state.authenticated);
  }

  broadcast(message: GatewayMessage): void {
    for (const client of this.getAuthenticatedClients()) {
      client.send(message);
    }
  }

  sendToSubscribers(sessionId: string, message: GatewayMessage): void {
    for (const client of this.getAuthenticatedClients()) {
      if (client.state.subscriptions.has(sessionId)) {
        client.send(message);
      }
    }
  }

  get clientCount(): number {
    return this.clients.size;
  }

  protected generateClientId(): string {
    return `client-${++this.clientIdCounter}`;
  }

  protected async validateAuth(token?: string): Promise<AuthResult> {
    const auth = this.config.auth;

    // No auth configured
    if (!auth || auth.type === "none") {
      return { valid: true };
    }

    // Token auth
    if (auth.type === "token") {
      return { valid: token === auth.token };
    }

    // JWT auth
    if (auth.type === "jwt") {
      // TODO: Implement JWT validation
      return { valid: false };
    }

    // Custom auth
    if (auth.type === "custom") {
      return await auth.validate(token ?? "");
    }

    return { valid: false };
  }
}
