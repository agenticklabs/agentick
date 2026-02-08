/**
 * @agentick/client - Client SDK for Agentick
 *
 * Provides a multiplexed client for connecting to Agentick servers with:
 * - Transport auto-detection (HTTP/SSE for http://, WebSocket for ws://)
 * - Single connection for multiple sessions
 * - Session accessors (cold/hot semantics)
 * - Events tagged with sessionId
 * - Streaming text accumulation
 *
 * @example
 * ```typescript
 * import { createClient } from '@agentick/client';
 *
 * // HTTP/SSE transport (default for http:// URLs)
 * const httpClient = createClient({
 *   baseUrl: 'https://api.example.com',
 * });
 *
 * // WebSocket transport (for ws:// URLs or gateway)
 * const wsClient = createClient({
 *   baseUrl: 'ws://localhost:18789',
 * });
 *
 * // Explicit transport selection
 * const client = createClient({
 *   baseUrl: 'http://localhost:3000',
 *   transport: 'websocket', // Force WebSocket
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
 * const handle = session.send({ messages: [{ role: 'user', content: [...] }] });
 * await handle.result;
 * ```
 *
 * @module @agentick/client
 */

// Main client
export {
  AgentickClient,
  createClient,
  type AgentickClientConfig,
  type SessionAccessor,
} from "./client.js";

// Transport layer
export {
  type ClientTransport,
  type TransportConfig,
  type TransportState,
  type TransportEventData,
  type TransportEventHandler,
} from "./transport.js";

export { SSETransport, createSSETransport, type SSETransportConfig } from "./sse-transport.js";
export { WSTransport, createWSTransport, type WSTransportConfig } from "./ws-transport.js";

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
} from "./types.js";
