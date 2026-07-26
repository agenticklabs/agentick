/**
 * Server-side transport factories + the `ServerTransport` contract.
 *
 *   stdioTransport()          — process stdin/stdout pair (one connection)
 *   inMemoryServerTransport() — test pair with explicit `connect()` helper
 *   httpTransport({ port })   — Streamable HTTP listener (multi-connection)
 *
 * Future (#171f):
 *   wsTransport({ port })     — WebSocket listener (multi-connection)
 */

export type { AcceptHandler, ServerTransport, ServerTransportFactory } from "./types.js";
export { stdioTransport } from "./stdio.js";
export { inMemoryServerTransport, type InMemoryServerTransportHandle } from "./in-memory.js";
export {
  httpTransport,
  type HttpTransportOptions,
  type HttpServerTransportHandle,
  type OAuthTransportOptions,
} from "./http.js";
