/**
 * @tentickle/client - Client SDK for Tentickle
 *
 * Provides a multiplexed client for connecting to Tentickle servers with:
 * - Single SSE connection for multiple sessions
 * - Session accessors (cold/hot semantics)
 * - Events tagged with sessionId
 * - Streaming text accumulation
 *
 * @example
 * ```typescript
 * import { createClient } from '@tentickle/client';
 *
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 * });
 *
 * // Subscribe to a session (hot)
 * const session = client.subscribe('conv-123');
 *
 * // Listen for events
 * session.onEvent((event) => {
 *   if (event.type === 'content_delta') {
 *     console.log(event.delta);
 *   }
 * });
 *
 * // Send a message
 * const handle = session.send({ message: { role: 'user', content: [...] } });
 * await handle.result;
 * ```
 *
 * @module @tentickle/client
 */

// Main client
export {
  TentickleClient,
  createClient,
  type TentickleClientConfig,
  type SessionAccessor,
} from "./client";

// Types - re-exported from types.ts which re-exports from shared
export type {
  // Connection
  ConnectionState,

  // Channels
  ChannelAccessor,
  ChannelEvent,

  // Protocol types (from shared)
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SendInput,
  StreamEvent,
  SessionStreamEvent,

  // Handlers
  GlobalEventHandler,
  SessionEventHandler,
  SessionResultHandler,
  SessionToolConfirmationHandler,
  ConnectionHandler,
  ClientExecutionHandle,

  // Streaming text
  StreamingTextState,
  StreamingTextHandler,
} from "./types";
