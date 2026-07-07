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
 * @see ./types.ts for the `ServerTransport` + `AcceptHandler` contract
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
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import type { McpConnectionInfo } from "../security/stages.js";
import type { AcceptHandler, ServerTransport } from "./types.js";

const DEFAULT_PATH = "/mcp";
/** Reject POST bodies larger than this before buffering the whole thing. */
const MAX_BODY_BYTES = 4 * 1024 * 1024;

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

  /** Live SDK transports keyed by `Mcp-Session-Id`. */
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  let server: HttpServer | null = null;
  let requestListener: ((req: IncomingMessage, res: ServerResponse) => void) | null = null;
  let closed = false;

  const handle = async (
    accept: AcceptHandler,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== path) {
      writeJsonRpcError(res, 404, `Not found: ${url.pathname}`);
      return;
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

    async listen(accept: AcceptHandler): Promise<void> {
      if (closed) {
        throw new Error("httpTransport: cannot listen after close()");
      }
      requestListener = (req, res): void => {
        void handle(accept, req, res).catch((err) => {
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
