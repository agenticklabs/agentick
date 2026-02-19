/**
 * Embedded SSE Transport
 *
 * Wraps SSE (EventSource) connections as TransportClients so they
 * participate in the gateway's unified transport system. SSE clients
 * get ClientEventBuffer backpressure, appear in gateway.status.clients,
 * and receive DevTools lifecycle events — just like WS or local clients.
 *
 * Used only in embedded mode (handleRequest path).
 */

import type { ServerResponse as NodeResponse } from "http";
import { BaseTransport, type TransportClient } from "./transport.js";
import type { GatewayMessage } from "./transport-protocol.js";
import type { ClientState } from "./types.js";

// ============================================================================
// EmbeddedSSEClient
// ============================================================================

export class EmbeddedSSEClient implements TransportClient {
  readonly id: string;
  readonly state: ClientState;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    id: string,
    private res: NodeResponse,
  ) {
    this.id = id;
    this.state = {
      id,
      connectedAt: new Date(),
      authenticated: true,
      subscriptions: new Set(),
    };
  }

  send(message: GatewayMessage): void {
    if (!this.isConnected) return;
    this.res.write(`data: ${JSON.stringify(message)}\n\n`);
  }

  isPressured(): boolean {
    return (this.res as any).writableNeedDrain ?? false;
  }

  get isConnected(): boolean {
    return !this.res.writableEnded;
  }

  close(): void {
    this.stopHeartbeat();
    if (!this.res.writableEnded) {
      this.res.end();
    }
  }

  startHeartbeat(intervalMs = 30000): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.isConnected) {
        this.res.write(":heartbeat\n\n");
      }
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  onClose(handler: () => void): void {
    this.res.on("close", () => {
      this.stopHeartbeat();
      handler();
    });
  }
}

// ============================================================================
// EmbeddedSSETransport
// ============================================================================

export class EmbeddedSSETransport extends BaseTransport {
  readonly type = "sse" as const;

  async start(): Promise<void> {
    // No-op: embedded mode, no server to manage
  }

  async stop(): Promise<void> {
    // Close all SSE connections
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }

  registerClient(clientId: string, res: NodeResponse): EmbeddedSSEClient {
    const client = new EmbeddedSSEClient(clientId, res);
    this.clients.set(clientId, client);

    client.startHeartbeat();

    client.onClose(() => {
      this.clients.delete(clientId);
      this.handlers.disconnect?.(clientId, "Connection closed");
    });

    this.handlers.connection?.(client);
    return client;
  }
}
