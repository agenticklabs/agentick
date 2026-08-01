/**
 * Server-side wire-frame dispatcher. Transport-agnostic — every
 * `@agentick/transport-<edge>/server` package (`-http`, `-websocket`,
 * `-unix-socket`, `-in-process`) consumes the same `dispatchRequest` to
 * translate JSON-RPC frames into `GatewayHarnessProtocol` method calls.
 *
 * The edge is spelled `<edge>` rather than as a `*` glob deliberately: a `*`
 * immediately before the `/server` subpath closes this block comment, and the
 * rest of the doc text is then parsed as code.
 */

export { dispatchRequest, type DispatchHost, type DispatchSink } from "./dispatch.js";
export { projectClientResult, projectClientNotification } from "./client-projection.js";
export { admitSubscriptionId, BaseConnectionContext } from "./connection-context.js";
export {
  authenticateIngress,
  DEFAULT_INGRESS_AUTHN_TIMEOUT_MS,
  IngressAuthnTimeout,
  type IngressAuthnOptions,
  type IngressRejectionReporter,
} from "./ingress.js";
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
