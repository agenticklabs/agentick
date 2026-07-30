/**
 * `@agentick/transport/client` — the BROWSER-SAFE door. Everything reachable
 * from here must run in a browser, so nothing under `server/` may be
 * re-exported and no `node:` builtin may be reached. Enforced by
 * `packages/spec-conformance/src/__tests__/client-entry-browser-safety.spec.ts`.
 */

export { CSRF_HEADER } from "../shared/wire.js";
export {
  BaseClientTransport,
  DEFAULT_KEEPALIVE_POLICY,
  DEFAULT_RECONNECT_POLICY,
  computeFullJitterBackoff,
  type ActiveSubscription,
  type KeepalivePolicy,
  type ReconnectPolicy,
} from "./base-transport.js";
export {
  MultiplexedStream,
  type BackpressurePolicy,
  type BackpressureOptions,
  type BackpressureError,
} from "./multiplexed-stream.js";
export { transportError } from "./transport-failure.js";
