/**
 * @tentickle/socket.io - Socket.IO Transport for Tentickle
 *
 * Thin wrappers that let Socket.IO be Socket.IO.
 *
 * @example Client
 * ```typescript
 * import { io } from 'socket.io-client';
 * import { createClient } from '@tentickle/client';
 * import { createSocketIOTransport } from '@tentickle/socket.io/client';
 *
 * const socket = io('https://api.example.com', {
 *   auth: { token: 'my-jwt' },
 * });
 *
 * const transport = createSocketIOTransport({ socket });
 * const client = createClient({ baseUrl: 'https://api.example.com' }, transport);
 * ```
 *
 * @example Server
 * ```typescript
 * import { Server } from 'socket.io';
 * import { createSocketIOAdapter } from '@tentickle/socket.io/server';
 *
 * const io = new Server(httpServer);
 *
 * io.use(async (socket, next) => {
 *   socket.data.userId = await verifyToken(socket.handshake.auth.token);
 *   next();
 * });
 *
 * const adapter = createSocketIOAdapter({
 *   io,
 *   onEvent: (conn, event) => eventBridge.handleEvent(conn.id, event),
 * });
 * ```
 *
 * @module @tentickle/socket.io
 */

// Event names
export { CHANNEL_EVENT, JOIN_SESSION } from "./types.js";

// Types
export type {
  ConnectionState,
  SocketIOClientConfig,
  SocketIOServerConfig,
  ClientSocket,
  Server,
  Namespace,
  ServerSocket,
  JoinPayload,
} from "./types.js";

// Client
export { createSocketIOTransport, type Transport } from "./client.js";

// Server
export {
  createSocketIOAdapter,
  type ServerConnection,
  type ServerTransportAdapter,
  type EventHandler,
} from "./server.js";
