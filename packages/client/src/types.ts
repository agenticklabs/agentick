/**
 * Client Types
 *
 * @module @tentickle/client/types
 */

import type {
  ChannelEvent,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SendInput,
  Message,
  ContentBlock,
} from "@tentickle/shared";
import type { StreamEvent } from "@tentickle/shared";

// Re-export protocol types
export type {
  ChannelEvent,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SendInput,
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
  /** Send endpoint */
  send: "/send",
  /** Subscribe endpoint */
  subscribe: "/subscribe",
  /** Abort endpoint */
  abort: "/abort",
  /** Close endpoint */
  close: "/close",
  /** Tool response endpoint */
  toolResponse: "/tool-response",
  /** Channel endpoint */
  channel: "/channel",
} as const;

/**
 * Endpoint path configuration.
 */
export interface PathConfig {
  /** SSE stream endpoint (default: /events) */
  events?: string;
  /** Send endpoint (default: /send) */
  send?: string;
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
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
}

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
/**
 * Stream event emitted from multiplexed sessions.
 * Always includes the sessionId for routing.
 */
export type SessionStreamEvent = StreamEvent & { sessionId: string };

/**
 * Handler for multiplexed stream events (includes sessionId).
 */
export type GlobalEventHandler = (event: SessionStreamEvent) => void;

/**
 * Handler for session-scoped stream events (no sessionId required).
 */
export type SessionEventHandler = (event: StreamEvent) => void;

/**
 * Handler for execution results.
 */
export type SessionResultHandler = (result: SessionResultPayload) => void;

/**
 * Handler for tool confirmations.
 */
export type SessionToolConfirmationHandler = (
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

export type GlobalStreamEventHandler<T extends StreamEventType> = (
  event: Extract<SessionStreamEvent, { type: T }>,
) => void;

export type ClientEventName = "event" | "state" | StreamEventType;

export type ClientEventHandlerMap = {
  event: GlobalEventHandler;
  state: ConnectionHandler;
} & {
  [K in StreamEventType]: GlobalStreamEventHandler<K>;
};

// ============================================================================
// Client Execution Handle
// ============================================================================

/**
 * Handle for streaming a single execution from the client.
 */
export interface ClientExecutionHandle {
  /** Session ID this execution belongs to */
  readonly sessionId: string;
  /** Execution ID (assigned by server) */
  readonly executionId: string;
  /** Current status */
  readonly status: "running" | "completed" | "aborted" | "error";

  /**
   * Async iterator for events from this execution only.
   */
  [Symbol.asyncIterator](): AsyncIterator<StreamEvent>;

  /**
   * Final result for this execution.
   */
  readonly result: Promise<SessionResultPayload>;

  /**
   * Abort this execution.
   */
  abort(reason?: string): void;

  /**
   * Queue a message during execution.
   */
  queueMessage(message: Message): void;

  /**
   * Submit tool confirmation result.
   */
  submitToolResult(toolUseId: string, result: ToolConfirmationResponse): void;
}

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
