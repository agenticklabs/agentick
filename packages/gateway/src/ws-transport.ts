/**
 * WebSocket Transport
 *
 * Implements the Transport interface using WebSocket connections.
 */

import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "http";
import type { ClientMessage, GatewayMessage, ConnectMessage } from "./transport-protocol.js";
import type { ClientState } from "./types.js";
import { BaseTransport, type TransportClient, type NetworkTransportConfig } from "./transport.js";

// ============================================================================
// WebSocket Client
// ============================================================================

class WSClientImpl implements TransportClient {
  readonly id: string;
  readonly socket: WebSocket;
  readonly state: ClientState;
  private transport: WSTransport;

  constructor(id: string, socket: WebSocket, transport: WSTransport) {
    this.id = id;
    this.socket = socket;
    this.transport = transport;
    this.state = {
      id,
      connectedAt: new Date(),
      authenticated: false,
      subscriptions: new Set(),
    };
  }

  send(message: GatewayMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  get isConnected(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  isPressured(): boolean {
    return this.socket.bufferedAmount > 64 * 1024;
  }

  /** @internal - Update client ID (for custom client IDs) */
  _setId(newId: string): void {
    (this as { id: string }).id = newId;
    (this.state as { id: string }).id = newId;
  }
}

// ============================================================================
// WebSocket Transport
// ============================================================================

export class WSTransport extends BaseTransport {
  readonly type = "websocket" as const;
  private wss: WebSocketServer | null = null;
  protected override config: NetworkTransportConfig;

  constructor(config: NetworkTransportConfig) {
    super(config);
    this.config = config;
  }

  override start(): Promise<void> {
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

  override stop(): Promise<void> {
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

  private handleConnection(socket: WebSocket, _request: IncomingMessage): void {
    const clientId = this.generateClientId();
    const client = new WSClientImpl(clientId, socket, this);
    this.clients.set(clientId, client);

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        this.handleMessage(client, message);
      } catch (_error) {
        client.send({
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Failed to parse message",
        });
      }
    });

    socket.on("close", () => {
      this.clients.delete(client.id);
      this.handlers.disconnect?.(client.id);
    });

    socket.on("error", (error) => {
      this.handlers.error?.(error);
    });

    // Notify handler of new connection (before auth)
    this.handlers.connection?.(client);
  }

  private async handleMessage(client: WSClientImpl, message: ClientMessage): Promise<void> {
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

  private async handleConnect(client: WSClientImpl, message: ConnectMessage): Promise<void> {
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
      client._setId(message.clientId);
      this.clients.set(message.clientId, client);
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export function createWSTransport(config: NetworkTransportConfig): WSTransport {
  return new WSTransport(config);
}
