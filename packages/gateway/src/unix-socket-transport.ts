/**
 * Unix Socket Transport
 *
 * Implements the Transport interface using Unix domain sockets.
 * Protocol: newline-delimited JSON (NDJSON) — same message types as WS.
 * JSON.stringify escapes internal newlines, so raw \n is an unambiguous delimiter.
 */

import net from "node:net";
import fs from "node:fs";
import type { ClientMessage, GatewayMessage, ConnectMessage } from "./transport-protocol.js";
import type { ClientState } from "./types.js";
import { BaseTransport, type TransportClient, type TransportConfig } from "./transport.js";
import { LineBuffer } from "./ndjson.js";

// ============================================================================
// Configuration
// ============================================================================

export interface UnixSocketTransportConfig extends TransportConfig {
  /** Path to the Unix domain socket file */
  socketPath: string;
}

// ============================================================================
// Unix Socket Client (server-side)
// ============================================================================

class UnixSocketClientImpl implements TransportClient {
  readonly id: string;
  readonly state: ClientState;
  private socket: net.Socket;

  constructor(id: string, socket: net.Socket) {
    this.id = id;
    this.socket = socket;
    this.state = {
      id,
      connectedAt: new Date(),
      authenticated: false,
      subscriptions: new Set(),
    };
  }

  send(message: GatewayMessage): void {
    if (!this.socket.destroyed && this.socket.writable) {
      this.socket.write(JSON.stringify(message) + "\n");
    }
  }

  close(_code?: number, _reason?: string): void {
    this.socket.destroy();
  }

  get isConnected(): boolean {
    return !this.socket.destroyed && this.socket.writable;
  }

  isPressured(): boolean {
    return this.socket.writableLength > 64 * 1024;
  }

  /** @internal - Update client ID (for custom client IDs) */
  _setId(newId: string): void {
    (this as { id: string }).id = newId;
    (this.state as { id: string }).id = newId;
  }
}

// ============================================================================
// Unix Socket Transport
// ============================================================================

export class UnixSocketTransport extends BaseTransport {
  readonly type = "unix" as const;
  private server: net.Server | null = null;
  protected override config: UnixSocketTransportConfig;

  constructor(config: UnixSocketTransportConfig) {
    super(config);
    this.config = config;
  }

  override start(): Promise<void> {
    return new Promise((resolve, reject) => {
      // Clean up stale socket file if it exists
      try {
        fs.unlinkSync(this.config.socketPath);
      } catch {
        // File doesn't exist — fine
      }

      try {
        this.server = net.createServer((socket) => this.handleConnection(socket));

        this.server.on("error", (error) => {
          this.handlers.error?.(error);
          reject(error);
        });

        this.server.listen(this.config.socketPath, () => {
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  override async stop(): Promise<void> {
    // Close all client connections
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();

    // Close the server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => {
          this.server = null;
          resolve();
        });
      });
    }

    // Remove socket file
    try {
      fs.unlinkSync(this.config.socketPath);
    } catch {
      // Already removed or never created
    }
  }

  private handleConnection(socket: net.Socket): void {
    const clientId = this.generateClientId();
    const client = new UnixSocketClientImpl(clientId, socket);
    this.clients.set(clientId, client);

    const lineBuffer = new LineBuffer();

    // Message processing queue — serializes async handling per client.
    // Without this, messages in the same TCP chunk race: auth (async)
    // for the connect message hasn't finished when the first req arrives.
    let messageQueue = Promise.resolve();

    socket.on("data", (data) => {
      const lines = lineBuffer.feed(data.toString());
      for (const line of lines) {
        messageQueue = messageQueue.then(async () => {
          try {
            const message = JSON.parse(line) as ClientMessage;
            await this.handleMessage(client, message);
          } catch {
            client.send({
              type: "error",
              code: "INVALID_MESSAGE",
              message: "Failed to parse message",
            });
          }
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

  private async handleMessage(client: UnixSocketClientImpl, message: ClientMessage): Promise<void> {
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

  private async handleConnect(
    client: UnixSocketClientImpl,
    message: ConnectMessage,
  ): Promise<void> {
    const authResult = await this.validateAuth(message.token);

    if (!authResult.valid) {
      client.send({
        type: "error",
        code: "AUTH_FAILED",
        message: "Authentication failed",
      });
      client.close();
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
      this.clients.delete(client.id);
      client._setId(message.clientId);
      this.clients.set(message.clientId, client);
    }
  }
}
