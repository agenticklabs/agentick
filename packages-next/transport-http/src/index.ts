/**
 * `@agentick/transport-http-next` — Streamable HTTP transport per
 * MCP 2025-03-26.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export { http, type HttpTransportOptions } from "./client/index.js";
export type { ReconnectPolicy } from "./client/transport.js";
export {
  httpServer,
  httpServerTransport,
  fetchServerTransport,
  type HttpServerOptions,
  type HttpServerHandle,
  type HttpServerTransportConfig,
  type HttpServerTransportPortConfig,
  type FetchHandler,
  type FetchHandlerOptions,
  type FetchServerTransport,
  type Identity,
  type DispatchHost,
} from "./server/index.js";
