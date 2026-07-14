/**
 * Streamable HTTP server — per MCP 2025-03-26 spec.
 *
 * Mounts on a Node `http.Server` (caller-supplied — adopters wire
 * `https.Server`, Express's underlying server, or anything else that
 * implements `Server.on("request")`).
 *
 * Routing:
 *
 *   - `POST <path>`  — JSON-RPC request. Response is
 *                       `application/json` for single responses;
 *                       `text/event-stream` when the request carries
 *                       `_meta.progressToken` (server streams
 *                       `notifications/progress` then the final
 *                       response).
 *   - `GET  <path>`  — `Accept: text/event-stream` opens a persistent
 *                       SSE for notifications outside any specific RPC
 *                       (subscription events, auth events).
 *   - `DELETE <path>` — terminates the connection state on the server
 *                        (releases per-connection subscriptions, etc.).
 *
 * Session affinity: server emits `Mcp-Session-Id` on the first
 * response; client echoes it on subsequent requests. Load balancers
 * sticky-route by that header.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { Server as HttpServerNode, IncomingMessage, ServerResponse } from "node:http";
import {
  ErrorCode,
  type AuthSource,
  type IngressIdentity,
  type JsonRpcError,
  type JsonRpcFrame,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@agentick/spec-next";
import {
  authenticateIngress,
  BaseConnectionContext,
  dispatchRequest,
  type DispatchHost,
} from "@agentick/transport-next";
import { encodeSseFrame } from "../shared/sse.js";

export interface HttpServerOptions {
  readonly httpServer: HttpServerNode;
  readonly gateway: DispatchHost;
  readonly path?: string;
  readonly allowedOrigins?: readonly string[] | "*";
  /** Idle ping interval on the persistent GET stream (ms). Default 30s. */
  readonly heartbeatIntervalMs?: number;
  /**
   * Ingress authentication (ADR 61) — HTTP is stateless, so this runs
   * PER REQUEST: each POST authenticates from its OWN
   * `Authorization: Bearer ...` header and that request's identity
   * governs only that request's dispatch (no cross-request bleed). The
   * persistent GET stream authenticates at open. Rejection → 401.
   * Omitted = every request is anonymous (the local pole).
   */
  readonly authSource?: AuthSource;
}

export interface HttpServerHandle {
  close(): Promise<void>;
}

const SESSION_ID_HEADER = "mcp-session-id";

export function httpServer(options: HttpServerOptions): HttpServerHandle {
  const path = options.path ?? "/";
  const allowed = options.allowedOrigins;
  const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;

  // Per-session connection state, keyed by session id.
  const sessions = new Map<string, SessionConnection>();

  // ADR 84 §4 — NO `gateway:accept` here. `gateway:accept` is a per-CONNECTION
  // admission seam for connection-oriented transports (WebSocket / Unix socket),
  // fired once when a persistent connection is accepted. HTTP is REQUEST-oriented:
  // there is no persistent connection to admit — each request authenticates its
  // own `Authorization` header, and its admission is the per-request `authorize`
  // path (handled inside `dispatchRequest` via the gateway's `authorizeDispatch`
  // pre-gate + hookable `authorizer:authorize` op). So this transport fires
  // `authorize`, never `accept`.
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? "/";
    if (!url.startsWith(path)) {
      res.statusCode = 404;
      res.end();
      return;
    }

    const origin = req.headers.origin;
    if (allowed && allowed !== "*" && typeof origin === "string" && !allowed.includes(origin)) {
      res.statusCode = 403;
      res.end();
      return;
    }
    if (allowed === "*" && typeof origin === "string") {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Mcp-Session-Id, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, DELETE, OPTIONS");
    }
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }

    const sessionId = (req.headers[SESSION_ID_HEADER] as string | undefined) ?? null;

    if (req.method === "POST") {
      void handlePost(req, res, sessions, sessionId, options.gateway, options.authSource);
      return;
    }
    if (req.method === "GET") {
      const accept = req.headers.accept ?? "";
      if (!accept.includes("text/event-stream")) {
        res.statusCode = 406;
        res.end();
        return;
      }
      void handleGet(
        req,
        res,
        sessions,
        sessionId,
        heartbeatMs,
        options.gateway,
        options.authSource,
      );
      return;
    }
    if (req.method === "DELETE") {
      // TODO(#146): DELETE releases per-session fan-out state without an
      // authn gate — a configured AuthSource should also govern who may
      // tear down a session. ADR 61 slice 1 specifies POST + GET; wire
      // DELETE through `authenticateHttpRequest` in a follow-up.
      handleDelete(sessions, sessionId);
      res.statusCode = 204;
      res.end();
      return;
    }
    res.statusCode = 405;
    res.end();
  };

  options.httpServer.on("request", handler);

  return {
    async close() {
      options.httpServer.off("request", handler);
      for (const s of sessions.values()) await s.close();
      sessions.clear();
    },
  };
}

// ============================================================================
// SessionConnection — per-session-id server state
// ============================================================================

// HTTP is stateless per request (ADR 61): the per-session-id
// SessionConnection holds ONLY shared fan-out state (subscriptions,
// in-flight registry, notification stream). It deliberately does NOT
// carry an ingress identity — each POST/GET authenticates from its own
// Authorization header and threads that request's identity directly
// into `dispatchRequest`. Caching identity on the connection would let
// one request's principal govern another's dispatch (cross-request
// bleed) — the invariant this transport must never violate.
class SessionConnection extends BaseConnectionContext {
  readonly id: string;
  private notificationStream: ServerResponse | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(id: string, gateway: DispatchHost) {
    super(gateway);
    this.id = id;
  }

  attachNotificationStream(res: ServerResponse, heartbeatMs: number): void {
    if (this.notificationStream) {
      try {
        this.notificationStream.end();
      } catch {
        /* swallow */
      }
    }
    this.notificationStream = res;
    res.on("close", () => {
      if (this.notificationStream === res) {
        this.notificationStream = null;
      }
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
    });
    this.heartbeatTimer = setInterval(() => {
      try {
        res.write(": ping\n\n");
      } catch {
        /* swallow */
      }
    }, heartbeatMs);
  }

  /**
   * HTTP overrides the default notification sink — notifications go on
   * the persistent GET SSE stream rather than the active wire (which
   * for HTTP is the per-RPC POST response).
   */
  override sendNotification(notification: { method: string; params?: unknown }): void {
    if (!this.notificationStream) return;
    try {
      this.notificationStream.write(
        encodeSseFrame({
          jsonrpc: "2.0",
          method: notification.method,
          params: notification.params,
        }),
      );
    } catch {
      /* swallow */
    }
  }

  /**
   * HTTP has no single "outbound wire" — each POST writes its own
   * response. `sendFrame` is unused; we override `sendNotification`
   * to route via the GET stream.
   */
  protected sendFrame(_frame: import("@agentick/spec-next").JsonRpcFrame): void {
    /* unused for HTTP; sendNotification routes to the GET stream */
  }

  protected closeWire(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.notificationStream) {
      try {
        this.notificationStream.end();
      } catch {
        /* swallow */
      }
      this.notificationStream = null;
    }
  }
}

// ============================================================================
// POST handler — JSON-RPC request → response (single or streaming)
// ============================================================================

async function handlePost(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, SessionConnection>,
  sessionIdHeader: string | null,
  gateway: DispatchHost,
  authSource: AuthSource | undefined,
): Promise<void> {
  // Authenticate THIS request first (ADR 61 — per-request, header-based,
  // independent of body). A configured AuthSource that rejects → 401.
  // The resulting identity is a request-scoped local — it is threaded
  // into this request's dispatch calls and never stored on the session.
  const authResult = await authenticateHttpRequest(req, authSource, sessionIdHeader ?? undefined);
  if (!authResult.ok) {
    writeUnauthorized(res);
    return;
  }
  const identity = authResult.identity;

  const body = await readBody(req);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    writeJsonError(res, null, {
      code: ErrorCode.ParseError,
      message: "invalid JSON",
    });
    return;
  }

  // Acquire / create session.
  const sessionId = sessionIdHeader ?? newSessionId();
  const session = sessions.get(sessionId) ?? new SessionConnection(sessionId, gateway);
  if (!sessions.has(sessionId)) sessions.set(sessionId, session);
  res.setHeader("Mcp-Session-Id", sessionId);

  if (Array.isArray(parsed)) {
    // Batch — respond with a JSON array of responses. Every frame in
    // the batch runs under THIS request's identity.
    const responses: JsonRpcResponse[] = [];
    for (const frame of parsed) {
      const r = await dispatchSingle(frame, session, gateway, identity);
      if (r !== null) responses.push(r);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(responses));
    return;
  }

  const frame = parsed as JsonRpcFrame;

  // Notifications (no id) — no response. Currently handles
  // notifications/cancelled routing into in-flight aborts.
  if ("method" in frame && !("id" in frame)) {
    if (frame.method === "notifications/cancelled") {
      const params = frame.params as { requestId?: JsonRpcId } | undefined;
      if (params?.requestId !== undefined) {
        session.cancelInFlight(params.requestId);
      }
    }
    res.statusCode = 204;
    res.end();
    return;
  }

  if (!("id" in frame) || !("method" in frame)) {
    writeJsonError(res, null, {
      code: ErrorCode.InvalidRequest,
      message: "frame must be a JSON-RPC request",
    });
    return;
  }

  const request = frame as JsonRpcRequest;
  const params = request.params as { _meta?: { progressToken?: string } } | undefined;
  const isStreaming = typeof params?._meta?.progressToken === "string";

  if (isStreaming) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    const response = await dispatchRequest(
      gateway,
      request,
      {
        sendNotification: (n) => {
          try {
            res.write(encodeSseFrame({ jsonrpc: "2.0", method: n.method, params: n.params }));
          } catch {
            /* swallow */
          }
        },
        registerSubscription: (subId, unsubscribe) =>
          session.registerSubscription(subId, unsubscribe),
        unregisterSubscription: (subId) => session.unregisterSubscription(subId),
        registerInFlight: (id, abort) => session.registerInFlight(id, abort),
        unregisterInFlight: (id) => session.unregisterInFlight(id),
      },
      identity,
    );
    try {
      res.write(encodeSseFrame(response));
      res.end();
    } catch {
      /* swallow */
    }
    return;
  }

  // Non-streaming — single JSON response.
  const response = await dispatchRequest(
    gateway,
    request,
    {
      sendNotification: (n) => session.sendNotification(n),
      registerSubscription: (subId, unsubscribe) =>
        session.registerSubscription(subId, unsubscribe),
      unregisterSubscription: (subId) => session.unregisterSubscription(subId),
      registerInFlight: (id, abort) => session.registerInFlight(id, abort),
      unregisterInFlight: (id) => session.unregisterInFlight(id),
    },
    identity,
  );
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(response));
}

async function dispatchSingle(
  frame: JsonRpcFrame,
  session: SessionConnection,
  gateway: DispatchHost,
  identity: IngressIdentity | undefined,
): Promise<JsonRpcResponse | null> {
  if ("method" in frame && !("id" in frame)) {
    if (frame.method === "notifications/cancelled") {
      const params = frame.params as { requestId?: JsonRpcId } | undefined;
      if (params?.requestId !== undefined) {
        session.cancelInFlight(params.requestId);
      }
    }
    return null;
  }
  if ("id" in frame && "method" in frame) {
    return dispatchRequest(
      gateway,
      frame as JsonRpcRequest,
      {
        sendNotification: (n) => session.sendNotification(n),
        registerSubscription: (subId, unsubscribe) =>
          session.registerSubscription(subId, unsubscribe),
        unregisterSubscription: (subId) => session.unregisterSubscription(subId),
        registerInFlight: (id, abort) => session.registerInFlight(id, abort),
        unregisterInFlight: (id) => session.unregisterInFlight(id),
      },
      identity,
    );
  }
  return null;
}

// ============================================================================
// GET handler — persistent SSE notification channel
// ============================================================================

async function handleGet(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, SessionConnection>,
  sessionIdHeader: string | null,
  heartbeatMs: number,
  gateway: DispatchHost,
  authSource: AuthSource | undefined,
): Promise<void> {
  // Authenticate at stream-open (ADR 61). The notification stream
  // dispatches no requests, but a configured AuthSource must still gate
  // who may open it — fail closed.
  const authResult = await authenticateHttpRequest(req, authSource, sessionIdHeader ?? undefined);
  if (!authResult.ok) {
    writeUnauthorized(res);
    return;
  }

  const sessionId = sessionIdHeader ?? newSessionId();
  const session = sessions.get(sessionId) ?? new SessionConnection(sessionId, gateway);
  if (!sessions.has(sessionId)) sessions.set(sessionId, session);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Mcp-Session-Id": sessionId,
  });
  // Flush headers + write a leading comment so fetch resolves immediately;
  // without this, Node may not flush until the first real frame arrives,
  // and clients that await the response on connect() hang.
  res.flushHeaders();
  res.write(": connected\n\n");

  session.attachNotificationStream(res, heartbeatMs);
}

// ============================================================================
// DELETE handler
// ============================================================================

function handleDelete(sessions: Map<string, SessionConnection>, sessionId: string | null): void {
  if (!sessionId) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  void session.close();
  sessions.delete(sessionId);
}

// ============================================================================
// helpers
// ============================================================================

/**
 * Authenticate one HTTP crossing (ADR 61). Extracts the bearer token
 * from THIS request's `Authorization` header and runs the shared
 * ingress helper. Returns `{ ok: false }` on rejection (fail closed);
 * `{ ok: true, identity }` otherwise (identity undefined = local pole).
 */
async function authenticateHttpRequest(
  req: IncomingMessage,
  authSource: AuthSource | undefined,
  connectionId: string | undefined,
): Promise<{ ok: true; identity?: IngressIdentity } | { ok: false }> {
  const auth = req.headers.authorization;
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
  try {
    const ctx = await authenticateIngress(
      {
        transportKind: "http",
        credential: {
          kind: "bearer",
          ...(bearer !== undefined ? { token: bearer } : {}),
          headers: req.headers as Record<string, string | undefined>,
        },
        ...(connectionId !== undefined ? { connectionId } : {}),
      },
      authSource,
    );
    return ctx.identity !== undefined ? { ok: true, identity: ctx.identity } : { ok: true };
  } catch {
    return { ok: false };
  }
}

function writeUnauthorized(res: ServerResponse): void {
  res.statusCode = 401;
  res.setHeader("WWW-Authenticate", "Bearer");
  res.end();
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJsonError(res: ServerResponse, id: JsonRpcId | null, error: JsonRpcError): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, error }));
}

function newSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export type { DispatchHost };
