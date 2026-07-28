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
 * This root barrel is the NODE-SIDE door: server dispatch, ingress
 * authentication, web security. `BaseClientTransport` and friends are behind
 * `@agentick/transport/client`, which is browser-safe. Re-exporting the client
 * surface here would let a browser bundle reach `node:crypto` by importing what
 * looks like the obvious barrel — it did, and it broke a webpack build.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export * from "./server/index.js";
export { staticTokenAuthSource, type StaticTokenAuthSourceOptions } from "./server/auth-source.js";
export * from "./shared/wire.js";
