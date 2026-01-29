import type {
  ChannelTransport,
  ChannelEvent,
  ConnectionMetadata,
  ChannelTransportConfig,
} from "../service";

/**
 * Configuration for StreamableHTTPTransport
 */
export interface StreamableHTTPTransportConfig extends ChannelTransportConfig {
  /**
   * Base URL for the HTTP endpoint (e.g., 'https://api.example.com/channels')
   */
  url: string;

  /**
   * Optional headers to include in requests
   */
  headers?: Record<string, string>;

  /**
   * Optional authentication token
   */
  token?: string;

  /**
   * Timeout for HTTP requests in milliseconds (default: 30000)
   */
  timeout?: number;

  /**
   * Reconnect delay in milliseconds (default: 1000)
   */
  reconnectDelay?: number;

  /**
   * Maximum number of reconnection attempts (default: 10)
   */
  maxReconnectAttempts?: number;
}

/**
 * StreamableHTTPTransport implements bidirectional HTTP communication.
 *
 * Architecture:
 * - Client -> Server: HTTP POST requests (with event.target for room routing)
 * - Server -> Client: Server-Sent Events (SSE) stream
 *
 * Room management:
 * - Client sends join-room/leave-room requests
 * - Server tracks room membership
 * - Events with target.rooms are routed by server
 *
 * This follows the MCP Streamable HTTP pattern but adapted for channels.
 */
export class StreamableHTTPTransport implements ChannelTransport {
  public readonly name = "streamable-http";

  private config: StreamableHTTPTransportConfig & {
    headers: Record<string, string>;
    timeout: number;
    reconnectDelay: number;
    maxReconnectAttempts: number;
  };
  private currentConnectionId?: string;
  private connectionMetadata?: ConnectionMetadata;
  private eventSource?: EventSource;
  private receiveHandler?: (event: ChannelEvent) => void;
  private reconnectAttempts = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private isConnected = false;
  private channelFilter?: string[];
  private joinedRooms = new Set<string>();

  constructor(config: StreamableHTTPTransportConfig) {
    this.config = {
      ...config,
      headers: config.headers || {},
      timeout: config.timeout || 30000,
      reconnectDelay: config.reconnectDelay || 1000,
      maxReconnectAttempts: config.maxReconnectAttempts || 10,
    };

    // Add auth header if token provided
    if (this.config.token) {
      this.config.headers["Authorization"] = `Bearer ${this.config.token}`;
    }

    // Set content type for POST requests
    this.config.headers["Content-Type"] = "application/json";
  }

  /**
   * Connect to the transport with optional metadata.
   * Opens SSE connection for receiving events.
   */
  async connect(
    connectionId: string,
    metadata?: ConnectionMetadata & { channels?: string[] },
  ): Promise<void> {
    this.currentConnectionId = connectionId;
    this.connectionMetadata = metadata;
    this.channelFilter = metadata?.channels as string[] | undefined;
    this.reconnectAttempts = 0;
    await this.connectSSE();
  }

  /**
   * Connect to Server-Sent Events stream
   */
  private async connectSSE(): Promise<void> {
    if (!this.currentConnectionId) {
      throw new Error("Connection ID required for connection");
    }

    // Close existing connection if any
    this.disconnect().catch(() => {});

    try {
      // Build SSE URL with connection ID and metadata
      const url = new URL(`${this.config.url}/sse`);
      url.searchParams.set("connectionId", this.currentConnectionId);
      if (this.channelFilter && this.channelFilter.length > 0) {
        url.searchParams.set("channels", this.channelFilter.join(","));
      }
      if (this.connectionMetadata?.userId) {
        url.searchParams.set("userId", this.connectionMetadata.userId as string);
      }
      const sseUrl = url.toString();

      // Create EventSource for SSE (browser) or use fetch with streaming (Node.js)
      if (typeof EventSource !== "undefined") {
        // Browser environment
        this.eventSource = new EventSource(sseUrl, {
          withCredentials: false,
        } as any);

        this.eventSource.onmessage = (event) => {
          try {
            const channelEvent: ChannelEvent = JSON.parse(event.data);

            // Apply excludeSender filtering
            const sourceConnectionId = channelEvent.metadata?.["sourceConnectionId"] as
              | string
              | undefined;
            if (
              channelEvent.target?.excludeSender &&
              sourceConnectionId === this.currentConnectionId
            ) {
              return; // Skip - we're the sender
            }

            if (this.receiveHandler) {
              this.receiveHandler(channelEvent);
            }
          } catch (error) {
            console.error("Failed to parse SSE event:", error);
          }
        };

        this.eventSource.onerror = (error) => {
          console.error("SSE connection error:", error);
          this.handleReconnect();
        };

        this.eventSource.onopen = () => {
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
      } else {
        // Node.js environment - use fetch with streaming
        await this.connectSSENode();
      }
    } catch (error) {
      console.error("Failed to connect SSE:", error);
      this.handleReconnect();
      throw error;
    }
  }

  /**
   * Connect to SSE stream in Node.js environment using fetch
   */
  private async connectSSENode(): Promise<void> {
    if (!this.currentConnectionId) {
      throw new Error("Connection ID required for connection");
    }

    // Build SSE URL with connection ID and metadata
    const url = new URL(`${this.config.url}/sse`);
    url.searchParams.set("connectionId", this.currentConnectionId);
    if (this.channelFilter && this.channelFilter.length > 0) {
      url.searchParams.set("channels", this.channelFilter.join(","));
    }
    if (this.connectionMetadata?.userId) {
      url.searchParams.set("userId", this.connectionMetadata.userId as string);
    }
    const sseUrl = url.toString();

    try {
      const response = await fetch(sseUrl, {
        method: "GET",
        headers: {
          ...this.config.headers,
          Accept: "text/event-stream",
        },
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status} ${response.statusText}`);
      }

      if (!response.body) {
        throw new Error("SSE stream body is null");
      }

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

      // Read SSE stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const readStream = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();

            if (done) {
              this.isConnected = false;
              this.handleReconnect();
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                try {
                  const data = line.slice(6);
                  const channelEvent: ChannelEvent = JSON.parse(data);

                  // Apply excludeSender filtering
                  const sourceConnectionId = channelEvent.metadata?.["sourceConnectionId"] as
                    | string
                    | undefined;
                  if (
                    channelEvent.target?.excludeSender &&
                    sourceConnectionId === this.currentConnectionId
                  ) {
                    continue;
                  }

                  if (this.receiveHandler) {
                    this.receiveHandler(channelEvent);
                  }
                } catch (error) {
                  console.error("Failed to parse SSE event:", error);
                }
              }
            }
          }
        } catch (error) {
          console.error("Error reading SSE stream:", error);
          this.isConnected = false;
          this.handleReconnect();
        }
      };

      readStream();
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
        this.connectSSE().catch((error) => {
          console.error("Reconnection failed:", error);
        });
      }
    }, delay);
  }

  /**
   * Join a room (sends HTTP request to server).
   */
  async join(connectionId: string, room: string): Promise<void> {
    try {
      const response = await fetch(`${this.config.url}/rooms/join`, {
        method: "POST",
        headers: this.config.headers,
        body: JSON.stringify({
          connectionId: this.currentConnectionId,
          room,
        }),
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        throw new Error(`Failed to join room: ${response.status}`);
      }

      this.joinedRooms.add(room);
      console.log(`StreamableHTTP: joined room ${room}`);
    } catch (error) {
      console.error(`Failed to join room ${room}:`, error);
      throw error;
    }
  }

  /**
   * Leave a room (sends HTTP request to server).
   */
  async leave(connectionId: string, room: string): Promise<void> {
    try {
      const response = await fetch(`${this.config.url}/rooms/leave`, {
        method: "POST",
        headers: this.config.headers,
        body: JSON.stringify({
          connectionId: this.currentConnectionId,
          room,
        }),
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        throw new Error(`Failed to leave room: ${response.status}`);
      }

      this.joinedRooms.delete(room);
      console.log(`StreamableHTTP: left room ${room}`);
    } catch (error) {
      console.error(`Failed to leave room ${room}:`, error);
      throw error;
    }
  }

  /**
   * Get rooms this connection has joined.
   */
  getConnectionRooms(_connectionId: string): string[] {
    return Array.from(this.joinedRooms);
  }

  /**
   * Disconnect from transport
   */
  async disconnect(_connectionId?: string): Promise<void> {
    this.isConnected = false;
    this.joinedRooms.clear();

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = undefined;
    }

    this.currentConnectionId = undefined;
    this.connectionMetadata = undefined;
  }

  /**
   * Send an event through HTTP POST.
   * Server handles room routing based on event.target.
   */
  async send(event: ChannelEvent): Promise<void> {
    if (!this.currentConnectionId) {
      throw new Error("Not connected. Call connect() first.");
    }

    try {
      const response = await fetch(`${this.config.url}/events`, {
        method: "POST",
        headers: this.config.headers,
        body: JSON.stringify({
          ...event,
          metadata: {
            ...event.metadata,
            sourceConnectionId: this.currentConnectionId,
          },
        }),
        signal: AbortSignal.timeout(this.config.timeout),
      });

      if (!response.ok) {
        throw new Error(`Failed to send event: ${response.status} ${response.statusText}`);
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
