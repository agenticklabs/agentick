/**
 * @tentickle/client - Client SDK for Tentickle
 *
 * Provides a client for connecting to Tentickle servers with:
 * - Pluggable transport (HTTP/SSE default, WebSocket optional)
 * - Framework channel methods (send, tick, abort, onEvent)
 * - Generic channel access (subscribe, publish, request)
 * - Session lifecycle management
 *
 * @example
 * ```typescript
 * import { createClient } from '@tentickle/client';
 *
 * const client = createClient({
 *   baseUrl: 'https://api.example.com',
 *   userId: 'user_123',
 * });
 *
 * // Create a session
 * const { sessionId } = await client.createSession();
 *
 * // Connect to the session
 * await client.connect(sessionId);
 *
 * // Send messages and listen for events
 * client.send('Hello!');
 * client.onEvent((event) => {
 *   if (event.type === 'content_delta') {
 *     console.log(event.delta);
 *   }
 * });
 *
 * // Trigger execution
 * client.tick();
 * ```
 *
 * @module @tentickle/client
 */

// Main client
export { TentickleClient, createClient, type CreateSessionOptions } from "./client.js";

// Types - re-exported from types.ts which re-exports from shared
export type {
  // Client configuration
  ClientConfig,
  PathConfig,
  DEFAULT_PATHS,

  // Connection
  ConnectionState,
  ConnectionMetadata,

  // Transport
  Transport,
  TransportFactory,

  // Channels
  ChannelAccessor,
  ChannelEvent,

  // Protocol types (from shared)
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  CreateSessionResponse,
  SessionState,
  StreamEvent,

  // Handlers
  EventHandler,
  ResultHandler,
  ToolConfirmationHandler,
  ConnectionHandler,

  // Streaming text
  StreamingTextState,
  StreamingTextHandler,
} from "./types.js";

// Transports
export {
  // HTTP/SSE transport (default)
  HTTPTransport,
  createHTTPTransport,
  type HTTPTransportConfig,
  type FetchFn,
  type EventSourceConstructor,

  // WebSocket transport (alternative)
  WebSocketTransport,
  createWebSocketTransport,
  type WebSocketConfig,
  type WebSocketConstructor,
} from "./transports/index.js";
