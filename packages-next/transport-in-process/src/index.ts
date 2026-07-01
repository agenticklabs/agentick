/**
 * `@agentick/transport-in-process-next` — direct-call `ClientTransport`
 * for same-process client ↔ gateway communication.
 *
 * Bypasses serialization entirely: frame payloads pass by reference.
 * For tests, embedded library deploys, and same-process TUI / daemon
 * shapes (tentickle-class agents).
 *
 * Optional `wireParity: true` test mode routes payloads through
 * `JSON.parse(JSON.stringify(...))` so wire-shape regressions surface
 * at test time without paying the cost in production.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md §"The transports"
 */

export {
  inProcessTransport,
  type InProcessTransportOptions,
  type InProcessGatewayHandler,
} from "./transport.js";
export {
  withHandshake,
  buildHandshakeInitializeResult,
  buildHandshakeExtensionsListResult,
  type WithHandshakeOverrides,
} from "./handshake.js";
