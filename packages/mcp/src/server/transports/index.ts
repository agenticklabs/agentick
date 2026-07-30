/**
 * Server-side transport factories + the `ServerTransport` contract.
 *
 *   stdioTransport()             — process stdin/stdout pair (one connection)
 *   inMemoryServerTransport()    — test pair with explicit `connect()` helper
 *   httpTransport({ port })      — Streamable HTTP listener (multi-connection)
 *   httpMiddlewareTransport()    — Streamable HTTP mount door (host-owned server)
 *   inMemoryEventStore()         — bounded SSE resumability store for either HTTP shape
 *
 * Future (#171f):
 *   wsTransport({ port })     — WebSocket listener (multi-connection)
 */

export type {
  AcceptHandler,
  AuthPreGate,
  ServerTransport,
  ServerTransportFactory,
} from "./types.js";
export { stdioTransport } from "./stdio.js";
export { inMemoryServerTransport, type InMemoryServerTransportHandle } from "./in-memory.js";
export {
  httpTransport,
  httpMiddlewareTransport,
  type HttpTransportOptions,
  type HttpServerTransportHandle,
  type HttpMiddlewareTransportOptions,
  type HttpMiddlewareTransportHandle,
  type OAuthTransportOptions,
} from "./http.js";
export {
  inMemoryEventStore,
  DEFAULT_MAX_EVENTS,
  type InMemoryEventStoreOptions,
} from "./event-store.js";
