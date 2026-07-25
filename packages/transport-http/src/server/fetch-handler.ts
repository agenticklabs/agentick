/**
 * `fetchServerTransport(options)` — the EMBEDDED gateway entry door (C4.5).
 * A {@link ServerTransport} whose wire is a web-standard `(req: Request) =>
 * Promise<Response>`, mountable inside any fetch-native HTTP framework (Hono,
 * Nitro, Next.js route handlers, Bun/Deno servers, or Node via a framework's
 * fetch adapter). It is the FIFTH `ServerTransport` implementor, alongside
 * in-process / ws / http / unix — so the embedded door participates in the
 * gateway lifecycle exactly like the others:
 *
 * ```ts
 * import { fetchServerTransport } from "@agentick/transport-http/fetch";
 *
 * const { transport, handler } = fetchServerTransport({ identity });
 * app.all("/agentick/*", (c) => handler(c.req.raw)); // mount at app-setup time
 *
 * const gateway = await createGateway({ transports: [transport] });
 * await gateway.listen(); // binds the transport (fills the host slot)
 * // …
 * await gateway.close(); // sweeps every open SSE connection + unbinds
 * ```
 *
 * The `handler` is constructed BEFORE the gateway exists (so the adopter can
 * mount it in their framework's route table at setup time) and closes over a
 * host slot that `transport.listen(host)` fills — the one thing only the
 * gateway can supply (ADR 84 §2: wire config binds at construction, the host
 * at listen). Requests that arrive before `listen()` or after `close()` get an
 * honest `503` (the gateway enforces `listen()`-before-`createApp`, so
 * pre-listen traffic is a host-app ordering bug, never a silent queue).
 *
 * It is the same pipeline as {@link httpServer} — {@link dispatchRequest},
 * {@link resolveWebSecurity}, the {@link BaseConnectionContext} fan-out, the
 * SSE codec — behind a web-standard door instead of a Node `http.Server`.
 * Two things differ, and only two:
 *
 *   1. **Identity comes from the host, not a bearer table.** Standalone HTTP
 *      authenticates each request's `Authorization` header through an
 *      `AuthSource`. Embedded, the adopter's OWN auth already ran in their
 *      middleware; the {@link FetchHandlerOptions.identity} callback hands us
 *      the RESULT — an {@link Identity} (principal / user / scopes), NEVER
 *      tokens (credentials-never-cross-the-wire). Returning a `Response`
 *      short-circuits verbatim (their 401 / redirect). This IS the per-request
 *      ingress identity; it threads straight into dispatch.
 *   2. **There is no TCP peer to inspect.** A web `Request` exposes no socket
 *      address, so forwarded-header trust (`trustProxy`) is inert here — the
 *      adopter's framework terminates the connection and owns the network
 *      boundary. The `Host` / `Origin` / CSRF defenses still run against the
 *      request headers (security applies MORE when embedded, not less: serve
 *      under a real hostname and you MUST configure `allowedHosts`).
 *
 * **Security is ON by default, even embedded (fail closed).** With no
 * `identity` callback every request is REFUSED (401) — a missing identity
 * resolver is a misconfiguration, not an invitation to run as the trusted
 * local pole. The single documented opt-out is `security: "host-managed"`:
 * the adopter attests their host framework gates access, and requests then
 * run as the local pole (silent relaxation is the opencode CVE class, so it
 * must be named).
 *
 * @see docs/proposals/v2/north-star.md — the embedded-mode block (C4.5)
 * @see docs/proposals/v2/STATUS.md — ROADMAP C4.5
 */

import {
  ErrorCode,
  IngressAuthRequired,
  WireRpcError,
  type IngressIdentity,
  type JsonRpcFrame,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type ServerTransport,
} from "@agentick/spec";
import {
  BaseConnectionContext,
  CSRF_HEADER,
  dispatchRequest,
  resolveWebSecurity,
  type DispatchHost,
  type WebRequestLike,
  type WebSecurityOptions,
  type WebSecurityPolicy,
} from "@agentick/transport";
import { encodeSseFrame } from "../shared/sse.js";

/**
 * The resolved caller identity the host's auth hands us — the SAME shape as
 * every other ingress edge stamps ({@link IngressIdentity}): `principal`
 * (ADR-48 event stamping), `user` (the adopter-shaped `RuntimeContextUser`,
 * `ctx.user` everywhere), `scopes` (fed to the authorizer). NEVER tokens —
 * token material stays in the adopter's `identity` callback; only the
 * resolved identity crosses into dispatch.
 */
export type Identity = IngressIdentity;

/** The web-standard handler {@link fetchServerTransport} returns. */
export type FetchHandler = (req: Request) => Promise<Response>;

/**
 * What {@link fetchServerTransport} returns: the {@link ServerTransport} the
 * gateway owns (`createGateway({ transports: [transport] })`) and the
 * {@link FetchHandler} the adopter mounts in their framework. The two share
 * one host slot + session map — `listen`/`close` on the transport bind and
 * sweep exactly the state the handler serves.
 */
export interface FetchServerTransport {
  readonly transport: ServerTransport;
  readonly handler: FetchHandler;
}

export interface FetchHandlerOptions extends WebSecurityOptions {
  /**
   * The host's existing auth, piggybacked. Runs per request BEFORE dispatch.
   * Return an {@link Identity} to proceed (it threads into dispatch as the
   * ingress identity); return a `Response` to SHORT-CIRCUIT — the caller
   * receives it verbatim (the adopter's own 401 / redirect) and NOTHING
   * reaches dispatch. Omitted → every request is refused unless
   * {@link security} is `"host-managed"` (fail closed).
   */
  readonly identity?: (req: Request) => Identity | Response | Promise<Identity | Response>;
  /**
   * Security ownership. Default (omitted): AGENTICK owns the boundary —
   * `Host` / `Origin` / CSRF defenses run and an {@link identity} callback is
   * REQUIRED (absent → every request refused). `"host-managed"`: the ADOPTER
   * attests their host framework gates access — the web-security checks are
   * skipped and, absent an {@link identity} callback, requests run as the
   * trusted local pole. A supplied `identity` callback is still honored under
   * `"host-managed"` (stamp principals while managing transport security
   * yourself).
   */
  readonly security?: "host-managed";
  /**
   * Restrict handling to requests whose pathname starts with this prefix
   * (404 otherwise). Omitted → handle every request the adopter routes here
   * (the common case — their framework already matched `/agentick/*`).
   */
  readonly path?: string;
  /** Idle ping interval on the GET notification stream (ms). Default 30s. */
  readonly heartbeatIntervalMs?: number;
}

const SESSION_ID_HEADER = "mcp-session-id";

export function fetchServerTransport(options: FetchHandlerOptions = {}): FetchServerTransport {
  const security = resolveWebSecurity(options);
  const hostManaged = options.security === "host-managed";
  const identityFn = options.identity;
  const heartbeatMs = options.heartbeatIntervalMs ?? 30_000;
  const pathPrefix = options.path;

  // Bound-host slot: null until `listen(host)`, null again after `close()`.
  // The handler reads it per request; a null slot is the not-listening state.
  let host: DispatchHost | null = null;
  // Per-session-id fan-out state, keyed exactly like the Node server's map.
  const sessions = new Map<string, FetchSessionConnection>();

  const handler: FetchHandler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (pathPrefix !== undefined && !url.pathname.startsWith(pathPrefix)) {
      return new Response(null, { status: 404 });
    }

    // Not bound (pre-listen / post-close) — refuse honestly with a 503. The
    // gateway binds this transport at `gateway.listen()` and sweeps it at
    // `gateway.close()`; a request outside that window is a host-app ordering
    // bug surfaced, never silently queued.
    if (!host) return notListening();
    // Pin the bound host for THIS request: the slot is a closure `let` that a
    // concurrent `close()` could null between the guard and a later `await`, so
    // an in-flight request completes against the host it was admitted under
    // (control-flow narrowing on the captured `let` is otherwise lost at await).
    const boundHost: DispatchHost = host;

    const reqLike = toWebRequestLike(req);

    // ── Web-security (skipped only under host-managed). Host allow-list +
    // cross-site rejection first (fail closed BEFORE the CSRF token issues),
    // then the CSRF gate on mutations — the Node server's order.
    let cors: Record<string, string> | undefined;
    if (!hostManaged) {
      const access = security.checkAccess(reqLike);
      if (!access.ok) return new Response(null, { status: access.status ?? 403 });
      cors = security.corsHeadersFor(req.headers.get("origin") ?? undefined, reqLike);
    }

    // One responder per request closes over the security posture; every reply
    // below is `respond.json(...)` / `respond.sse(id)` — no header threading.
    const respond = makeResponder(security, hostManaged, cors);

    if (req.method === "OPTIONS")
      return new Response(null, { status: 204, headers: respond.headers() });

    if (!hostManaged) {
      const csrf = security.checkCsrf(reqLike);
      if (!csrf.ok) return new Response(null, { status: csrf.status ?? 403 });
    }

    // ── Identity (ADR 61 embedded edge). A returned Response short-circuits;
    // absent callback fails closed unless host-managed (then: local pole).
    let identity: Identity | undefined;
    if (identityFn) {
      const resolved = await identityFn(req);
      if (resolved instanceof Response) return resolved;
      identity = resolved;
    } else if (!hostManaged) {
      return respond.refusal();
    }

    const sessionIdHeader = req.headers.get(SESSION_ID_HEADER);

    switch (req.method) {
      case "POST":
        return handlePost(req, sessions, sessionIdHeader, boundHost, identity, respond);
      case "GET": {
        const accept = req.headers.get("accept") ?? "";
        if (!accept.includes("text/event-stream")) return new Response(null, { status: 406 });
        return handleGet(sessions, sessionIdHeader, boundHost, heartbeatMs, respond);
      }
      case "DELETE":
        handleDelete(sessions, sessionIdHeader);
        return new Response(null, { status: 204, headers: respond.headers() });
      default:
        return new Response(null, { status: 405 });
    }
  };

  const transport: ServerTransport = {
    id: "http:fetch",

    // Fill the host slot (ADR 84 §2). Idempotent while bound: a second
    // `listen()` with the same or a different host is a safe no-op.
    listen(gateway): Promise<void> {
      if (!host) host = gateway;
      return Promise.resolve();
    },

    // Unbind + sweep every live connection: `FetchSessionConnection.close()`
    // runs `closeWire()` (clears the heartbeat, closes the SSE controller),
    // then the map is dropped so a re-`listen()` starts fresh. Idempotent:
    // closing an unbound / already-closed transport resolves without error.
    async close(): Promise<void> {
      if (!host) return;
      host = null;
      for (const session of sessions.values()) {
        try {
          await session.close();
        } catch {
          // best effort — one connection's teardown must not block the rest
        }
      }
      sessions.clear();
    },
  };

  return { transport, handler };
}

// ============================================================================
// Responder — per-request reply factory over one security posture
// ============================================================================

/**
 * Every admitted reply carries the same envelope headers — the session id, the
 * per-process CSRF token (issued so the client bootstrap reads it), and any
 * allowlisted CORS headers. The responder closes over the request's resolved
 * `security` / `hostManaged` / `cors` so the routing helpers name only the
 * reply body, never re-thread the posture.
 */
interface Responder {
  /** Envelope headers for a reply (optionally stamping the session id). */
  headers(sessionId?: string): Record<string, string>;
  /** A `200 application/json` reply. */
  json(body: unknown, sessionId?: string): Response;
  /** SSE stream headers (`text/event-stream`, keep-alive) + the envelope. */
  sse(sessionId: string): Record<string, string>;
  /** The fail-closed `401` with the typed {@link IngressAuthRequired} body. */
  refusal(): Response;
}

function makeResponder(
  security: WebSecurityPolicy,
  hostManaged: boolean,
  cors: Record<string, string> | undefined,
): Responder {
  const headers = (sessionId?: string): Record<string, string> => {
    const h: Record<string, string> = {};
    if (sessionId !== undefined) h["Mcp-Session-Id"] = sessionId;
    if (!hostManaged && security.csrfEnabled) h[CSRF_HEADER] = security.csrfToken;
    if (cors) Object.assign(h, cors);
    return h;
  };
  return {
    headers,
    json: (body, sessionId) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json", ...headers(sessionId) },
      }),
    sse: (sessionId) => ({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      ...headers(sessionId),
    }),
    refusal: () => {
      // Security is on and no `identity` callback was supplied — a
      // misconfiguration surfaced as an authentication requirement, never a
      // silent local-pole admission (fail closed, ADR 61 / C4.5).
      const error = new IngressAuthRequired({ backend: "embedded" });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: error.toJSON() }), {
        status: 401,
        headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer", ...headers() },
      });
    },
  };
}

// ============================================================================
// FetchSessionConnection — per-session-id server state (web-standard sink)
// ============================================================================

/**
 * The web-standard twin of the Node server's `SessionConnection`. Holds ONLY
 * shared fan-out state (subscriptions, in-flight registry, notification
 * stream) — never an identity (each request stamps its own, no cross-request
 * bleed). Notifications route to the GET stream's `ReadableStream` controller
 * rather than a Node `ServerResponse`.
 */
class FetchSessionConnection extends BaseConnectionContext {
  readonly id: string;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private readonly encoder = new TextEncoder();

  constructor(id: string, gateway: DispatchHost) {
    super(gateway);
    this.id = id;
  }

  attachStream(controller: ReadableStreamDefaultController<Uint8Array>, heartbeatMs: number): void {
    // A second GET stream on the same session id supersedes the first.
    if (this.controller) this.detachStream();
    this.controller = controller;
    this.write(": connected\n\n");
    this.heartbeat = setInterval(() => this.write(": ping\n\n"), heartbeatMs);
  }

  detachStream(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.controller) {
      try {
        this.controller.close();
      } catch {
        /* already closed */
      }
      this.controller = null;
    }
  }

  private write(text: string): void {
    if (!this.controller) return;
    try {
      this.controller.enqueue(this.encoder.encode(text));
    } catch {
      // Stream closed/errored underfoot — drop the frame and let the reader's
      // cancel() drive teardown.
      this.controller = null;
    }
  }

  /** Notifications go on the persistent GET SSE stream, not the POST reply. */
  override sendNotification(notification: { method: string; params?: unknown }): void {
    this.write(
      encodeSseFrame({ jsonrpc: "2.0", method: notification.method, params: notification.params }),
    );
  }

  /** No single outbound wire for HTTP — each POST writes its own reply. */
  protected sendFrame(_frame: JsonRpcFrame): void {
    /* unused; sendNotification routes to the GET stream */
  }

  protected closeWire(): void {
    this.detachStream();
  }
}

// ============================================================================
// POST — JSON-RPC request → response (single, batch, or streaming SSE)
// ============================================================================

async function handlePost(
  req: Request,
  sessions: Map<string, FetchSessionConnection>,
  sessionIdHeader: string | null,
  gateway: DispatchHost,
  identity: Identity | undefined,
  respond: Responder,
): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await req.text());
  } catch {
    return respond.json({
      jsonrpc: "2.0",
      id: null,
      error: { code: ErrorCode.ParseError, message: "invalid JSON" },
    });
  }

  const sessionId = sessionIdHeader ?? newSessionId();
  const session = acquire(sessions, sessionId, gateway);

  if (Array.isArray(parsed)) {
    const responses: JsonRpcResponse[] = [];
    for (const frame of parsed) {
      const r = await dispatchSingle(frame, session, gateway, identity);
      if (r !== null) responses.push(r);
    }
    return respond.json(responses, sessionId);
  }

  const frame = parsed as JsonRpcFrame;

  // Notifications (no id) — no response. `notifications/cancelled` routes into
  // the in-flight abort registry, exactly like the Node server.
  if ("method" in frame && !("id" in frame)) {
    if (frame.method === "notifications/cancelled") {
      const params = frame.params as { requestId?: JsonRpcId } | undefined;
      if (params?.requestId !== undefined) session.cancelInFlight(params.requestId);
    }
    return new Response(null, { status: 204, headers: respond.headers(sessionId) });
  }

  if (!("id" in frame) || !("method" in frame)) {
    return respond.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: ErrorCode.InvalidRequest, message: "frame must be a JSON-RPC request" },
      },
      sessionId,
    );
  }

  const request = frame as JsonRpcRequest;
  const params = request.params as { _meta?: { progressToken?: string } } | undefined;
  const isStreaming = typeof params?._meta?.progressToken === "string";

  if (isStreaming) {
    // Progress notifications ride THIS response's SSE body (not the GET
    // channel); the final JSON-RPC response is the terminal frame.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const response = await dispatchRequest(
          gateway,
          request,
          {
            ...session.defaultSink(),
            sendNotification: (n) =>
              controller.enqueue(
                encoder.encode(
                  encodeSseFrame({ jsonrpc: "2.0", method: n.method, params: n.params }),
                ),
              ),
          },
          identity,
        );
        controller.enqueue(encoder.encode(encodeSseFrame(response)));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: respond.sse(sessionId) });
  }

  const response = await dispatchRequest(gateway, request, session.defaultSink(), identity);
  return respond.json(response, sessionId);
}

async function dispatchSingle(
  frame: JsonRpcFrame,
  session: FetchSessionConnection,
  gateway: DispatchHost,
  identity: Identity | undefined,
): Promise<JsonRpcResponse | null> {
  if ("method" in frame && !("id" in frame)) {
    if (frame.method === "notifications/cancelled") {
      const params = frame.params as { requestId?: JsonRpcId } | undefined;
      if (params?.requestId !== undefined) session.cancelInFlight(params.requestId);
    }
    return null;
  }
  if ("id" in frame && "method" in frame) {
    return dispatchRequest(gateway, frame as JsonRpcRequest, session.defaultSink(), identity);
  }
  return null;
}

// ============================================================================
// GET — persistent SSE notification channel (the subscription stream)
// ============================================================================

function handleGet(
  sessions: Map<string, FetchSessionConnection>,
  sessionIdHeader: string | null,
  gateway: DispatchHost,
  heartbeatMs: number,
  respond: Responder,
): Response {
  const sessionId = sessionIdHeader ?? newSessionId();
  const session = acquire(sessions, sessionId, gateway);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      session.attachStream(controller, heartbeatMs);
    },
    cancel() {
      // Reader.cancel() (client disconnect / teardown) detaches the stream and
      // stops the heartbeat; the session's subscriptions are released on
      // DELETE or gateway close.
      session.detachStream();
    },
  });

  return new Response(stream, { status: 200, headers: respond.sse(sessionId) });
}

// ============================================================================
// DELETE — terminate a session's fan-out state
// ============================================================================

function handleDelete(
  sessions: Map<string, FetchSessionConnection>,
  sessionId: string | null,
): void {
  if (!sessionId) return;
  const session = sessions.get(sessionId);
  if (!session) return;
  void session.close();
  sessions.delete(sessionId);
}

// ============================================================================
// helpers
// ============================================================================

function acquire(
  sessions: Map<string, FetchSessionConnection>,
  sessionId: string,
  gateway: DispatchHost,
): FetchSessionConnection {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created = new FetchSessionConnection(sessionId, gateway);
  sessions.set(sessionId, created);
  return created;
}

/**
 * The structural slice of a web `Request` the security policy reads. `socket`
 * is deliberately absent: an embedded handler has no TCP peer to inspect, so
 * forwarded-header trust is inert (the adopter's framework owns the network
 * boundary — the C4.5 trust handoff).
 */
function toWebRequestLike(req: Request): WebRequestLike {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return { method: req.method, headers };
}

function newSessionId(): string {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The not-listening refusal (pre-`listen()` / post-`close()`). `503` at the
 * transport layer + a typed JSON-RPC error body — the same `InvalidRequest`
 * code the gateway's own `GatewayClosedError` / `GatewayNotStartedError` map to
 * on the wire (`agentickErrorToWireCode`), so a closed/not-yet-started gateway
 * reads identically whether the frame reached dispatch or was refused here.
 */
function notListening(): Response {
  const error = new WireRpcError(
    ErrorCode.InvalidRequest,
    "gateway transport is not accepting requests (not listening)",
    { reason: "not-listening" },
  );
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: error.code, message: error.message, data: error.data },
    }),
    { status: 503, headers: { "Content-Type": "application/json" } },
  );
}

export type { DispatchHost };
