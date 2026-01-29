import type {
  ChannelTransport,
  ChannelEvent,
  ConnectionMetadata,
  ChannelTransportConfig,
} from "../service";

/**
 * Configuration for SocketIOTransport
 */
export interface SocketIOTransportConfig extends ChannelTransportConfig {
  /**
   * Socket.io server URL (e.g., 'http://localhost:3000')
   * Required if socket is not provided.
   */
  url?: string;

  /**
   * Existing Socket.io client socket to reuse.
   * If provided, url and other connection options are ignored.
   * The socket should already be connected or will be connected externally.
   */
  socket?: any; // Socket.io client socket

  /**
   * Optional authentication token
   */
  token?: string;

  /**
   * Optional Socket.io options
   * Ignored if socket is provided.
   */
  options?: {
    transports?: string[];
    reconnection?: boolean;
    reconnectionDelay?: number;
    reconnectionAttempts?: number;
    [key: string]: any;
  };
}

/**
 * SocketIOTransport implements bidirectional communication via Socket.io.
 *
 * Leverages Socket.io's native room support:
 * - join/leave map directly to socket.join()/socket.leave()
 * - Events with target.rooms are sent via io.to(room).emit()
 * - excludeSender uses socket.broadcast.to(room).emit()
 *
 * Requires 'socket.io-client' package.
 */
export class SocketIOTransport implements ChannelTransport {
  public readonly name = "socketio";

  private config: SocketIOTransportConfig;
  private currentConnectionId?: string;
  private connectionMetadata?: ConnectionMetadata;
  private socket?: any; // Socket.io client
  private receiveHandler?: (event: ChannelEvent) => void;
  private isConnected = false;
  private joinedRooms = new Set<string>();

  constructor(config: SocketIOTransportConfig) {
    if (!config.socket && !config.url) {
      throw new Error("SocketIOTransport requires either url or socket");
    }
    this.config = config;

    // If existing socket provided, use it directly
    if (config.socket) {
      this.socket = config.socket;
      this.isConnected = config.socket.connected || false;
      this.setupSocketHandlers();
    }
  }

  /**
   * Connect to the transport with optional metadata.
   */
  async connect(
    connectionId: string,
    metadata?: ConnectionMetadata & { channels?: string[] },
  ): Promise<void> {
    this.currentConnectionId = connectionId;
    this.connectionMetadata = metadata;

    // If socket was provided in constructor, just setup handlers
    if (this.socket && this.isConnected) {
      this.setupSocketHandlers();
      // Join session room if not already joined
      if (this.socket.connected) {
        this.socket.emit("join-session", connectionId);
      }

      // Auto-join rooms based on metadata
      if (this.config.autoJoinRooms && metadata) {
        const autoRooms = this.config.autoJoinRooms(metadata);
        for (const room of autoRooms) {
          if (room) {
            await this.join(connectionId, room);
          }
        }
      }
      return;
    }

    // Otherwise, create new connection
    await this.connectSocket();
  }

  /**
   * Setup event handlers on existing socket
   */
  private setupSocketHandlers(): void {
    if (!this.socket) return;

    // Remove existing handlers to avoid duplicates
    this.socket.removeAllListeners("connect");
    this.socket.removeAllListeners("disconnect");
    this.socket.removeAllListeners("error");
    this.socket.removeAllListeners("channel-event");

    this.socket.on("connect", () => {
      this.isConnected = true;
      // Join session room
      if (this.currentConnectionId) {
        this.socket.emit("join-session", this.currentConnectionId);
      }
    });

    this.socket.on("disconnect", () => {
      this.isConnected = false;
    });

    this.socket.on("error", (error: Error) => {
      console.error("Socket.io error:", error);
      this.isConnected = false;
    });

    // Listen for channel events
    this.socket.on("channel-event", (event: ChannelEvent) => {
      // Apply excludeSender filtering if needed
      const sourceConnectionId = event.metadata?.["sourceConnectionId"] as string | undefined;
      if (event.target?.excludeSender && sourceConnectionId === this.currentConnectionId) {
        return; // Skip - we're the sender
      }

      if (this.receiveHandler) {
        this.receiveHandler(event);
      }
    });
  }

  /**
   * Connect to Socket.io server
   */
  private async connectSocket(): Promise<void> {
    if (!this.currentConnectionId) {
      throw new Error("Connection ID required for connection");
    }

    // Close existing connection if any
    this.disconnect().catch(() => {});

    try {
      // Lazy-load socket.io-client
      let io: any;
      try {
        io = require("socket.io-client");
      } catch (_error) {
        throw new Error(
          "SocketIOTransport requires 'socket.io-client' package. Install it with: npm install socket.io-client",
        );
      }

      const options = {
        ...this.config.options,
        auth: {
          token: this.config.token,
          connectionId: this.currentConnectionId,
          ...this.connectionMetadata,
        },
      };

      this.socket = io(this.config.url, options);
      this.setupSocketHandlers();

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("Socket.io connection timeout"));
        }, 10000);

        this.socket!.on("connect", () => {
          clearTimeout(timeout);
          this.isConnected = true;

          // Auto-join rooms after connection
          if (this.config.autoJoinRooms && this.connectionMetadata) {
            const autoRooms = this.config.autoJoinRooms(this.connectionMetadata);
            for (const room of autoRooms) {
              if (room) {
                this.join(this.currentConnectionId!, room);
              }
            }
          }

          resolve();
        });

        this.socket!.on("connect_error", (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        });
      });
    } catch (error) {
      this.isConnected = false;
      throw error;
    }
  }

  /**
   * Join a room (uses Socket.io's native room support).
   */
  async join(connectionId: string, room: string): Promise<void> {
    if (this.socket && this.isConnected) {
      this.socket.emit("join-room", room);
      this.joinedRooms.add(room);
      console.log(`Socket.io: joined room ${room}`);
    }
  }

  /**
   * Leave a room.
   */
  async leave(connectionId: string, room: string): Promise<void> {
    if (this.socket && this.isConnected) {
      this.socket.emit("leave-room", room);
      this.joinedRooms.delete(room);
      console.log(`Socket.io: left room ${room}`);
    }
  }

  /**
   * Get rooms this connection has joined.
   */
  getConnectionRooms(_connectionId: string): string[] {
    return Array.from(this.joinedRooms);
  }

  /**
   * Disconnect from transport.
   * If socket was provided in constructor, only removes handlers (doesn't disconnect socket).
   */
  async disconnect(_connectionId?: string): Promise<void> {
    this.isConnected = false;
    this.joinedRooms.clear();

    if (this.socket) {
      // Only disconnect if we created the socket ourselves
      // If socket was provided externally, don't disconnect it
      const wasProvidedExternally = !this.config.url;

      if (!wasProvidedExternally) {
        this.socket.disconnect();
      } else {
        // Remove handlers but keep socket reference - caller owns it
        this.socket.removeAllListeners();
      }

      if (!wasProvidedExternally) {
        this.socket = undefined;
      }
    }

    this.currentConnectionId = undefined;
    this.connectionMetadata = undefined;
  }

  /**
   * Close all connections.
   */
  closeAll(): void {
    this.disconnect();
  }

  /**
   * Send an event through Socket.io.
   * Supports room targeting via event.target.rooms.
   */
  async send(event: ChannelEvent): Promise<void> {
    if (!this.currentConnectionId) {
      throw new Error("Not connected. Call connect() first.");
    }

    if (!this.isConnected || !this.socket) {
      throw new Error("Socket.io not connected");
    }

    try {
      // Add sourceConnectionId for excludeSender support
      const enrichedEvent = {
        ...event,
        metadata: {
          ...event.metadata,
          sourceConnectionId: this.currentConnectionId,
        },
      };

      // Let server handle room routing based on event.target
      this.socket.emit("channel-event", enrichedEvent);
    } catch (error) {
      console.error("Failed to send event:", error);
      throw error;
    }
  }

  /**
   * Register handler for events received from transport
   */
  onReceive(handler: (event: ChannelEvent) => void): void {
    this.receiveHandler = handler;
  }
}
