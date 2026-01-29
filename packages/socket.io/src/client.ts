/**
 * Socket.IO Client Transport
 *
 * Thin wrapper - let Socket.IO handle what it's good at.
 *
 * @module @tentickle/socket.io/client
 */

import type { ChannelEvent, ConnectionMetadata } from "@tentickle/shared";
import type { ConnectionState, SocketIOClientConfig, ClientSocket } from "./types.js";
import { CHANNEL_EVENT, JOIN_SESSION } from "./types.js";

export type { SocketIOClientConfig, ClientSocket };
export { CHANNEL_EVENT, JOIN_SESSION };

/**
 * Transport interface (from @tentickle/client).
 */
export interface Transport {
  readonly name: string;
  readonly state: ConnectionState;
  connect(sessionId: string, metadata?: ConnectionMetadata): Promise<void>;
  disconnect(): Promise<void>;
  send(event: ChannelEvent): Promise<void>;
  onReceive(handler: (event: ChannelEvent) => void): () => void;
  onStateChange(handler: (state: ConnectionState) => void): () => void;
}

/**
 * Socket.IO client transport.
 *
 * @example
 * ```typescript
 * import { io } from 'socket.io-client';
 * import { createClient } from '@tentickle/client';
 * import { createSocketIOTransport } from '@tentickle/socket.io/client';
 *
 * // You configure Socket.IO however you want
 * const socket = io('https://api.example.com', {
 *   auth: { token: 'my-jwt' },
 *   transports: ['websocket'],
 *   reconnection: true,
 * });
 *
 * // We just wrap it
 * const transport = createSocketIOTransport({ socket });
 * const client = createClient({ baseUrl: 'https://api.example.com' }, transport);
 * ```
 */
export function createSocketIOTransport(config: SocketIOClientConfig): Transport {
  const { socket } = config;

  let currentState: ConnectionState = socket.connected ? "connected" : "disconnected";
  const stateHandlers = new Set<(state: ConnectionState) => void>();
  const receiveHandlers = new Set<(event: ChannelEvent) => void>();

  const setState = (state: ConnectionState) => {
    if (currentState === state) return;
    currentState = state;
    stateHandlers.forEach((h) => h(state));
  };

  // Wire up Socket.IO events once
  socket.on("connect", () => setState("connected"));
  socket.on("disconnect", () => setState("disconnected"));
  socket.on("connect_error", () => setState("error"));
  socket.on(CHANNEL_EVENT, (event: ChannelEvent) => {
    receiveHandlers.forEach((h) => h(event));
  });

  return {
    name: "socket.io",

    get state() {
      return currentState;
    },

    async connect(sessionId, metadata) {
      if (!socket.connected) {
        socket.connect();
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("connect_error", reject);
        });
      }
      socket.emit(JOIN_SESSION, { sessionId, metadata });
    },

    async disconnect() {
      socket.disconnect();
    },

    async send(event) {
      socket.emit(CHANNEL_EVENT, event);
    },

    onReceive(handler) {
      receiveHandlers.add(handler);
      return () => receiveHandlers.delete(handler);
    },

    onStateChange(handler) {
      stateHandlers.add(handler);
      return () => stateHandlers.delete(handler);
    },
  };
}
