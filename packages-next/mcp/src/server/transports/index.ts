/**
 * Server-side transport factories + the `ServerTransport` contract.
 *
 *   stdioTransport()          — process stdin/stdout pair (one connection)
 *   inMemoryServerTransport() — test pair with explicit `connect()` helper
 *
 * Future (#171e/f):
 *   httpTransport({ port })  — Streamable HTTP listener (multi-connection)
 *   wsTransport({ port })    — WebSocket listener (multi-connection)
 */

export type { AcceptHandler, ServerTransport, ServerTransportFactory } from "./types.js";
export { stdioTransport } from "./stdio.js";
export { inMemoryServerTransport, type InMemoryServerTransportHandle } from "./in-memory.js";
