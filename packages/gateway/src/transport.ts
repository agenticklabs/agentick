/**
 * Gateway Transport Interface
 *
 * Abstracts the transport layer (WebSocket, HTTP/SSE) from gateway business logic.
 * This allows the same GatewayCore to serve clients via different protocols.
 */

import { validateAuth, type AuthResult } from "@agentick/server";
import type { GatewayMessage, ClientMessage } from "./transport-protocol.js";
import type { AuthConfig, ClientState } from "./types.js";

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

  /** Check if the client is under write pressure (optional) */
  isPressured?(): boolean;
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
 * Base transport configuration (no network requirements).
 */
export interface TransportConfig {
  /** Authentication configuration */
  auth?: AuthConfig;
}

/**
 * Transport configuration for network-bound transports (WS, HTTP).
 */
export interface NetworkTransportConfig extends TransportConfig {
  /** Port to listen on */
  port: number;

  /** Host to bind to */
  host: string;
}

/** Transport type identifier */
export type TransportType = "websocket" | "http" | "sse" | "local";

/**
 * Transport interface - abstracts WebSocket vs HTTP/SSE.
 */
export interface Transport {
  /** Transport type identifier */
  readonly type: TransportType;

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
  /** Transport type - must be set by subclass */
  abstract readonly type: TransportType;

  protected clients = new Map<string, TransportClient>();
  protected handlers: Partial<TransportEvents> = {};
  protected config: TransportConfig;
  protected clientIdCounter = 0;

  constructor(config: TransportConfig = {}) {
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

  get clientCount(): number {
    return this.clients.size;
  }

  protected generateClientId(): string {
    return `client-${++this.clientIdCounter}`;
  }

  protected validateAuth(token?: string): Promise<AuthResult> {
    return validateAuth(token, this.config.auth);
  }
}
