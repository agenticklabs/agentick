/**
 * Socket.IO Server Adapter
 *
 * Thin wrapper - let Socket.IO handle what it's good at.
 *
 * @module @tentickle/socket.io/server
 */

import type { ChannelEvent } from "@tentickle/shared";
import type {
  SocketIOServerConfig,
  Server,
  Namespace,
  ServerSocket,
  JoinPayload,
} from "./types.js";
import { CHANNEL_EVENT, JOIN_SESSION } from "./types.js";

export type { SocketIOServerConfig, Server, Namespace, ServerSocket };
export { CHANNEL_EVENT, JOIN_SESSION };

/**
 * Server connection (from @tentickle/server).
 */
export interface ServerConnection {
  readonly id: string;
  readonly sessionId: string;
  readonly userId?: string;
  readonly metadata: Record<string, unknown>;
  send(event: ChannelEvent): Promise<void>;
  close(): void;
}

/**
 * Server transport adapter (from @tentickle/server).
 */
export interface ServerTransportAdapter {
  readonly name: string;
  sendToSession(sessionId: string, event: ChannelEvent): Promise<void>;
  destroy(): void;
}

/**
 * Event handler for incoming channel events.
 */
export type EventHandler = (connection: ServerConnection, event: ChannelEvent) => void;

/**
 * Socket.IO server adapter.
 *
 * @example
 * ```typescript
 * import { Server } from 'socket.io';
 * import { createEventBridge, createSessionHandler } from '@tentickle/server';
 * import { createSocketIOAdapter } from '@tentickle/socket.io/server';
 *
 * const io = new Server(httpServer);
 *
 * // Your auth middleware - Socket.IO handles this
 * io.use(async (socket, next) => {
 *   try {
 *     const user = await verifyToken(socket.handshake.auth.token);
 *     socket.data.userId = user.id;
 *     next();
 *   } catch (err) {
 *     next(new Error('Unauthorized'));
 *   }
 * });
 *
 * // Wire up Tentickle
 * const sessionHandler = createSessionHandler({ app: myApp });
 * const eventBridge = createEventBridge({ sessionHandler });
 *
 * const adapter = createSocketIOAdapter({
 *   io,
 *   onEvent: (connection, event) => {
 *     eventBridge.handleEvent(connection.id, event);
 *   },
 * });
 * ```
 */
export function createSocketIOAdapter(
  config: SocketIOServerConfig & { onEvent?: EventHandler },
): ServerTransportAdapter {
  const { io, onEvent } = config;

  // Track connected sockets for cleanup
  const connectedSockets = new Set<ServerSocket>();

  const connectionHandler = (socket: ServerSocket) => {
    connectedSockets.add(socket);

    socket.on(JOIN_SESSION, async (payload: JoinPayload) => {
      const { sessionId, metadata } = payload;

      // Use Socket.IO rooms - that's what they're for
      await socket.join(`session:${sessionId}`);

      // Build connection object on demand
      const connection: ServerConnection = {
        id: socket.id,
        sessionId,
        userId: socket.data.userId as string | undefined,
        metadata: { ...socket.data, ...metadata },
        send: async (event) => { socket.emit(CHANNEL_EVENT, event); },
        close: () => socket.disconnect(true),
      };

      // Store for later event handling
      socket.data.connection = connection;
    });

    socket.on(CHANNEL_EVENT, (event: ChannelEvent) => {
      const connection = socket.data.connection as ServerConnection | undefined;
      if (connection && onEvent) {
        onEvent(connection, event);
      }
    });

    socket.on("disconnect", () => {
      connectedSockets.delete(socket);
      // Socket.IO automatically removes from rooms
    });
  };

  io.on("connection", connectionHandler);

  return {
    name: "socket.io",

    async sendToSession(sessionId, event) {
      io.to(`session:${sessionId}`).emit(CHANNEL_EVENT, event);
    },

    destroy() {
      // Remove connection listener
      io.off("connection", connectionHandler);

      // Disconnect all tracked sockets
      for (const socket of connectedSockets) {
        socket.disconnect(true);
      }
      connectedSockets.clear();
    },
  };
}
