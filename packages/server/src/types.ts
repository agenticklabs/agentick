/**
 * Server Types for @agentick/server
 *
 * @module @agentick/server/types
 */

import type { ChannelEvent } from "@agentick/shared";

// Re-export protocol types from shared for convenience
export type {
  ChannelEvent,
  ChannelEventMetadata,
  ConnectionMetadata,
  ProtocolError,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionState,
  CreateSessionResponse,
} from "@agentick/shared";
export { FrameworkChannels, ErrorCodes } from "@agentick/shared";

// ============================================================================
// SSE Types
// ============================================================================

/**
 * SSE writer interface.
 */
export interface SSEWriter {
  /** Write an SSE event payload */
  writeEvent(event: unknown): void;
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
