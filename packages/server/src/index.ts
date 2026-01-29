/**
 * @tentickle/server - Server SDK for Tentickle
 *
 * Provides server-side components for running Tentickle applications:
 * - Session handling and lifecycle management
 * - Event routing between clients and sessions
 * - SSE utilities for streaming
 *
 * This package provides hooks and handlers that your web framework
 * routes can call into. It does NOT define routes - that's your
 * application's responsibility.
 *
 * @example
 * ```typescript
 * import {
 *   createSessionHandler,
 *   createEventBridge,
 *   createSSEWriter,
 *   setSSEHeaders,
 *   InMemorySessionStore,
 * } from '@tentickle/server';
 *
 * // Create session handler
 * const sessionHandler = createSessionHandler({
 *   app: myApp,
 *   store: new InMemorySessionStore(),
 * });
 *
 * // Create event bridge for real-time communication
 * const eventBridge = createEventBridge({
 *   sessionHandler,
 * });
 *
 * // Define your routes (Express example)
 * app.post('/sessions', async (req, res) => {
 *   const { sessionId } = await sessionHandler.create(req.body);
 *   res.json({ sessionId, status: 'created' });
 * });
 *
 * app.get('/sessions/:id/events', (req, res) => {
 *   const { sessionId } = req.params;
 *
 *   setSSEHeaders(res);
 *   const writer = createSSEWriter(res);
 *
 *   eventBridge.registerConnection({
 *     id: generateId(),
 *     sessionId,
 *     userId: req.query.userId,
 *     metadata: {},
 *     send: async (event) => writer.writeEvent(event),
 *     close: () => writer.close(),
 *   });
 * });
 *
 * app.post('/sessions/:id/events', async (req, res) => {
 *   await eventBridge.handleEvent(req.body.connectionId, req.body);
 *   res.json({ success: true });
 * });
 * ```
 *
 * @module @tentickle/server
 */

// Session handling
export {
  SessionHandlerImpl,
  createSessionHandler,
  SessionNotFoundError,
  SessionClosedError,
} from "./session-handler.js";

// Session store
export { InMemorySessionStore } from "./session-store.js";

// Event bridge
export { EventBridgeImpl, createEventBridge } from "./event-bridge.js";

// SSE utilities
export { createSSEWriter, streamToSSE, setSSEHeaders } from "./sse.js";

// Types - re-exported from types.ts
export type {
  // Protocol types (from shared)
  ChannelEvent,
  ChannelEventMetadata,
  ConnectionMetadata,
  SessionResultPayload,
  ToolConfirmationRequest,
  ToolConfirmationResponse,
  SessionState,
  CreateSessionResponse,
  ProtocolError,

  // Server connection
  ServerConnection,

  // Session store
  SessionStore,

  // Session handler
  SessionHandler,
  SessionHandlerConfig,
  CreateSessionInput,
  SendInput,
  SessionStateInfo,

  // Transport adapter
  ServerTransportAdapter,

  // Event bridge
  EventBridge,
  EventBridgeConfig,

  // SSE
  SSEWriter,
  SSEWriterOptions,
} from "./types.js";

// Re-export constants
export { FrameworkChannels, ErrorCodes } from "./types.js";
