/**
 * Client Types
 *
 * @module @tentickle/client/types
 */

import type {
  ChannelEvent,
  ConnectionMetadata,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  CreateSessionResponse,
  SessionState,
  SessionMessagePayload,
  Message,
  ContentBlock,
} from "@tentickle/shared";
import type { StreamEvent } from "@tentickle/shared";

// Re-export protocol types
export type {
  ChannelEvent,
  ConnectionMetadata,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  CreateSessionResponse,
  SessionState,
  SessionMessagePayload,
  Message,
  ContentBlock,
  StreamEvent,
};

// ============================================================================
// Connection State
// ============================================================================

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

// ============================================================================
// Client Configuration
// ============================================================================

/**
 * Default endpoint paths.
 */
export const DEFAULT_PATHS = {
  /** SSE stream endpoint */
  events: "/events",
  /** Session management endpoint */
  sessions: "/sessions",
} as const;

/**
 * Endpoint path configuration.
 */
export interface PathConfig {
  /** SSE stream endpoint (default: /events) */
  events?: string;
  /** Session management endpoint (default: /sessions) */
  sessions?: string;
}

/**
 * Client configuration.
 */
export interface ClientConfig {
  /** Base URL for the server (e.g., https://api.example.com) */
  baseUrl: string;
  /** Override default endpoint paths */
  paths?: PathConfig;
  /** Authentication token */
  token?: string;
  /** User ID for user-scoped routing */
  userId?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Reconnection delay in ms (default: 1000) */
  reconnectDelay?: number;
  /** Max reconnection attempts (default: 10) */
  maxReconnectAttempts?: number;
}

// ============================================================================
// Transport Interface
// ============================================================================

/**
 * Transport interface for client-server communication.
 *
 * Default implementation uses HTTP/SSE.
 * WebSocket implementation available as alternative.
 */
export interface Transport {
  /** Transport name for debugging */
  readonly name: string;
  /** Current connection state */
  readonly state: ConnectionState;

  /**
   * Connect to the server.
   * For SSE: Opens EventSource connection.
   * For WebSocket: Opens WebSocket connection.
   */
  connect(sessionId: string, metadata?: ConnectionMetadata): Promise<void>;

  /**
   * Disconnect from the server.
   */
  disconnect(): Promise<void>;

  /**
   * Send a channel event to the server.
   * For SSE: HTTP POST request.
   * For WebSocket: WebSocket message.
   */
  send(event: ChannelEvent): Promise<void>;

  /**
   * Register handler for incoming events.
   * Returns unsubscribe function.
   */
  onReceive(handler: (event: ChannelEvent) => void): () => void;

  /**
   * Register handler for connection state changes.
   * Returns unsubscribe function.
   */
  onStateChange(handler: (state: ConnectionState) => void): () => void;
}

/**
 * Transport factory function.
 */
export type TransportFactory = (config: ClientConfig) => Transport;

// ============================================================================
// Channel Accessor
// ============================================================================

/**
 * Channel accessor for pub/sub operations.
 */
export interface ChannelAccessor {
  /** Channel name */
  readonly name: string;

  /**
   * Subscribe to channel events.
   * Returns unsubscribe function.
   */
  subscribe<T = unknown>(handler: (payload: T, event: ChannelEvent<T>) => void): () => void;

  /**
   * Publish event to channel.
   */
  publish<T = unknown>(type: string, payload: T): Promise<void>;

  /**
   * Request/response pattern.
   * Returns the response payload.
   */
  request<TReq = unknown, TRes = unknown>(
    type: string,
    payload: TReq,
    timeoutMs?: number,
  ): Promise<TRes>;
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Handler for stream events.
 */
export type EventHandler = (event: StreamEvent) => void;

/**
 * Handler for execution results.
 */
export type ResultHandler = (result: SessionResultPayload) => void;

/**
 * Handler for tool confirmations.
 */
export type ToolConfirmationHandler = (
  request: ToolConfirmationRequest,
  respond: (response: ToolConfirmationResponse) => void,
) => void;

/**
 * Handler for connection state changes.
 */
export type ConnectionHandler = (state: ConnectionState) => void;

// ============================================================================
// Ergonomic Event Names
// ============================================================================

export type StreamEventType = StreamEvent["type"];

export type StreamEventHandler<T extends StreamEventType> = (
  event: Extract<StreamEvent, { type: T }>,
) => void;

export type ClientEventName =
  | "event"
  | "result"
  | "tool_confirmation"
  | "state"
  | StreamEventType;

export type ClientEventHandlerMap = {
  event: EventHandler;
  result: ResultHandler;
  tool_confirmation: ToolConfirmationHandler;
  state: ConnectionHandler;
} & {
  [K in StreamEventType]: StreamEventHandler<K>;
};

// ============================================================================
// Streaming Text State
// ============================================================================

/**
 * State for accumulated streaming text.
 */
export interface StreamingTextState {
  /** Accumulated text from content_delta events */
  readonly text: string;
  /** Whether streaming is currently active */
  readonly isStreaming: boolean;
}

/**
 * Handler for streaming text state changes.
 */
export type StreamingTextHandler = (state: StreamingTextState) => void;
