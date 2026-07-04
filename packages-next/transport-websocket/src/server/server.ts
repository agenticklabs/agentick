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
import { ErrorCode, type JsonRpcFrame } from "@agentick/spec-next";
import { BaseConnectionContext, type DispatchHost } from "@agentick/transport-next";
import { AGENTICK_SUBPROTOCOL, decodeFrame, encodeFrame } from "../shared/codec.js";

export interface WebSocketServerOptions {
  readonly httpServer: HttpServer;
  readonly gateway: DispatchHost;
  readonly path?: string;
  readonly allowedOrigins?: readonly string[] | "*";
  /** Idle ping interval in ms. WS-level ping/pong, not application ping. */
  readonly heartbeatIntervalMs?: number;
  /**
   * Ingress authentication (ADR 34/51 §4.1) — runs ONCE per connection
   * at upgrade time. Token extracted from `Authorization: Bearer ...`
   * or the `?token=` query param. Throw to reject the upgrade (401).
   * Omitted = every connection is anonymous (the local pole; pair with
   * the gateway's unconfigured/permissive Authorizer deliberately).
   */
  readonly authSource?: import("@agentick/spec-next").AuthSource;
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
    const finishUpgrade = (identity?: import("@agentick/spec-next").IngressIdentity): void => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        (ws as WSConnection & { identity?: unknown }).identity = identity;
        wss.emit("connection", ws, req);
      });
    };
    if (options.authSource) {
      const auth = req.headers.authorization;
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
      const query = new URL(url, "http://localhost").searchParams.get("token") ?? undefined;
      void options.authSource
        .authenticate({
          ...((bearer ?? query) ? { token: bearer ?? query } : {}),
          headers: req.headers as Record<string, string | undefined>,
        })
        .then((identity) => finishUpgrade(identity))
        .catch(() => {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
        });
    } else {
      finishUpgrade();
    }
  };

  options.httpServer.on("upgrade", upgradeHandler);

  const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;
  const liveSockets = new Set<WSConnection>();

  wss.on("connection", (ws: WSConnection) => {
    liveSockets.add(ws);
    const ctx = new ConnectionContext(
      ws,
      options.gateway,
      (ws as WSConnection & { identity?: import("@agentick/spec-next").IngressIdentity }).identity,
    );

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
// ConnectionContext — per-WS-connection state.
//
// Subscription + in-flight registries, JSON-RPC dispatch, close cleanup
// all live in the shared `BaseConnectionContext`. This subclass only
// wires the WS-specific encode + the inbound message decode pipeline.
// ============================================================================

class ConnectionContext extends BaseConnectionContext {
  constructor(
    private readonly ws: WSConnection,
    gateway: DispatchHost,
    identity?: import("@agentick/spec-next").IngressIdentity,
  ) {
    super(gateway, identity);
  }

  async handleMessage(raw: unknown): Promise<void> {
    const decoded = decodeFrame(raw as Buffer | string);
    if (!decoded.ok) {
      this.sendError(null, decoded.error);
      return;
    }
    const frame = decoded.value;
    if (Array.isArray(frame)) {
      const responses = await Promise.all(
        frame.map((f) => this.dispatchInbound(f as JsonRpcFrame)),
      );
      for (const r of responses) {
        if (r !== null) this.send(r);
      }
      return;
    }
    const response = await this.dispatchInbound(frame as JsonRpcFrame);
    if (response !== null) this.send(response);
  }

  protected sendFrame(frame: JsonRpcFrame): void {
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(encodeFrame(frame));
    } catch {
      /* swallow — close handler cleans up */
    }
  }

  protected closeWire(): void {
    /* socket closure is driven by the server-side WS lifecycle */
  }
}

// Re-export the dispatch host shape so adopters can supply their own
// (e.g., a wrapper that adds auth, telemetry, custom methods).
export type { DispatchHost } from "@agentick/transport-next";
export { ErrorCode };
