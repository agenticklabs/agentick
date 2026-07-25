/**
 * `@agentick/transport-websocket` — WebSocket transport. Re-exports
 * client + server entry points so adopters can `import { websocket,
 * websocketServer } from "@agentick/transport-websocket"` if they
 * want both in one place; the package's `./client` and `./server`
 * subpaths are the recommended import sites for bundle minimization.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export { websocket, type WebSocketTransportOptions, type ReconnectPolicy } from "./client/index.js";

export {
  websocketServer,
  webSocketServerTransport,
  type WebSocketServerOptions,
  type WebSocketServerHandle,
  type WebSocketServerTransportConfig,
  type WebSocketServerTransportPortConfig,
  type DispatchHost,
} from "./server/index.js";

export { AGENTICK_SUBPROTOCOL } from "./shared/codec.js";
