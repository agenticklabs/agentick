/**
 * `httpTransport({ port })` — server-side Streamable HTTP transport.
 *
 * A **multi-connection** listener (unlike stdio / in-memory, which
 * deliver exactly one connection). Mounts a Node `http.Server` and, for
 * each MCP session, creates an SDK `StreamableHTTPServerTransport` and
 * hands it to the harness via `accept(sdkTransport, info)` — awaited for
 * backpressure. The harness owns SDK-`Server` construction + the
 * security pipeline; this transport owns the wire (session routing,
 * `Mcp-Session-Id` dispatch, listener lifecycle).
 *
 * Session model (Streamable HTTP, stateful):
 *   - A POST with no `Mcp-Session-Id` header + an `initialize` body
 *     opens a new session. We construct one SDK transport, `accept` it
 *     (harness wires an SDK Server), then let the SDK transport process
 *     the request — it generates the session id + emits it on the
 *     response. `onsessioninitialized` registers the transport in our
 *     per-session map.
 *   - Subsequent requests (POST / GET-SSE / DELETE) carry the
 *     `Mcp-Session-Id`; we route them straight to the owning SDK
 *     transport's `handleRequest`. The SDK owns id generation +
 *     resumability; we own the routing table.
 *   - `onsessionclosed` (DELETE) prunes the map. `close()` stops the
 *     listener + tears down every live session.
 *
 * The SDK transport parses / validates the body itself; we read the
 * POST body once (to distinguish a new-session `initialize` from a
 * stray sessionless request) and pass it back through `handleRequest`
 * as `parsedBody` so it isn't read twice.
 *
 * OAuth resource-server discovery (RFC 9728): when `oauth.metadata` is
 * configured the transport also answers `GET
 * /.well-known/oauth-protected-resource` with the protected-resource
 * metadata document, so clients can locate the authorization server.
 * Discovery is served unauthenticated — that is its purpose.
 *
 * HTTP auth pre-gate (RFC 9728 challenge). When the harness threads an
 * {@link AuthPreGate} whose `enforce` is set AND `oauth` is configured
 * here, EVERY inbound MCP request (POST rpc, GET events stream) is
 * verified at the HTTP crossing BEFORE the SDK sees it — a failed or
 * absent credential gets `401 + WWW-Authenticate: Bearer
 * resource_metadata="…"` (the discovery challenge the SDK's committed
 * `200` makes impossible from inside a request handler). The well-known
 * metadata endpoint is exempt (discovery must work unauthenticated).
 * Without `oauth` configured, the pre-gate stays dormant and behavior is
 * unchanged (per-operation security pipeline only). Token verification
 * itself still lives in the adopter's `Authenticator` — the pre-gate
 * runs that same stage; it does not introduce a parallel one.
 * See {@link OAuthTransportOptions}.
 *
 * @see ./types.ts for the `ServerTransport` + `AcceptHandler` + `AuthPreGate` contract
 */

import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { OAuthProtectedResourceMetadata } from "@modelcontextprotocol/sdk/shared/auth.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { McpConnectionInfo } from "../security/stages.js";
import type { AcceptHandler, AuthPreGate, ServerTransport } from "./types.js";

const DEFAULT_PATH = "/mcp";
/** Reject POST bodies larger than this before buffering the whole thing. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** RFC 9728 well-known prefix for OAuth Protected Resource Metadata. */
const PROTECTED_RESOURCE_WELL_KNOWN = "/.well-known/oauth-protected-resource";

/**
 * Server-side OAuth resource-server discovery options (MCP authorization
 * spec / RFC 9728). This is the *discovery + challenge* half of a
 * spec-compliant OAuth resource server — the transport serves the
 * protected-resource metadata document so clients can locate the
 * authorization server. Token **verification** is NOT the transport's
 * job: that stays in the adopter's `Authenticator` security stage
 * (`bearerTokenAuth` + a custom verify callback). Capability, not
 * opinion — the framework serves discovery; the adopter verifies.
 *
 * @see https://datatracker.ietf.org/doc/html/rfc9728
 */
export interface OAuthTransportOptions {
  /**
   * The RFC 9728 Protected Resource Metadata document to serve. When
   * provided, the transport answers `GET
   * /.well-known/oauth-protected-resource` (and the RFC-9728
   * path-suffixed variant derived from `metadata.resource`) with this
   * JSON document. Reuse the SDK's `OAuthProtectedResourceMetadata`
   * shape (`@modelcontextprotocol/sdk/shared/auth.js`) to build it.
   */
  readonly metadata?: OAuthProtectedResourceMetadata;

  /**
   * URL populating the `resource_metadata` parameter of the
   * `WWW-Authenticate: Bearer resource_metadata="…"` challenge the HTTP
   * pre-gate emits on a `401`. Set this when the protected-resource
   * metadata is hosted ELSEWHERE (a separate authorization service) than
   * this transport. When omitted but `metadata` is served here, the
   * challenge URL is derived from `metadata.resource` (the well-known
   * path on the resource's origin). When neither is available and the
   * pre-gate fires, the `401` carries a bare `WWW-Authenticate: Bearer` (RFC 6750 MUST; a
   * bare challenge — there is nothing to point a client at).
   *
   * @see https://datatracker.ietf.org/doc/html/rfc9728 §5.1
   */
  readonly resourceMetadataUrl?: string;
}

export interface HttpTransportOptions {
  /**
   * Port to listen on. `0` (or omitted) binds an ephemeral port — read
   * it back via {@link HttpServerTransportHandle.address}. Ignored when
   * a caller-supplied `server` is provided.
   */
  readonly port?: number;

  /** Interface to bind. Defaults to Node's default (all interfaces). */
  readonly host?: string;

  /** URL path the MCP endpoint is mounted at. Defaults to `/mcp`. */
  readonly path?: string;

  /**
   * Caller-supplied `http.Server` to mount on (e.g. an existing Express
   * server). When provided, `port` / `host` are ignored, the listener
   * is attached via `server.on("request", …)`, and `close()` only
   * detaches the listener — the caller owns the server's lifecycle.
   * When omitted, a fresh server is created + owned (closed on
   * `close()`).
   */
  readonly server?: HttpServer;

  /**
   * Session id generator. Defaults to `randomUUID`. Override to mint
   * JWTs / hashes per the MCP spec's uniqueness + secrecy requirement.
   */
  readonly sessionIdGenerator?: () => string;

  /**
   * When `true`, the SDK transport returns JSON responses instead of
   * opening SSE streams. Useful for simple request/response clients.
   * Defaults to `false` (SSE preferred).
   */
  readonly enableJsonResponse?: boolean;

  /**
   * OAuth resource-server discovery (MCP authorization spec / RFC 9728).
   * When `oauth.metadata` is provided, the transport serves the
   * protected-resource metadata document at the well-known path(s).
   * @see {@link OAuthTransportOptions}
   */
  readonly oauth?: OAuthTransportOptions;
}

/**
 * A {@link ServerTransport} plus an `address()` accessor. Tests binding
 * an ephemeral port (`port: 0`) read the resolved port back after
 * `listen()`.
 */
export interface HttpServerTransportHandle extends ServerTransport {
  /**
   * The bound address, or `null` before `listen()` / after `close()`
   * (or when a caller-supplied server isn't bound to a port).
   */
  address(): AddressInfo | null;
}

/** Collapse a possibly-array header value to a single string. */
function headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

/** Buffer + JSON-parse a request body, enforcing a size cap. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Build the connection snapshot the security pipeline's guard sees. */
function buildConnectionInfo(req: IncomingMessage): McpConnectionInfo {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key] = headerString(value);
  }
  const info: {
    transportKind: string;
    remoteAddress?: string;
    origin?: string;
    headers: Record<string, string | undefined>;
  } = {
    transportKind: "http",
    headers,
  };
  const remoteAddress = req.socket.remoteAddress;
  if (remoteAddress !== undefined) info.remoteAddress = remoteAddress;
  const origin = headerString(req.headers.origin);
  if (origin !== undefined) info.origin = origin;
  return info;
}

/**
 * Derive the RFC 9728 well-known path(s) at which a protected-resource
 * metadata document is served, from its `resource` identifier.
 *
 * Mirrors the SDK's `getOAuthProtectedResourceMetadataUrl`
 * (`@modelcontextprotocol/sdk/server/auth/router.js`) — reimplemented
 * inline because that module's type surface imports `express`, which is
 * not a dependency of this package (importing it would break `tsc`).
 *
 * Serves both the bare well-known path and the path-suffixed variant
 * (RFC 9728 §3.1) so that clients using either discovery convention
 * resolve the document. The two collapse to one when `resource` has no
 * path component.
 *
 * @example
 *   resource "https://api.example.com/mcp"
 *   → { "/.well-known/oauth-protected-resource",
 *       "/.well-known/oauth-protected-resource/mcp" }
 */
function protectedResourcePaths(resource: string): Set<string> {
  const paths = new Set<string>([PROTECTED_RESOURCE_WELL_KNOWN]);
  try {
    const rsPath = new URL(resource).pathname;
    if (rsPath && rsPath !== "/") {
      paths.add(`${PROTECTED_RESOURCE_WELL_KNOWN}${rsPath}`);
    }
  } catch {
    // A malformed `resource` yields only the bare well-known path.
  }
  return paths;
}

/**
 * Derive the absolute `resource_metadata` challenge URL from a
 * protected-resource `resource` identifier — the well-known document
 * URL on the resource's own origin (RFC 9728 §3.1 path-suffixed form).
 * Matches the path this transport serves the document at.
 *
 * @example
 *   "https://api.example.com/mcp"
 *   → "https://api.example.com/.well-known/oauth-protected-resource/mcp"
 */
function deriveResourceMetadataUrl(resource: string): string | undefined {
  try {
    const u = new URL(resource);
    const suffix = u.pathname && u.pathname !== "/" ? u.pathname : "";
    return `${u.origin}${PROTECTED_RESOURCE_WELL_KNOWN}${suffix}`;
  } catch {
    return undefined;
  }
}

/**
 * Emit the RFC 9728 `401` discovery challenge. When a
 * `resource_metadata` URL is available the `WWW-Authenticate` header
 * points the client at the protected-resource metadata document;
 * otherwise the bare `Bearer` scheme is sent with no params —
 * RFC 6750 §3 makes `WWW-Authenticate` a MUST on a protected
 * resource's 401, even when there is nothing further to discover.
 */
function writeUnauthorized(res: ServerResponse, resourceMetadataUrl: string | undefined): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "WWW-Authenticate":
      resourceMetadataUrl !== undefined
        ? `Bearer resource_metadata="${resourceMetadataUrl}"`
        : "Bearer",
  };
  res.writeHead(401, headers);
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    }),
  );
}

/** Emit a minimal JSON-RPC error response (no live session to route through). */
function writeJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message },
      id: null,
    }),
  );
}

export function httpTransport(options: HttpTransportOptions = {}): HttpServerTransportHandle {
  const path = options.path ?? DEFAULT_PATH;
  const ownsServer = options.server === undefined;

  // OAuth resource-server discovery (RFC 9728). When a metadata
  // document is configured, resolve the well-known path(s) it is served
  // at, keyed off its `resource` identifier.
  const oauthMetadata = options.oauth?.metadata;
  const oauthPaths =
    oauthMetadata !== undefined
      ? protectedResourcePaths(oauthMetadata.resource)
      : new Set<string>();

  // HTTP auth pre-gate config (RFC 9728). `oauthConfigured` is the
  // transport's half of the enforcement split — the pre-gate fires only
  // when oauth is configured here AND the harness marks the authenticator
  // real (`gate.enforce`). `challengeUrl` populates the `resource_metadata`
  // parameter: an explicit `resourceMetadataUrl`, else derived from the
  // served `metadata.resource`, else `undefined` (bare 401, no header).
  const oauthConfigured = options.oauth !== undefined;
  const challengeUrl =
    options.oauth?.resourceMetadataUrl ??
    (oauthMetadata !== undefined ? deriveResourceMetadataUrl(oauthMetadata.resource) : undefined);

  /** Live SDK transports keyed by `Mcp-Session-Id`. */
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  let server: HttpServer | null = null;
  let requestListener: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  let closed = false;

  const handle = async (
    accept: AcceptHandler,
    gate: AuthPreGate | undefined,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");

    // OAuth Protected Resource Metadata (RFC 9728). Served at the
    // well-known path(s) when `oauth.metadata` is configured — a plain
    // GET of the JSON document, no MCP session involved.
    if (oauthMetadata !== undefined && oauthPaths.has(url.pathname)) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "Content-Type": "application/json", Allow: "GET, HEAD" });
        res.end(JSON.stringify({ error: "method_not_allowed" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(req.method === "HEAD" ? undefined : JSON.stringify(oauthMetadata));
      return;
    }

    if (url.pathname !== path) {
      // Shared-server citizenship: only an owned server answers foreign
      // paths (with 404). When attached to a caller-supplied server we
      // claim ONLY our own paths and leave everything else untouched so
      // the caller's other request listeners can handle it.
      if (ownsServer) {
        writeJsonRpcError(res, 404, `Not found: ${url.pathname}`);
      }
      return;
    }

    // HTTP auth pre-gate (RFC 9728 discovery challenge). Runs on the MCP
    // path only — the well-known discovery endpoint and foreign paths
    // already returned above. Fires only under the enforcement split:
    // oauth configured here AND the harness marked the authenticator
    // real. On failure the crossing is rejected with a `401` BEFORE the
    // SDK transport is touched, so the `WWW-Authenticate` challenge can
    // actually reach the wire. The per-operation pipeline still runs
    // downstream (defense in depth — the pre-gate authenticates the
    // crossing; the pipeline authorizes each operation).
    if (oauthConfigured && gate?.enforce) {
      const authenticated = await gate.verify(buildConnectionInfo(req));
      if (!authenticated) {
        writeUnauthorized(res, challengeUrl);
        return;
      }
    }

    const sessionId = headerString(req.headers["mcp-session-id"]);

    // Existing session → route straight to its SDK transport.
    if (sessionId !== undefined) {
      const existing = sessions.get(sessionId);
      if (existing === undefined) {
        writeJsonRpcError(res, 404, `Unknown session: ${sessionId}`);
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    // No session id: only a POST carrying an `initialize` opens one.
    if (req.method !== "POST") {
      writeJsonRpcError(res, 400, "Missing Mcp-Session-Id header");
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      writeJsonRpcError(res, 400, `Invalid request body: ${String(err)}`);
      return;
    }
    if (!isInitializeRequest(body)) {
      writeJsonRpcError(res, 400, "Missing Mcp-Session-Id header (non-initialize request)");
      return;
    }

    // New session. Build the SDK transport, hand it to the harness
    // (await = backpressure + SDK-Server wiring), then let it process
    // the initialize — that mints the session id + registers us via
    // `onsessioninitialized`.
    const sdkTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: options.sessionIdGenerator ?? (() => randomUUID()),
      onsessioninitialized: (sid) => {
        sessions.set(sid, sdkTransport);
      },
      onsessionclosed: (sid) => {
        sessions.delete(sid);
      },
      ...(options.enableJsonResponse !== undefined
        ? { enableJsonResponse: options.enableJsonResponse }
        : {}),
    });

    if (closed) {
      writeJsonRpcError(res, 503, "Server shutting down");
      return;
    }

    await accept(sdkTransport, buildConnectionInfo(req));
    await sdkTransport.handleRequest(req, res, body);
  };

  return {
    kind: "http",

    async listen(accept: AcceptHandler, gate?: AuthPreGate): Promise<void> {
      if (closed) {
        throw new Error("httpTransport: cannot listen after close()");
      }
      requestListener = (req, res): void => {
        void handle(accept, gate, req, res).catch((err) => {
          if (!res.headersSent) {
            writeJsonRpcError(res, 500, `Internal transport error: ${String(err)}`);
          } else {
            res.end();
          }
        });
      };

      if (options.server !== undefined) {
        server = options.server;
        server.on("request", requestListener);
        return;
      }

      server = createServer(requestListener);
      const s = server;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          s.removeListener("error", onError);
          reject(err);
        };
        s.once("error", onError);
        s.listen(options.port ?? 0, options.host, () => {
          s.removeListener("error", onError);
          resolve();
        });
      });
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;

      // Stop accepting new connections (detach our listener).
      if (server !== null && requestListener !== null) {
        server.removeListener("request", requestListener);
      }

      // Tear down live sessions FIRST — this closes their SSE streams.
      // Must precede `server.close()`, which otherwise blocks waiting
      // for those very streams to drain.
      for (const sdkTransport of sessions.values()) {
        try {
          await sdkTransport.close();
        } catch {
          // Best-effort: a failing close shouldn't block teardown.
        }
      }
      sessions.clear();

      // Close the owned server (caller-supplied servers stay up — the
      // caller owns their lifecycle; we only detached our listener).
      if (ownsServer && server !== null) {
        const s = server;
        // Drop any lingering idle keep-alive sockets so `close()`
        // resolves promptly (Node 18.2+; guarded for older runtimes).
        s.closeAllConnections?.();
        await new Promise<void>((resolve) => {
          s.close(() => resolve());
        });
      }

      requestListener = null;
      server = null;
    },

    address(): AddressInfo | null {
      const addr = server?.address();
      if (addr === null || addr === undefined || typeof addr === "string") return null;
      return addr;
    },
  };
}
