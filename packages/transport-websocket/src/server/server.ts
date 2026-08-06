/**
 * WebSocket server — accepts client WS connections, dispatches JSON-RPC
 * frames to a `GatewayHarness`, fans subscriptions back over each
 * connection.
 *
 * Built on the `ws` library (Node's native WebSocket is client-only).
 * Adopters pass a Node `http.Server` (or `https.Server`); we attach
 * a `WebSocketServer` to it.
 *
 * ## Shared-server citizenship (ownership-aware upgrade)
 *
 * A single Node `http.Server` may carry MANY `upgrade` listeners — this
 * transport's plus the adopter's own (socket.io's Engine.IO on
 * `/socket.io/`, a second agentick transport, etc.). Node's `upgrade`
 * semantics are FIRST-WINS: the first listener that handles the socket
 * claims it; if NO listener handles it, Node destroys the socket itself.
 *
 * So a non-matching upgrade (`url` outside our `path`) must be handled by
 * ownership:
 *   - `ownsServer: true` (the `webSocketServerTransport({ port })` branch
 *     created + owns the listener) — nothing else can legitimately claim a
 *     non-matching upgrade, so we `socket.destroy()` it.
 *   - `ownsServer: false` (attached to an adopter-supplied server, the
 *     `{ httpServer }` branch; also the DEFAULT for direct
 *     `websocketServer(options)` calls, which take `httpServer` from the
 *     caller by definition) — we IGNORE it (return without touching the
 *     socket), leaving it for another `upgrade` listener or Node's own
 *     unhandled-upgrade teardown. Destroying it here would kill every other
 *     websocket consumer sharing the server.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { Server as HttpServer, IncomingMessage } from "node:http";
import { WebSocketServer, type WebSocket as WSConnection } from "ws";
import {
  ErrorCode,
  type IngressIdentity,
  type JsonRpcFrame,
  type WireServerDescriptor,
} from "@agentick/spec";
import {
  authenticateIngress,
  BaseConnectionContext,
  resolveWebSecurity,
  type DispatchHost,
  type WebSecurityOptions,
} from "@agentick/transport";
import { ulid } from "@agentick/utils";

import { AGENTICK_SUBPROTOCOL, decodeFrame, encodeFrame } from "../shared/codec.js";

/**
 * What this transport tells `initialize` callers about the wire they reached.
 * `batch` is true because {@link ConnectionContext.handleMessage} decodes
 * array frames; `streamableHttp` is absent — a WS connection is not one.
 */
const SERVER_DESCRIPTOR: WireServerDescriptor = Object.freeze({
  name: "@agentick/transport-websocket",
  version: "0.0.0",
  batch: true,
});

// A WS upgrade is not classic-CSRF-vulnerable (the browser sends an
// unforgeable Origin), so the origin/host gate is the defense — `csrf` (a
// request-header token on HTTP mutations) is meaningless here and omitted.
export interface WebSocketServerOptions extends Omit<WebSecurityOptions, "csrf"> {
  readonly httpServer: HttpServer;
  readonly gateway: DispatchHost;
  /**
   * Whether this transport OWNS the `httpServer` (it created + listens on
   * it) or is merely ATTACHED to an adopter-supplied one. Governs
   * non-matching-upgrade behavior: owned → destroy the socket (nothing else
   * can claim it); attached → leave it untouched for other `upgrade`
   * listeners (shared-server citizenship). The `webSocketServerTransport`
   * wrapper sets this from the config branch it took. DEFAULT `false`: a
   * direct `websocketServer(options)` call takes `httpServer` from the
   * caller by definition, so it does not own the server.
   */
  readonly ownsServer?: boolean;
  /**
   * Stable id of the owning `ServerTransport`, threaded into the
   * `gateway:accept` op's `ConnectionInfo.transportId` (ADR 84 §4). The
   * `webSocketServerTransport` wrapper passes its own id; a direct caller may
   * override it. Defaults to `"websocket"`.
   */
  readonly transportId?: string;
  readonly path?: string;
  /** Idle ping interval in ms. WS-level ping/pong, not application ping. */
  readonly heartbeatIntervalMs?: number;
  /**
   * Ingress authentication (ADR 34/51 §4.1, ADR 61) — runs ONCE per
   * connection at upgrade time via the shared ingress helper. Token
   * extracted from `Authorization: Bearer ...` (and, only when
   * `allowQueryToken` is set, `?token=`). Rejection destroys the socket
   * with a 401. Omitted = every connection is anonymous (the local
   * pole; pair with the gateway's unconfigured/permissive Authorizer
   * deliberately).
   */
  readonly authSource?: import("@agentick/spec").AuthSource;
  /**
   * Wall-clock ceiling on the `authSource` call, in milliseconds. Defaults to
   * `DEFAULT_INGRESS_AUTHN_TIMEOUT_MS` (10s); `Infinity` opts out. Exceeding it
   * refuses the upgrade with `401` and destroys the socket — unbounded, a hung
   * authenticator leaves the upgrade pending and the raw socket leaked, one per
   * probe.
   */
  readonly authnTimeoutMs?: number;
  /**
   * Accept the bearer token from the `?token=` query param. DEFAULT
   * FALSE (review finding): query strings land in proxy access logs,
   * browser history, and Referer headers — a leak vector for long-lived
   * credentials. Enable only for clients that cannot set headers.
   */
  readonly allowQueryToken?: boolean;
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
  const ownsServer = options.ownsServer ?? false;
  const security = resolveWebSecurity(options);

  const upgradeHandler = (
    req: import("node:http").IncomingMessage,
    socket: import("node:net").Socket,
    head: Buffer,
  ): void => {
    const url = req.url ?? "";
    if (!url.startsWith(path)) {
      // Non-matching upgrade. Owned server → destroy (nothing else can
      // claim it). Attached server → IGNORE, leaving it for another
      // `upgrade` listener (socket.io, a second transport) or Node's own
      // unhandled-upgrade teardown. Destroying here would kill every other
      // websocket consumer on a shared server.
      if (ownsServer) socket.destroy();
      return;
    }
    // Security defaults (STATUS A2 §4c): host allow-list + cross-site
    // rejection at upgrade. A WS upgrade is not classic-CSRF-vulnerable (the
    // browser sends an unforgeable Origin), so the Origin/Host gate is the
    // defense — no CSRF token on the persistent connection.
    const access = security.checkAccess(req);
    if (!access.ok) {
      socket.write(`HTTP/1.1 ${access.status ?? 403} Forbidden\r\n\r\n`);
      socket.destroy();
      return;
    }
    // Minted BEFORE authn so a refused upgrade names the connection it refused;
    // retained on the socket for its life, which is what makes it addressable.
    const connectionId = `conn-${ulid()}`;
    const finishUpgrade = (identity?: IngressIdentity): void => {
      wss.handleUpgrade(req, socket, head, (ws) => {
        const conn = ws as WSConnection & { identity?: unknown; connectionId?: string };
        conn.identity = identity;
        conn.connectionId = connectionId;
        wss.emit("connection", ws, req);
      });
    };
    // Build the ingress context from the native WS-upgrade credential.
    // Bearer from the Authorization header; query token ONLY when the
    // adopter opted in (query strings leak into proxy logs / history).
    const auth = req.headers.authorization;
    const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const query = options.allowQueryToken
      ? (new URL(url, "http://localhost").searchParams.get("token") ?? undefined)
      : undefined;
    const token = bearer ?? query;
    void authenticateIngress(
      {
        transportKind: "websocket",
        connectionId,
        credential: {
          kind: "bearer",
          ...(token !== undefined ? { token } : {}),
          headers: req.headers as Record<string, string | undefined>,
        },
      },
      options.authSource,
      {
        // ADR 92 §Family 1.3 — a refused upgrade leaves an audit trace. The edge
        // enriches with the peer address it alone knows; the credential never
        // travels with it.
        // TODO(ADR-92): the `security.checkAccess` origin/host refusal above is
        // the other admission gate at this edge and deserves the same visibility
        // (a second `IngressAdmissionFailureClass`).
        onRejected: (failure) =>
          options.gateway.emitAdmissionFailure?.(
            req.socket.remoteAddress !== undefined
              ? { ...failure, remoteAddress: req.socket.remoteAddress }
              : failure,
          ),
        // Without a ceiling a hung AuthSource leaves this upgrade pending
        // forever, and the raw socket below is never released.
        ...(options.authnTimeoutMs !== undefined ? { timeoutMs: options.authnTimeoutMs } : {}),
      },
    )
      .then((ctx) => finishUpgrade(ctx.identity))
      .catch(() => {
        // Fail closed — a configured AuthSource that rejected, or one that blew
        // its wall-clock ceiling. The no-AuthSource path never reaches here
        // (the helper resolves).
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
      });
  };

  options.httpServer.on("upgrade", upgradeHandler);

  const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;
  const transportId = options.transportId ?? "websocket";
  const liveSockets = new Set<WSConnection>();

  wss.on("connection", (ws: WSConnection, req: IncomingMessage) => {
    const conn = ws as WSConnection & {
      identity?: import("@agentick/spec").IngressIdentity;
      connectionId?: string;
    };
    const identity = conn.identity;
    const connectionId = conn.connectionId ?? `conn-${ulid()}`;
    // ADR 84 §4 — per-connection admission. Fire `gateway:accept` AFTER
    // ingress-authn (identity is already stamped on the socket) and BEFORE the
    // connection is wired to receive frames. A throwing `onBeforeGatewayAccept`
    // REJECTS the connection: close it with a policy-violation code (1008) and
    // never wire it up. Non-fatal to the listener — one rejected connection must
    // not kill the server, so the rejection is swallowed at this edge.
    void (async () => {
      try {
        await options.gateway.accept({
          transportId,
          connectionId,
          ...(identity !== undefined ? { identity } : {}),
          ...(req.socket.remoteAddress !== undefined
            ? { remoteAddress: req.socket.remoteAddress }
            : {}),
        });
      } catch {
        try {
          ws.close(1008, "connection rejected");
        } catch {
          /* swallow — the socket may already be gone */
        }
        return;
      }
      wireConnection(ws, connectionId, identity);
    })();
  });

  function wireConnection(
    ws: WSConnection,
    connectionId: string,
    identity?: import("@agentick/spec").IngressIdentity,
  ): void {
    liveSockets.add(ws);
    const ctx = new ConnectionContext(ws, options.gateway, connectionId, identity);

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
  }

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
    connectionId: string,
    identity?: import("@agentick/spec").IngressIdentity,
  ) {
    super(gateway, identity, SERVER_DESCRIPTOR, connectionId);
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
export type { DispatchHost } from "@agentick/transport";
export { ErrorCode };
