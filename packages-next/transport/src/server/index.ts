/**
 * Server-side wire-frame dispatcher. Transport-agnostic — every
 * `@agentick/transport-*-next/server` package consumes the same
 * `dispatchRequest` to translate JSON-RPC frames into
 * `GatewayHarnessProtocol` method calls.
 */

export { dispatchRequest, type DispatchHost, type DispatchSink } from "./dispatch.js";
export { BaseConnectionContext } from "./connection-context.js";
export { authenticateIngress } from "./ingress.js";
export {
  CSRF_HEADER,
  DEFAULT_BIND_HOST,
  isLoopbackAddress,
  resolveWebSecurity,
  type EffectivePeer,
  type WebRequestLike,
  type WebSecurityOptions,
  type WebSecurityPolicy,
  type WebSecurityVerdict,
} from "./web-security.js";
