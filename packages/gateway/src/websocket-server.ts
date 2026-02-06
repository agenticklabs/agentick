/**
 * WebSocket Server
 *
 * Handles WebSocket connections and message routing.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type {
  ClientMessage,
  GatewayMessage,
  ConnectMessage,
  RequestMessage,
} from "./transport-protocol.js";
import type { ClientState, AuthConfig, AuthResult } from "./types.js";

export interface WSServerConfig {
  port: number;
  host: string;
  auth?: AuthConfig;
}

export interface WSServerEvents {
  connection: (client: WSClient) => void;
  disconnect: (clientId: string, reason?: string) => void;
  message: (clientId: string, message: ClientMessage) => void;
  error: (error: Error) => void;
}

export class WSClient {
  readonly id: string;
  readonly socket: WebSocket;
  readonly state: ClientState;
  private server: WSServer;

  constructor(id: string, socket: WebSocket, server: WSServer) {
    this.id = id;
    this.socket = socket;
    this.server = server;
    this.state = {
      id,
      connectedAt: new Date(),
      authenticated: false,
      subscriptions: new Set(),
    };
  }

  /**
   * Send a message to this client
   */
  send(message: GatewayMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  /**
   * Close the connection
   */
  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  /**
   * Check if connected
   */
  get isConnected(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }
}

export class WSServer {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, WSClient>();
  private config: WSServerConfig;
  private handlers: Partial<WSServerEvents> = {};
  private clientIdCounter = 0;

  constructor(config: WSServerConfig) {
    this.config = config;
  }

  /**
   * Start the WebSocket server
   */
  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          port: this.config.port,
          host: this.config.host,
        });

        this.wss.on("connection", this.handleConnection.bind(this));
        this.wss.on("error", (error) => {
          this.handlers.error?.(error);
          reject(error);
        });

        this.wss.on("listening", () => {
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  /**
   * Stop the server
   */
  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }

      // Close all client connections
      for (const client of this.clients.values()) {
        client.close(1001, "Server shutting down");
      }
      this.clients.clear();

      // Close the server
      this.wss.close(() => {
        this.wss = null;
        resolve();
      });
    });
  }

  /**
   * Register event handlers
   */
  on<K extends keyof WSServerEvents>(event: K, handler: WSServerEvents[K]): void {
    this.handlers[event] = handler;
  }

  /**
   * Get a client by ID
   */
  getClient(id: string): WSClient | undefined {
    return this.clients.get(id);
  }

  /**
   * Get all clients
   */
  getClients(): WSClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get authenticated clients
   */
  getAuthenticatedClients(): WSClient[] {
    return this.getClients().filter((c) => c.state.authenticated);
  }

  /**
   * Broadcast a message to all authenticated clients
   */
  broadcast(message: GatewayMessage): void {
    for (const client of this.getAuthenticatedClients()) {
      client.send(message);
    }
  }

  /**
   * Send a message to clients subscribed to a session
   */
  sendToSubscribers(sessionId: string, message: GatewayMessage): void {
    for (const client of this.getAuthenticatedClients()) {
      if (client.state.subscriptions.has(sessionId)) {
        client.send(message);
      }
    }
  }

  /**
   * Get connected client count
   */
  get clientCount(): number {
    return this.clients.size;
  }

  private handleConnection(socket: WebSocket, _request: IncomingMessage): void {
    const clientId = `client-${++this.clientIdCounter}`;
    const client = new WSClient(clientId, socket, this);
    this.clients.set(clientId, client);

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        this.handleMessage(client, message);
      } catch (error) {
        client.send({
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Failed to parse message",
        });
      }
    });

    socket.on("close", () => {
      this.clients.delete(clientId);
      this.handlers.disconnect?.(clientId);
    });

    socket.on("error", (error) => {
      this.handlers.error?.(error);
    });

    // Notify handler of new connection (before auth)
    this.handlers.connection?.(client);
  }

  private async handleMessage(client: WSClient, message: ClientMessage): Promise<void> {
    // Handle connect message (authentication)
    if (message.type === "connect") {
      await this.handleConnect(client, message);
      return;
    }

    // Handle ping
    if (message.type === "ping") {
      client.send({ type: "pong", timestamp: message.timestamp });
      return;
    }

    // All other messages require authentication
    if (!client.state.authenticated) {
      client.send({
        type: "error",
        code: "UNAUTHORIZED",
        message: "Authentication required. Send connect message first.",
      });
      return;
    }

    // Forward to message handler
    this.handlers.message?.(client.id, message);
  }

  private async handleConnect(client: WSClient, message: ConnectMessage): Promise<void> {
    // Validate authentication
    const authResult = await this.validateAuth(message.token);

    if (!authResult.valid) {
      client.send({
        type: "error",
        code: "AUTH_FAILED",
        message: "Authentication failed",
      });
      client.close(4001, "Authentication failed");
      return;
    }

    // Update client state
    client.state.authenticated = true;
    client.state.user = authResult.user;
    client.state.metadata = {
      ...client.state.metadata,
      ...authResult.metadata,
      ...message.metadata,
    };

    // Client ID from message takes precedence
    if (message.clientId) {
      // Update internal tracking if client provides their own ID
      this.clients.delete(client.id);
      (client as { id: string }).id = message.clientId;
      this.clients.set(message.clientId, client);
    }
  }

  private async validateAuth(token?: string): Promise<AuthResult> {
    const auth = this.config.auth;

    // No auth configured
    if (!auth || auth.type === "none") {
      return { valid: true };
    }

    // Token auth
    if (auth.type === "token") {
      return { valid: token === auth.token };
    }

    // JWT auth
    if (auth.type === "jwt") {
      return { valid: false };
    }

    // Custom auth
    if (auth.type === "custom") {
      return await auth.validate(token ?? "");
    }

    return { valid: false };
  }
}
