/**
 * `@agentick/cluster-net-next` — TCP + Unix-socket cluster transport.
 *
 * Concrete wire impl on top of `@agentick/cluster-broker-next`. Phase
 * 4b ships TCP; Phase 4d adds Unix socket factories alongside (same
 * underlying Node `net` module, different bind address).
 *
 * See README.md for the full API reference + Quick Start.
 */

// Low-level building blocks (wire-impl primitives + Listener/Connector adapters).
export { socketToConnection, type SocketConnectionOptions } from "./socket-connection.js";
export { createTcpListener, type TcpListenerOptions } from "./tcp-listener.js";
export { createTcpConnector, type TcpConnectorOptions } from "./tcp-connector.js";

// Broker election.
export { tryBindOrConnect } from "./auto-elect.js";
export type { AutoElectMode, AutoElectOptions, AutoElectResult } from "./auto-elect.js";

// High-level: broker convenience, multiplexed transport+membership, top-level cluster factory.
export {
  defineTcpCluster,
  tcpBroker,
  tcpClusterNode,
  tcpMembership,
  tcpTransport,
  type DefineTcpClusterOptions,
  type RunningTcpBroker,
  type TcpBrokerOptions,
  type TcpClusterNodeOptions,
  type TcpEndpoint,
} from "./tcp-cluster.js";
