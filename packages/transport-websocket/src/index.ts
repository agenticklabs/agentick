/**
 * `@agentick/transport-websocket` — WebSocket transport. This barrel is the
 * NODE door: it re-exports client + server so a process that owns both sides
 * can `import { websocket, websocketServer }` from one place.
 *
 * A bundler resolving with the `browser` condition gets `./client` for this
 * same specifier — the server half reaches `node:http`/`ws` and cannot be
 * bundled. So the obvious import works in both environments and `./client` /
 * `./server` stay available for explicit, condition-independent targeting.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export {
  websocket,
  type KeepalivePolicy,
  type ReconnectPolicy,
  type WebSocketTransportOptions,
} from "./client/index.js";

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
