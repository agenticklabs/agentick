import type {
  ChannelTransport,
  ChannelEvent,
  ConnectionMetadata,
  ChannelTransportConfig,
} from "../service";

/**
 * Configuration for WebSocketTransport
 */
export interface WebSocketTransportConfig extends ChannelTransportConfig {
  /**
   * WebSocket URL (e.g., 'ws://localhost:3000' or 'wss://api.example.com')
   * Required if socket is not provided.
   */
  url?: string;

  /**
   * Existing WebSocket connection to reuse.
   * If provided, url and other connection options are ignored.
   * The socket should already be connected or will be connected externally.
   */
  socket?: WebSocket | any; // WebSocket in browser, ws.WebSocket in Node.js

  /**
   * Optional headers to include in WebSocket handshake
   */
  headers?: Record<string, string>;

  /**
   * Optional authentication token (sent as query param or header)
   */
  token?: string;

  /**
   * Reconnect delay in milliseconds (default: 1000)
   * Ignored if socket is provided.
   */
  reconnectDelay?: number;

  /**
   * Maximum number of reconnection attempts (default: 10)
   * Ignored if socket is provided.
   */
  maxReconnectAttempts?: number;

  /**
   * WebSocket protocols (default: [])
   */
  protocols?: string[];
}

/**
 * WebSocketTransport implements bidirectional WebSocket communication.
 *
 * Room management is handled server-side. Client:
 * - Sends join-room/leave-room messages
 * - Includes event.target in sends for server to route
 * - Server filters based on room membership
 *
 * Uses native WebSocket API in browser or 'ws' package in Node.js.
 */
export class WebSocketTransport implements ChannelTransport {
  public readonly name = "websocket";

  private config: WebSocketTransportConfig & {
    reconnectDelay: number;
    maxReconnectAttempts: number;
  };
  private currentConnectionId?: string;
  private connectionMetadata?: ConnectionMetadata;
  private ws?: WebSocket | any;
  private receiveHandler?: (event: ChannelEvent) => void;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private isConnected = false;
  private wsModule?: any;
  private channelFilter?: string[];
  private joinedRooms = new Set<string>();

  constructor(config: WebSocketTransportConfig) {
    if (!config.socket && !config.url) {
      throw new Error("WebSocketTransport requires either url or socket");
    }

    this.config = {
      ...config,
      reconnectDelay: config.reconnectDelay || 1000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
    };

    // If existing socket provided, use it directly
    if (config.socket) {
      this.ws = config.socket;
      this.isConnected =
        config.socket.readyState === WebSocket.OPEN || config.socket.readyState === 1;
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
    this.channelFilter = metadata?.channels as string[] | undefined;

    // If socket was provided in constructor, just setup handlers
    if (this.ws && this.isConnected) {
      this.setupSocketHandlers();

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
    this.reconnectAttempts = 0;
    await this.connectWebSocket();
  }

  /**
   * Setup event handlers on existing socket
   */
  private setupSocketHandlers(): void {
    if (!this.ws) return;

    // Remove existing handlers to avoid duplicates
    if (this.ws.removeAllListeners) {
      this.ws.removeAllListeners("message");
      this.ws.removeAllListeners("error");
      this.ws.removeAllListeners("close");
      this.ws.removeAllListeners("open");
    }

    // Setup message handler
    const messageHandler = (data: Buffer | string | MessageEvent) => {
      try {
        let text: string;
        if (data instanceof MessageEvent) {
          text = data.data;
        } else {
          text = typeof data === "string" ? data : data.toString("utf-8");
        }
        const event: ChannelEvent = JSON.parse(text);

        // Apply excludeSender filtering
        const sourceConnectionId = event.metadata?.["sourceConnectionId"] as string | undefined;
        if (event.target?.excludeSender && sourceConnectionId === this.currentConnectionId) {
          return; // Skip - we're the sender
        }

        if (this.receiveHandler) {
          this.receiveHandler(event);
        }
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    if (typeof WebSocket !== "undefined" && this.ws instanceof WebSocket) {
      // Browser WebSocket
      this.ws.onmessage = messageHandler as any;
      this.ws.onerror = (error: Event) => {
        console.error("WebSocket error:", error);
        this.isConnected = false;
      };
      this.ws.onclose = () => {
        this.isConnected = false;
      };
      this.ws.onopen = () => {
        this.isConnected = true;
      };
    } else {
      // Node.js ws.WebSocket
      this.ws.on("message", messageHandler);
      this.ws.on("error", (error: Error) => {
        console.error("WebSocket error:", error);
        this.isConnected = false;
      });
      this.ws.on("close", () => {
        this.isConnected = false;
      });
      this.ws.on("open", () => {
        this.isConnected = true;
      });
    }
  }

  /**
   * Connect to WebSocket
   */
  private async connectWebSocket(): Promise<void> {
    if (!this.currentConnectionId) {
      throw new Error("Connection ID required for connection");
    }

    // Close existing connection if any
    this.disconnect().catch(() => {});

    if (!this.config.url) {
      throw new Error("URL required when socket is not provided");
    }

    try {
      // Build WebSocket URL with connection ID and metadata
      const url = new URL(this.config.url);
      url.searchParams.set("connectionId", this.currentConnectionId);
      if (this.config.token) {
        url.searchParams.set("token", this.config.token);
      }
      if (this.channelFilter && this.channelFilter.length > 0) {
        url.searchParams.set("channels", this.channelFilter.join(","));
      }
      if (this.connectionMetadata?.userId) {
        url.searchParams.set("userId", this.connectionMetadata.userId as string);
      }

      if (typeof WebSocket !== "undefined") {
        // Browser environment
        this.ws = new WebSocket(url.toString(), this.config.protocols);
        this.setupBrowserWebSocket();
      } else {
        // Node.js environment - use 'ws' package
        await this.connectWebSocketNode(url);
      }
    } catch (error) {
      console.error("Failed to connect WebSocket:", error);
      this.handleReconnect();
      throw error;
    }
  }

  private setupBrowserWebSocket(): void {
    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const channelEvent: ChannelEvent = JSON.parse(event.data);

        // Apply excludeSender filtering
        const sourceConnectionId = channelEvent.metadata?.["sourceConnectionId"] as
          | string
          | undefined;
        if (channelEvent.target?.excludeSender && sourceConnectionId === this.currentConnectionId) {
          return;
        }

        if (this.receiveHandler) {
          this.receiveHandler(channelEvent);
        }
      } catch (error) {
        console.error("Failed to parse WebSocket message:", error);
      }
    };

    this.ws.onerror = (error: Event) => {
      console.error("WebSocket error:", error);
      this.isConnected = false;
      this.handleReconnect();
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
        this.handleReconnect();
      }
    };

    this.ws.onopen = () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;

      // Auto-join rooms after connection
      if (this.config.autoJoinRooms && this.connectionMetadata) {
        const autoRooms = this.config.autoJoinRooms(this.connectionMetadata);
        for (const room of autoRooms) {
          if (room) {
            this.join(this.currentConnectionId!, room);
          }
        }
      }
    };
  }

  /**
   * Connect to WebSocket in Node.js environment using 'ws' package
   */
  private async connectWebSocketNode(url: URL): Promise<void> {
    try {
      // Lazy-load 'ws' module
      if (!this.wsModule) {
        try {
          this.wsModule = require("ws");
        } catch (_error) {
          throw new Error(
            "WebSocketTransport requires 'ws' package in Node.js. Install it with: npm install ws",
          );
        }
      }

      const WebSocket = this.wsModule.WebSocket || this.wsModule;

      this.ws = new WebSocket(url.toString(), {
        headers: this.config.headers,
      });

      this.setupSocketHandlers();

      // Override error/close handlers to include reconnection logic
      const originalOnError = this.ws.listeners("error")[0];
      const originalOnClose = this.ws.listeners("close")[0];

      this.ws.removeAllListeners("error");
      this.ws.removeAllListeners("close");

      this.ws.on("error", (error: Error) => {
        if (originalOnError) originalOnError(error);
        this.handleReconnect();
      });

      this.ws.on("close", () => {
        if (originalOnClose) originalOnClose();
        if (this.reconnectAttempts < this.config.maxReconnectAttempts) {
          this.handleReconnect();
        }
      });

      this.ws.on("open", () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;

        // Auto-join rooms
        if (this.config.autoJoinRooms && this.connectionMetadata) {
          const autoRooms = this.config.autoJoinRooms(this.connectionMetadata);
          for (const room of autoRooms) {
            if (room) {
              this.join(this.currentConnectionId!, room);
            }
          }
        }
      });

      // Wait for connection to open
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("WebSocket connection timeout"));
        }, 10000);

        this.ws!.on("open", () => {
          clearTimeout(timeout);
          resolve();
        });

        this.ws!.on("error", (error: Error) => {
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
   * Handle reconnection logic
   */
  private handleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) {
      console.error("Max reconnection attempts reached");
      return;
    }

    this.reconnectAttempts++;
    const delay = this.config.reconnectDelay * this.reconnectAttempts;

    this.reconnectTimer = setTimeout(() => {
      if (this.currentConnectionId) {
        this.connectWebSocket().catch((error) => {
          console.error("Reconnection failed:", error);
        });
      }
    }, delay);
  }

  /**
   * Join a room (sends message to server).
   */
  async join(connectionId: string, room: string): Promise<void> {
    if (this.ws && this.isConnected) {
      const message = JSON.stringify({
        type: "join-room",
        room,
        connectionId: this.currentConnectionId,
      });
      this.ws.send(message);
      this.joinedRooms.add(room);
      console.log(`WebSocket: joined room ${room}`);
    }
  }

  /**
   * Leave a room (sends message to server).
   */
  async leave(connectionId: string, room: string): Promise<void> {
    if (this.ws && this.isConnected) {
      const message = JSON.stringify({
        type: "leave-room",
        room,
        connectionId: this.currentConnectionId,
      });
      this.ws.send(message);
      this.joinedRooms.delete(room);
      console.log(`WebSocket: left room ${room}`);
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
   */
  async disconnect(_connectionId?: string): Promise<void> {
    this.isConnected = false;
    this.joinedRooms.clear();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.ws) {
      // Only close if we created the socket ourselves
      const wasProvidedExternally = !this.config.url;

      if (!wasProvidedExternally) {
        if (this.ws.close) {
          this.ws.close();
        } else if (this.ws.terminate) {
          this.ws.terminate();
        }
      }

      if (wasProvidedExternally) {
        if (this.ws.removeAllListeners) {
          this.ws.removeAllListeners();
        }
      } else {
        this.ws = undefined;
      }
    }

    this.currentConnectionId = undefined;
    this.connectionMetadata = undefined;
  }

  /**
   * Send an event through WebSocket.
   * Server handles room routing based on event.target.
   */
  async send(event: ChannelEvent): Promise<void> {
    if (!this.currentConnectionId) {
      throw new Error("Not connected. Call connect() first.");
    }

    if (!this.isConnected || !this.ws) {
      throw new Error("WebSocket not connected");
    }

    try {
      // Add sourceConnectionId for excludeSender support
      const message = JSON.stringify({
        ...event,
        metadata: {
          ...event.metadata,
          sourceConnectionId: this.currentConnectionId,
        },
      });

      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === 1) {
        this.ws.send(message);
      } else {
        throw new Error("WebSocket is not open");
      }
    } catch (error) {
      console.error("Failed to send event:", error);
      throw error;
    }
  }

  /**
   * Close all connections.
   */
  closeAll(): void {
    this.disconnect();
  }

  /**
   * Register handler for events received from transport
   */
  onReceive(handler: (event: ChannelEvent) => void): void {
    this.receiveHandler = handler;
  }
}
