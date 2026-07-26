/**
 * Server-side transport contract.
 *
 * Adopters call transport factories (`stdioTransport()`,
 * `inMemoryServerTransport()`, future `httpTransport({ port })`,
 * `wsTransport({ port })`) which return a `ServerTransport` for the
 * harness to mount. The harness owns lifecycle; each `accept` callback
 * delivers a fresh SDK `Transport` + `McpConnectionInfo` for one
 * connection.
 *
 * Single-connection transports (stdio, in-memory) deliver exactly one
 * Transport then resolve. Multi-connection transports (HTTP, WS — when
 * those land in #171e/f) keep listening + call `accept` per incoming
 * connection until `close()`.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type { McpConnectionInfo } from "../security/stages.js";

/**
 * Per-connection delivery callback. The harness wires this into the
 * transport at mount time; the transport calls it for each accepted
 * connection.
 *
 * The callback returns a `Promise<void>` that resolves when the
 * harness has finished setting up the SDK Server for this connection
 * (or rejected the connection). Transports MUST await this promise
 * before delivering the next connection to maintain backpressure.
 */
export type AcceptHandler = (transport: Transport, info: McpConnectionInfo) => Promise<void>;

/**
 * HTTP-level authentication pre-gate (MCP authorization spec / RFC 9728).
 *
 * The SDK's `StreamableHTTPServerTransport` commits a `200` (opens the
 * SSE stream / resolves the JSON promise) BEFORE any per-operation
 * `Authenticator` runs inside a request handler — so an auth rejection
 * there can only travel as a JSON-RPC error, never as `401 +
 * WWW-Authenticate`. The RFC 9728 discovery challenge therefore has to
 * be raised at the HTTP crossing, before the SDK sees the request. The
 * harness threads this pre-gate to network transports at `listen()`;
 * the transport runs it on every inbound request EXCEPT the unauthenticated
 * discovery endpoints, and challenges with a `401` on failure.
 *
 * Trusted transports (stdio, in-memory) ignore the pre-gate entirely —
 * they are trusted poles with no HTTP crossing to challenge.
 *
 * @see docs/proposals/v2/blueprint/40-mcp-server-harness.md §5
 * @see ../security/pipeline.ts — the per-operation pipeline the pre-gate complements
 */
export interface AuthPreGate {
  /**
   * True iff the resolved `Authenticator` is a real (non-`allowAll`)
   * stage. When `false`, the transport MUST NOT pre-gate — an open
   * deployment keeps current behavior (per-operation pipeline only).
   * The transport ANDs this with its own OAuth-configured state: the
   * pre-gate fires only when BOTH are true (the enforcement split).
   */
  readonly enforce: boolean;

  /**
   * Verify the crossing from the connection snapshot the transport
   * built (`headers` / `origin` / `remoteAddress` — the same
   * {@link McpConnectionInfo} the accept path carries). Resolves
   * `true` when the credential authenticates; `false` to challenge with
   * a `401`. Runs the server's configured `Authenticator` against a
   * minimal request context synthesized from `info`.
   */
  verify(info: McpConnectionInfo): Promise<boolean>;
}

/**
 * Server-side transport. Created by transport factories; mounted by
 * the harness's `start()`.
 *
 * Distinct from the SDK's `Transport` type — that's the per-connection
 * duplex; this is the listener / acceptor.
 */
export interface ServerTransport {
  /** Transport kind discriminator — matches the spec `McpServerTransportSpec.kind`. */
  readonly kind: string;

  /**
   * Listen for incoming connections. The harness wires `accept` to its
   * own connection-handling pipeline (security pipeline, SDK Server
   * construction, request-handler installation, tracking in
   * `connections()`).
   *
   * Resolves when listening has started (so callers know the server
   * is ready to accept). Does NOT block until close — connections
   * continue arriving via the callback.
   *
   * `gate` is the optional HTTP-level auth pre-gate (see
   * {@link AuthPreGate}). Network transports run it before handing a
   * crossing to the SDK; trusted transports (stdio, in-memory) ignore
   * it.
   */
  listen(accept: AcceptHandler, gate?: AuthPreGate): Promise<void>;

  /**
   * Stop accepting new connections + tear down listener resources.
   * Idempotent. Connections already established stay open until their
   * own transport-level close.
   */
  close(): Promise<void>;
}

/**
 * Factory that constructs a {@link ServerTransport}. Concrete factories
 * (`stdioTransport()`, `httpTransport({ port })`, ...) return one of
 * these. Adopters put the factory's RETURN VALUE in
 * `McpServerConfig.transports` — NOT the factory itself.
 */
export type ServerTransportFactory = () => ServerTransport;
