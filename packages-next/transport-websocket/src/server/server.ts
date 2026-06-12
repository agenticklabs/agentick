/**
 * WebSocket server — accepts client WS connections, dispatches JSON-RPC
 * frames to a `GatewayHarness`, fans subscriptions back over each
 * connection.
 *
 * Built on the `ws` library (Node's native WebSocket is client-only).
 * Adopters pass a Node `http.Server` (or `https.Server`); we attach
 * a `WebSocketServer` to it.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket as WSConnection } from "ws";
import {
  ErrorCode,
  type JsonRpcError,
  type JsonRpcFrame,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@agentick/spec-next";
import { AGENTICK_SUBPROTOCOL, decodeFrame, encodeFrame } from "../shared/codec.js";
import { dispatchRequest, type DispatchHost } from "./dispatch.js";

export interface WebSocketServerOptions {
  readonly httpServer: HttpServer;
  readonly gateway: DispatchHost;
  readonly path?: string;
  readonly allowedOrigins?: readonly string[] | "*";
  /** Idle ping interval in ms. WS-level ping/pong, not application ping. */
  readonly heartbeatIntervalMs?: number;
}

export interface WebSocketServerHandle {
  close(): Promise<void>;
}

export function websocketServer(options: WebSocketServerOptions): WebSocketServerHandle {
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(AGENTICK_SUBPROTOCOL) ? AGENTICK_SUBPROTOCOL : false,
  });

  const path = options.path ?? "/";
  const allowed = options.allowedOrigins;

  const upgradeHandler = (
    req: import("node:http").IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): void => {
    const url = req.url ?? "";
    if (!url.startsWith(path)) {
      socket.destroy();
      return;
    }
    const origin = req.headers.origin;
    if (allowed && allowed !== "*" && origin && !allowed.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  };

  options.httpServer.on("upgrade", upgradeHandler);

  const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;
  const liveSockets = new Set<WSConnection>();

  wss.on("connection", (ws: WSConnection) => {
    liveSockets.add(ws);
    const ctx = new ConnectionContext(ws, options.gateway);

    let alive = true;
    ws.on("pong", () => {
      alive = true;
    });

    const heartbeat = setInterval(() => {
      if (!alive) {
        ws.terminate();
        clearInterval(heartbeat);
        return;
      }
      alive = false;
      try {
        ws.ping();
      } catch {
        /* swallow */
      }
    }, heartbeatMs);

    ws.on("message", (data) => {
      void ctx.handleMessage(data);
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      liveSockets.delete(ws);
      void ctx.close();
    });

    ws.on("error", () => {
      /* swallow — close handler does the cleanup */
    });
  });

  return {
    async close() {
      options.httpServer.off("upgrade", upgradeHandler);
      for (const ws of liveSockets) ws.terminate();
      liveSockets.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

// ============================================================================
// ConnectionContext — per-connection state
// ============================================================================

class ConnectionContext {
  private readonly subscriptions = new Map<string, { unsubscribe: () => Promise<void> }>();
  private readonly inFlight = new Map<JsonRpcId, () => void>();
  private closed = false;

  constructor(
    private readonly ws: WSConnection,
    private readonly gateway: DispatchHost,
  ) {}

  async handleMessage(raw: unknown): Promise<void> {
    if (this.closed) return;
    const decoded = decodeFrame(raw as Buffer | string);
    if (!decoded.ok) {
      this.sendError(null, decoded.error);
      return;
    }
    const frame = decoded.value;
    if (Array.isArray(frame)) {
      const responses = await Promise.all(frame.map((f) => this.handleFrame(f as JsonRpcFrame)));
      const filtered = responses.filter((r): r is JsonRpcResponse => r !== null);
      if (filtered.length > 0) this.send(filtered);
      return;
    }
    const response = await this.handleFrame(frame as JsonRpcFrame);
    if (response !== null) this.send(response);
  }

  private async handleFrame(frame: JsonRpcFrame): Promise<JsonRpcResponse | null> {
    if ("method" in frame && !("id" in frame)) {
      // Notification from client — no response. Currently only
      // notifications/cancelled is meaningful; route it.
      this.handleNotification(frame);
      return null;
    }
    if ("id" in frame && "method" in frame) {
      return this.handleRequest(frame as JsonRpcRequest);
    }
    return null;
  }

  private async handleRequest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    return dispatchRequest(this.gateway, req, {
      sendNotification: (n) => this.send({ jsonrpc: "2.0", method: n.method, params: n.params }),
      registerSubscription: (subId, unsubscribe) => {
        this.subscriptions.set(subId, { unsubscribe });
      },
      unregisterSubscription: (subId) => {
        this.subscriptions.delete(subId);
      },
      registerInFlight: (id, abort) => {
        this.inFlight.set(id, abort);
      },
      unregisterInFlight: (id) => {
        this.inFlight.delete(id);
      },
    });
  }

  private handleNotification(frame: JsonRpcFrame): void {
    if (!("method" in frame)) return;
    if (frame.method !== "notifications/cancelled") return;
    const params = frame.params as { requestId?: JsonRpcId } | undefined;
    if (params?.requestId === undefined) return;
    const abort = this.inFlight.get(params.requestId);
    if (abort) abort();
  }

  send(frame: JsonRpcFrame | readonly JsonRpcFrame[]): void {
    if (this.closed) return;
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(encodeFrame(frame as JsonRpcFrame));
    } catch {
      /* swallow — close handler cleans up */
    }
  }

  private sendError(id: JsonRpcId | null, error: JsonRpcError): void {
    this.send({ jsonrpc: "2.0", id, error } as JsonRpcResponse);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const { unsubscribe } of this.subscriptions.values()) {
      try {
        await unsubscribe();
      } catch {
        /* swallow */
      }
    }
    this.subscriptions.clear();
    for (const abort of this.inFlight.values()) {
      try {
        abort();
      } catch {
        /* swallow */
      }
    }
    this.inFlight.clear();
  }
}

// Re-export the dispatch host shape so adopters can supply their own
// (e.g., a wrapper that adds auth, telemetry, custom methods).
export type { DispatchHost } from "./dispatch.js";
export { ErrorCode };
