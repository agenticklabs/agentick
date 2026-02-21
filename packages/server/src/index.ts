/**
 * @agentick/server - Server SDK for Agentick
 *
 * Provides server-side components for running Agentick applications:
 * - SSE streaming utilities
 * - SSE utilities for streaming
 *
 * This package provides hooks and handlers that your web framework
 * routes can call into. It does NOT define routes - that's your
 * application's responsibility.
 *
 * @example
 * ```typescript
 * import { createSSEWriter, setSSEHeaders } from '@agentick/server';
 *
 * app.get('/events', (req, res) => {
 *   setSSEHeaders(res);
 *   const writer = createSSEWriter(res);
 *   writer.writeEvent({ channel: 'session:events', type: 'ping', payload: {} });
 * });
 * ```
 *
 * @module @agentick/server
 */

// SSE utilities
export { createSSEWriter, streamToSSE, setSSEHeaders } from "./sse.js";

// Auth utilities
export { extractToken, validateAuth, type AuthConfig, type AuthResult } from "./auth.js";

// Types - re-exported from types.ts
export type {
  // Protocol types (from shared)
  ChannelEvent,
  ChannelEventMetadata,
  ConnectionMetadata,
  ProtocolError,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionState,
  CreateSessionResponse,

  // SSE
  SSEWriter,
  SSEWriterOptions,
} from "./types.js";

// Re-export constants
export { FrameworkChannels, ErrorCodes } from "./types.js";
