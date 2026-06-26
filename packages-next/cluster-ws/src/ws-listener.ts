/**
 * `createWsListener(opts)` — `WebSocketServer` wrapped as the
 * `Listener` interface from `@agentick/cluster-broker-next`.
 *
 * Two modes:
 *
 *   - **Mount** (`httpServer` supplied): attaches an upgrade
 *     handler to the adopter's existing `http.Server`. WebSocket
 *     traffic shares the port with whatever else the server is
 *     hosting (HTTP API, static files, etc.). This is the
 *     gateway-level deployment scenario per ADR 35 and the Phase 4
 *     design.
 *
 *   - **Standalone** (`port` supplied): the listener owns its own
 *     HTTP server on a dedicated port. Used at the app-level when
 *     no existing server is available.
 *
 * Both modes negotiate the `agentick-cluster-v1` subprotocol — the
 * upgrade handshake's `Sec-WebSocket-Protocol` header is checked
 * against this fixed value. Mismatched subprotocols are rejected
 * with a 426 Upgrade Required response so clients see a clear
 * "wrong protocol version" signal.
 *
 * @see ADR 35 §6 (WebSocket gateway-level mount)
 */

import { createServer as createHttpServer, type Server as HttpServer } from "node:http";

import { WebSocketServer, type WebSocket as WSConnection } from "ws";

import type { Connection, Listener } from "@agentick/cluster-broker-next";

import { AGENTICK_CLUSTER_SUBPROTOCOL, type WsListenerOptions } from "./ws-shared.js";
import { wsToConnection } from "./ws-connection.js";

// Phase 4f.2 consolidated `startBroker`, `createClusterNode`, and
// `defineWireCluster` into `@agentick/cluster-broker-next/wire-helpers
// .ts`. The wire-specific listener/connector modules (this file,
// tcp-listener.ts, unix-listener.ts) stay separate — they each handle
// wire-specific concerns (subprotocol negotiation here; length-prefix
// framing in tcp/unix). Phase 5+ may extract more shared bits if real
// duplication remains; the current shape is post-DRY.

export function createWsListener(opts: WsListenerOptions): Listener {
  const path = opts.path ?? "/cluster";
  const onDiagnostic = opts.onDiagnostic ?? (() => {});
  const allowedOrigins = opts.allowedOrigins;
  const acceptHandlers = new Set<(conn: Connection) => void>();

  // The WebSocketServer runs in noServer mode so we own the
  // upgrade routing — lets adopters mount us on any existing
  // http.Server alongside other route handlers.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) =>
      protocols.has(AGENTICK_CLUSTER_SUBPROTOCOL) ? AGENTICK_CLUSTER_SUBPROTOCOL : false,
  });

  let httpServer: HttpServer | null = null;
  let ownedHttpServer = false;
  let started = false;
  let closed = false;
  let upgradeAttached = false;

  function handleConnection(
    ws: WSConnection,
    req?: { socket?: { remoteAddress?: string; remotePort?: number } },
  ): void {
    if (closed) {
      ws.close(1001);
      return;
    }
    const remote = describeRemote(req);
    const conn = wsToConnection(ws, { onDiagnostic, ...(remote ? { remote } : {}) });
    for (const handler of [...acceptHandlers]) {
      try {
        handler(conn);
      } catch (cause) {
        onDiagnostic("cluster:broker:ws:accept-handler-threw", {
          remote,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  // Upgrade handler installed against the host http.Server. The
  // adopter retains ownership of every other request on that server;
  // we only claim the `path` prefix.
  function upgradeHandler(
    req: import("node:http").IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): void {
    const url = req.url ?? "";
    if (!url.startsWith(path)) {
      // Not our request — leave the socket alone for any other
      // upgrade handler the adopter has registered.
      return;
    }
    const origin = req.headers.origin;
    if (allowedOrigins !== undefined && origin && !allowedOrigins.includes(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      onDiagnostic("cluster:broker:ws:origin-rejected", { origin });
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }

  wss.on("connection", (ws: WSConnection, req?: import("node:http").IncomingMessage) => {
    handleConnection(ws, req as never);
  });

  return {
    bound:
      "httpServer" in opts && opts.httpServer
        ? `ws://(adopted)${path}`
        : "port" in opts && opts.port
          ? `ws://${opts.host ?? "127.0.0.1"}:${opts.port}${path}`
          : undefined,

    async start() {
      if (started) return;
      started = true;
      if ("httpServer" in opts && opts.httpServer) {
        httpServer = opts.httpServer;
        ownedHttpServer = false;
        httpServer.on("upgrade", upgradeHandler);
        upgradeAttached = true;
        onDiagnostic("cluster:broker:ws:listener-mounted", { path });
        return;
      }
      // Standalone mode: spin up our own http.Server bound to the
      // configured host:port. This is the app-level fallback for
      // adopters without an existing server.
      if ("port" in opts && opts.port !== undefined) {
        const host = opts.host ?? "127.0.0.1";
        const port = opts.port;
        const server = createHttpServer();
        server.on("upgrade", upgradeHandler);
        upgradeAttached = true;
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error): void => {
            server.off("listening", onListening);
            reject(err);
          };
          const onListening = (): void => {
            server.off("error", onError);
            resolve();
          };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(port, host);
        });
        httpServer = server;
        ownedHttpServer = true;
        onDiagnostic("cluster:broker:ws:listener-bound", { host, port, path });
        return;
      }
      throw new Error("createWsListener: must supply either { httpServer } or { port }");
    },

    onConnection(handler) {
      acceptHandlers.add(handler);
      return () => {
        acceptHandlers.delete(handler);
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      acceptHandlers.clear();
      if (upgradeAttached && httpServer) {
        httpServer.off("upgrade", upgradeHandler);
      }
      // Close every still-open WebSocket; the wss.close() callback
      // fires once they're all drained.
      for (const client of wss.clients) {
        try {
          client.close(1001);
        } catch {
          // ignore
        }
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      if (ownedHttpServer && httpServer) {
        await new Promise<void>((resolve) => {
          httpServer!.close(() => resolve());
        });
      }
      onDiagnostic("cluster:broker:ws:listener-closed", { path });
    },
  };
}

function describeRemote(
  req: { socket?: { remoteAddress?: string; remotePort?: number } } | undefined,
): string | undefined {
  if (!req || !req.socket) return undefined;
  const addr = req.socket.remoteAddress;
  const port = req.socket.remotePort;
  if (addr === undefined || port === undefined) return undefined;
  return `${addr}:${port}`;
}
