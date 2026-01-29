/**
 * Server Types for @tentickle/server
 *
 * @module @tentickle/server/types
 */

import type { Session, App, SendResult } from "@tentickle/core/app";
import type { Message, StreamEvent } from "@tentickle/shared";

// Re-export protocol types from shared for convenience
export type {
  ChannelEvent,
  ChannelEventMetadata,
  ConnectionMetadata,
  SessionMessagePayload,
  SessionTickPayload,
  SessionAbortPayload,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionState,
  CreateSessionRequest,
  CreateSessionResponse,
  ProtocolError,
} from "@tentickle/shared";

export { FrameworkChannels, ErrorCodes } from "@tentickle/shared";

// ============================================================================
// Connection Types
// ============================================================================

/**
 * Server-side connection representation.
 */
export interface ServerConnection {
  /** Connection ID */
  readonly id: string;
  /** Session ID this connection is associated with */
  readonly sessionId: string;
  /** User ID if provided */
  readonly userId?: string;
  /** Additional metadata */
  readonly metadata: Record<string, unknown>;
  /** Send event to this connection */
  send(event: { channel: string; type: string; payload: unknown; id?: string }): Promise<void>;
  /** Close this connection */
  close(): void;
}

// ============================================================================
// Session Store
// ============================================================================

/**
 * Session store protocol - implement for persistence.
 */
export interface SessionStore {
  /** Get session by ID */
  get(id: string): Session | undefined;
  /** Store session */
  set(id: string, session: Session): void;
  /** Delete session */
  delete(id: string): boolean;
  /** List all session IDs */
  list(): string[];
  /** Check if session exists */
  has(id: string): boolean;
}

// ============================================================================
// Session Handler
// ============================================================================

/**
 * Session handler configuration.
 */
export interface SessionHandlerConfig {
  /** The Tentickle app */
  app: App;
  /** Session store (optional, defaults to in-memory) */
  store?: SessionStore;
  /** Default session options */
  defaultSessionOptions?: Record<string, unknown>;
}

/**
 * Input for creating a session.
 */
export interface CreateSessionInput {
  /** Optional session ID (generated if not provided) */
  sessionId?: string;
  /** Initial props */
  props?: Record<string, unknown>;
  /** Initial messages */
  messages?: Message[];
}

/**
 * Input for sending to a session.
 */
export interface SendInput {
  /** Props for the execution */
  props?: Record<string, unknown>;
  /** Single message to send */
  message?: Message;
  /** Messages to send */
  messages?: Message[];
  /** Optional metadata applied to messages */
  metadata?: Record<string, unknown>;
}

/**
 * Session handler interface.
 *
 * The session handler provides the core session operations.
 * It does NOT define routes - your web framework defines routes
 * that call these methods.
 */
export interface SessionHandler {
  /** Create a new session */
  create(input: CreateSessionInput): Promise<{ sessionId: string; session: Session }>;
  /** Send to a session and wait for result */
  send(sessionId: string, input: SendInput): Promise<SendResult>;
  /** Stream from a session */
  stream(sessionId: string, input: SendInput): AsyncIterable<StreamEvent>;
  /** Get session by ID */
  getSession(sessionId: string): Session | undefined;
  /** Get session state */
  getState(sessionId: string): SessionStateInfo | undefined;
  /** Delete session */
  delete(sessionId: string): boolean;
  /** List all session IDs */
  list(): string[];
}

/**
 * Session state information.
 */
export interface SessionStateInfo {
  /** Session ID */
  sessionId: string;
  /** Current status */
  status: string;
  /** Current tick number */
  tick: number;
  /** Number of messages in queue */
  queuedMessages: number;
}

// ============================================================================
// Transport Adapter (Server-Side)
// ============================================================================

/**
 * Server transport adapter interface.
 *
 * Implement this to support different transport mechanisms.
 * The adapter handles the low-level connection management.
 */
export interface ServerTransportAdapter {
  /** Adapter name for debugging */
  readonly name: string;

  /**
   * Register a connection with the adapter.
   * Called when a new client connects.
   */
  registerConnection(connection: ServerConnection): void;

  /**
   * Unregister a connection.
   * Called when a client disconnects.
   */
  unregisterConnection(connectionId: string): void;

  /**
   * Send an event to a specific connection.
   */
  sendToConnection(connectionId: string, event: {
    channel: string;
    type: string;
    payload: unknown;
    id?: string;
  }): Promise<void>;

  /**
   * Send an event to all connections for a session.
   */
  sendToSession(sessionId: string, event: {
    channel: string;
    type: string;
    payload: unknown;
    id?: string;
  }): Promise<void>;

  /**
   * Get all connections for a session.
   */
  getSessionConnections(sessionId: string): ServerConnection[];

  /**
   * Cleanup all connections.
   */
  destroy(): void;
}

// ============================================================================
// Event Bridge
// ============================================================================

/**
 * Event bridge configuration.
 *
 * The event bridge routes messages between transport and sessions.
 */
export interface EventBridgeConfig {
  /** Session handler */
  sessionHandler: SessionHandler;
  /** Transport adapter */
  transport?: ServerTransportAdapter;
  /**
   * Optional validation hook for inbound events.
   * Throw to reject the event.
   */
  validateEvent?: (connection: ServerConnection, event: {
    channel: string;
    type: string;
    payload: unknown;
    id?: string;
  }) => void | Promise<void>;
}

/**
 * Event bridge interface.
 *
 * Routes incoming events from clients to the appropriate handlers,
 * and forwards session events back to clients.
 *
 * Two modes:
 * - Without transport: manages connections internally, handleEvent takes connectionId
 * - With transport: delegates to adapter, handleEvent takes ServerConnection directly
 */
export interface EventBridge {
  /**
   * Handle an incoming event.
   *
   * @param connectionOrId - Either a connection ID (HTTP/SSE mode) or ServerConnection (adapter mode)
   * @param event - The channel event to handle
   */
  handleEvent(
    connectionOrId: string | ServerConnection,
    event: {
      channel: string;
      type: string;
      payload: unknown;
      id?: string;
    },
  ): Promise<void>;

  /**
   * Register a connection.
   * Only needed when NOT using a transport adapter.
   */
  registerConnection(connection: ServerConnection): void;

  /**
   * Unregister a connection.
   * Only needed when NOT using a transport adapter.
   */
  unregisterConnection(connectionId: string): void;

  /** Cleanup */
  destroy(): void;
}

// ============================================================================
// SSE Types
// ============================================================================

/**
 * SSE writer interface.
 */
export interface SSEWriter {
  /** Write a channel event */
  writeEvent(event: { channel: string; type: string; payload: unknown; id?: string }): void;
  /** Write a comment (keepalive) */
  writeComment(comment: string): void;
  /** Close the stream */
  close(): void;
  /** Check if closed */
  readonly closed: boolean;
}

/**
 * SSE writer options.
 */
export interface SSEWriterOptions {
  /** Keepalive interval in ms (default: 15000) */
  keepaliveInterval?: number;
  /** Event name for SSE (default: 'message') */
  eventName?: string;
}
