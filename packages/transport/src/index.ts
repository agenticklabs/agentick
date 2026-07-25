/**
 * `@agentick/transport` — shared plumbing every transport
 * package depends on.
 *
 *   - `BaseClientTransport` (abstract) — RPC correlation, stream
 *     registries, state machine, notification routing. Subclasses
 *     fill in connection-management + frame-send.
 *   - `MultiplexedStream<T>` — bounded-soon AsyncIterable used for
 *     subscription + progress streams.
 *   - `dispatchRequest` — server-side JSON-RPC → harness method
 *     dispatcher. Transport-agnostic.
 *   - `DispatchHost` / `DispatchSink` — contract between dispatcher
 *     and per-transport connection adapter.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export * from "./client/index.js";
export * from "./server/index.js";
export { staticTokenAuthSource, type StaticTokenAuthSourceOptions } from "./server/auth-source.js";
