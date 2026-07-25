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
   */
  listen(accept: AcceptHandler): Promise<void>;

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
