/**
 * `@agentick/transport-websocket/client` — WebSocket client
 * `ClientTransport`. Uses `globalThis.WebSocket` by default (Node 22+,
 * browser, Bun, Deno, edge runtimes). Accepts a constructor override
 * for adopters who want `ws` on older Node versions or need custom
 * headers in Node.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export { websocket, type WebSocketTransportOptions, type ReconnectPolicy } from "./transport.js";
