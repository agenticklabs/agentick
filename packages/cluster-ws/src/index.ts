/**
 * `@agentick/cluster-ws` — WebSocket cluster transport.
 *
 * Concrete wire impl on top of `@agentick/cluster-broker` and
 * the `ws` library. Two deployment modes:
 *
 *   - **Mount-on-httpServer** (gateway-level) — attaches an upgrade
 *     handler to the adopter's existing `http.Server`. Cluster
 *     traffic shares the port with HTTP API / static / etc.
 *   - **Standalone** (app-level) — owns its own `http.Server` on
 *     a dedicated port.
 *
 * Negotiates the `agentick-cluster-v1` subprotocol on the upgrade
 * handshake — forward-compatible for future protocol versions.
 *
 * Unlike TCP/Unix, no length-prefix framing is needed: WebSocket
 * preserves message boundaries natively. The Connection wrapper
 * passes binary frames straight through.
 */

export { AGENTICK_CLUSTER_SUBPROTOCOL, type WsListenerOptions } from "./ws-shared.js";
export { wsToConnection, type WsConnectionOptions } from "./ws-connection.js";
export { createWsListener } from "./ws-listener.js";
export { createWsConnector, type WsConnectorOptions } from "./ws-connector.js";

export {
  defineWsCluster,
  wsBroker,
  wsClusterNode,
  wsMembership,
  wsTransport,
  type DefineWsClusterOptions,
  type RunningWsBroker,
  type WsBrokerOptions,
  type WsClusterNodeOptions,
} from "./ws-cluster.js";

// High-level ergonomic facade. Wraps broker-bring-up + multiplexed
// client + lifecycle in one call. Wire-agnostic plumbing (bus,
// membership.waitForPeers, lifecycle) lives in
// `@agentick/cluster` as `makeClusterNode`; this is the
// WS-specific compose-and-go entry point.
export { joinWsCluster, type JoinWsClusterOptions } from "./join-ws-cluster.js";

// Re-export wire-agnostic facade types from @agentick/cluster so adopters
// don't need to reach across two packages just to type a returned
// `ClusterNode`.
export type { BusFacade, ClusterNode, MembershipFacade } from "@agentick/cluster";
