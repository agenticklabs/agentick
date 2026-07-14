/**
 * `ServerTransport` — the server-side symmetry of {@link ClientTransport}.
 *
 * The client side has a stateful `ClientTransport` that `connect()`s a wire
 * and issues RPCs; the server side has a `ServerTransport` that binds a wire
 * and routes inbound frames into the gateway. Both are the loose seam made
 * uniform: the gateway owns a set of `ServerTransport`s exactly as a client
 * owns a `ClientTransport`.
 *
 * Lives in spec because multiple packages implement it
 * (`@agentick/transport-in-process-next`, `@agentick/transport-websocket-next`,
 * `@agentick/transport-http-next`, `@agentick/transport-unix-socket-next`),
 * and `@agentick/gateway-next` consumes it (fans out `listen`/`close`).
 *
 * **Wire config binds at construction, not at `listen()`.** A WS server needs
 * a port/TLS; a Unix socket needs a path; in-process needs nothing. That
 * variance is closed over in each transport's factory — exactly as Node splits
 * `http.createServer(opts)` from `server.listen(port)`. The one thing every
 * transport needs at listen-time that only the gateway can supply is the host
 * ({@link GatewayHarnessProtocol}, the gateway itself), so `listen(host)` is
 * uniform across every transport. Concrete transports route each inbound frame
 * through `dispatchRequest(host, …)` (the wire seam, ADR 83 wire section).
 *
 * @see docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md §2
 * @see ./transport.ts sibling — the symmetric {@link ClientTransport}
 */

import type { GatewayHarnessProtocol } from "../protocol/gateway-harness.js";

export interface ServerTransport {
  /** Stable transport identity — used in logs and fan-out diagnostics. */
  readonly id: string;

  /**
   * Bind the wire and begin accepting connections, routing every inbound
   * frame through `dispatchRequest(host, …)`. The gateway injects itself as
   * the `host` at listen time — that is the one thing only the gateway can
   * supply; all wire-specific config (port/path/tls) is bound at the
   * transport's construction, so it never appears in this signature.
   *
   * Idempotent: a second `listen()` (with the same or a different host) is a
   * safe no-op while already bound.
   */
  listen(host: GatewayHarnessProtocol): Promise<void>;

  /**
   * Stop accepting and tear the wire down. Idempotent: closing an unbound or
   * already-closed transport resolves without error.
   */
  close(): Promise<void>;
}
