/**
 * `@agentick/transport-websocket-next/server` — server-side WebSocket
 * adapter that mounts on a `GatewayHarness`.
 *
 * Per-connection state (auth context, active subscriptions, in-flight
 * RPC ids) is a shape-1 extension concern per ADR 32 — but for now
 * this ships as a plain `websocketServer({ httpServer, gateway })`
 * factory; the `GatewayExtension` wrapper around it is a small follow-up.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

export {
  websocketServer,
  type WebSocketServerOptions,
  type WebSocketServerHandle,
} from "./server.js";
export type { DispatchHost } from "@agentick/transport-base-next";
