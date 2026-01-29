/**
 * Socket.IO Transport Types
 *
 * Minimal types - let Socket.IO be Socket.IO.
 *
 * @module @tentickle/socket.io/types
 */

import type { ChannelEvent, ConnectionMetadata } from "@tentickle/shared";
import type { Socket as ClientSocket } from "socket.io-client";
import type { Server, Namespace, Socket as ServerSocket } from "socket.io";

// ============================================================================
// Event Names - The only thing we standardize
// ============================================================================

/** Event name for channel events in both directions */
export const CHANNEL_EVENT = "tentickle:event";

/** Event name for joining a session room */
export const JOIN_SESSION = "tentickle:join";

// ============================================================================
// Client Types
// ============================================================================

export type { ClientSocket };

export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/**
 * Client transport configuration.
 */
export interface SocketIOClientConfig {
  /**
   * Socket.IO client socket.
   * You create it, you configure it, we just use it.
   *
   * @example
   * ```typescript
   * import { io } from 'socket.io-client';
   *
   * const socket = io('https://api.example.com', {
   *   auth: { token: 'my-jwt' },
   *   transports: ['websocket'],
   * });
   *
   * const transport = createSocketIOTransport({ socket });
   * ```
   */
  socket: ClientSocket;
}

// ============================================================================
// Server Types
// ============================================================================

export type { Server, Namespace, ServerSocket };

/**
 * Server adapter configuration.
 */
export interface SocketIOServerConfig {
  /**
   * Socket.IO server or namespace.
   * You create it, you configure it (middleware, auth), we just use it.
   *
   * @example
   * ```typescript
   * import { Server } from 'socket.io';
   *
   * const io = new Server(httpServer);
   *
   * // Your auth middleware
   * io.use((socket, next) => {
   *   const token = socket.handshake.auth.token;
   *   // validate...
   *   next();
   * });
   *
   * const adapter = createSocketIOAdapter({ io });
   * ```
   */
  io: Server | Namespace;
}

// ============================================================================
// Payloads
// ============================================================================

export interface JoinPayload {
  sessionId: string;
  metadata?: ConnectionMetadata;
}
