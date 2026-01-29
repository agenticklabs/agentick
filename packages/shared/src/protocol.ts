/**
 * Wire Protocol Types - Shared between client and server
 *
 * These types define the contract for client-server communication.
 * Both @tentickle/client and @tentickle/server MUST use these types.
 *
 * @module @tentickle/shared/protocol
 */

// ============================================================================
// Channel Event - The fundamental unit of communication
// ============================================================================

/**
 * Channel event structure for all client-server communication.
 */
export interface ChannelEvent<T = unknown> {
  /** Channel name (e.g., 'session:events', 'todo_list') */
  channel: string;
  /** Event type within the channel */
  type: string;
  /** Event payload */
  payload: T;
  /** Request/response correlation ID */
  id?: string;
  /** Event metadata */
  metadata?: ChannelEventMetadata;
}

/**
 * Channel event metadata.
 */
export interface ChannelEventMetadata {
  /** Timestamp when event was created */
  timestamp?: number;
  /** Source connection ID (for sender exclusion) */
  connectionId?: string;
  /** Session ID */
  sessionId?: string;
  /** User ID */
  userId?: string;
  /** Additional metadata */
  [key: string]: unknown;
}

// ============================================================================
// Framework Channels - Built-in session communication
// ============================================================================

/**
 * Framework channel names.
 */
export const FrameworkChannels = {
  /** Client sends messages to session */
  MESSAGES: "session:messages",
  /** Server streams execution events to client */
  EVENTS: "session:events",
  /** Client sends control commands (tick, abort) */
  CONTROL: "session:control",
  /** Server sends final execution result */
  RESULT: "session:result",
  /** Bidirectional tool confirmation flow */
  TOOL_CONFIRMATION: "session:tool_confirmation",
} as const;

export type FrameworkChannel = (typeof FrameworkChannels)[keyof typeof FrameworkChannels];

// ============================================================================
// Framework Channel Payloads
// ============================================================================

import type { Message } from "./messages";

/**
 * Payload for session:messages channel.
 *
 * Mirrors Session.send() input for thin channel semantics.
 */
export interface SessionMessagePayload {
  /** Single message to send */
  message?: Message;
  /** Batch of messages to send */
  messages?: Message[];
  /** Optional props for the execution */
  props?: Record<string, unknown>;
  /** Optional metadata applied to messages */
  metadata?: Record<string, unknown>;
}

/**
 * Payload for session:control channel - tick command.
 */
export interface SessionTickPayload {
  props?: Record<string, unknown>;
}

/**
 * Payload for session:control channel - abort command.
 */
export interface SessionAbortPayload {
  reason?: string;
}

/**
 * Payload for session:result channel.
 */
export interface SessionResultPayload {
  /** Text response from model */
  response: string;
  /** Structured outputs from OUTPUT tools */
  outputs: Record<string, unknown>;
  /** Token usage statistics */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  /** Stop reason */
  stopReason?: string;
}

/**
 * Payload for session:tool_confirmation channel - request.
 */
export interface ToolConfirmationRequest {
  toolUseId: string;
  name: string;
  arguments: Record<string, unknown>;
  message?: string;
}

/**
 * Payload for session:tool_confirmation channel - response.
 */
export interface ToolConfirmationResponse {
  approved: boolean;
  reason?: string;
  modifiedArguments?: Record<string, unknown>;
}

// ============================================================================
// Connection Types
// ============================================================================

/**
 * Connection metadata for routing.
 */
export interface ConnectionMetadata {
  /** User ID for user-scoped routing */
  userId?: string;
  /** Session ID for session-scoped routing */
  sessionId?: string;
  /** Tenant ID for multi-tenant routing */
  tenantId?: string;
  /** Additional metadata */
  [key: string]: unknown;
}

// ============================================================================
// Session Types
// ============================================================================

/**
 * Session state returned by server.
 */
export interface SessionState {
  sessionId: string;
  status: "idle" | "running" | "closed";
  tick: number;
  queuedMessages: number;
}

/**
 * Input for creating a session.
 */
export interface CreateSessionRequest {
  /** Optional session ID (generated if not provided) */
  sessionId?: string;
  /** Initial props */
  props?: Record<string, unknown>;
}

/**
 * Response from session creation.
 */
export interface CreateSessionResponse {
  sessionId: string;
  status: string;
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * Protocol error structure.
 */
export interface ProtocolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Error codes.
 */
export const ErrorCodes = {
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SESSION_CLOSED: "SESSION_CLOSED",
  NOT_CONNECTED: "NOT_CONNECTED",
  TIMEOUT: "TIMEOUT",
  INVALID_MESSAGE: "INVALID_MESSAGE",
  EXECUTION_ERROR: "EXECUTION_ERROR",
  SERIALIZATION_ERROR: "SERIALIZATION_ERROR",
} as const;
