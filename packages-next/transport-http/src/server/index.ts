/**
 * Streamable HTTP server adapter — mounts on a Node `http.Server` and
 * dispatches JSON-RPC frames to a `GatewayHarness` via the shared
 * `dispatchRequest`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export {
  httpServer,
  type HttpServerOptions,
  type HttpServerHandle,
  type DispatchHost,
} from "./server.js";
