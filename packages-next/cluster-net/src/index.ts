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
export { tryBindOrConnect, tryBindOrConnectUnix } from "./auto-elect.js";
export type {
  AutoElectMode,
  AutoElectOptions,
  AutoElectResult,
  AutoElectUnixOptions,
} from "./auto-elect.js";

// Unix-socket wire (Phase 4d). Same Node `net` module as TCP; only
// the bind address shape differs. Multi-platform note: Unix sockets
// don't exist on Windows in the traditional sense (Windows has
// named pipes which differ enough to need their own impl). Adopters
// on Windows should use the TCP factories.
export { createUnixListener, type UnixListenerOptions } from "./unix-listener.js";
export { createUnixConnector, type UnixConnectorOptions } from "./unix-connector.js";
export {
  defineUnixCluster,
  unixBroker,
  unixClusterNode,
  unixMembership,
  unixTransport,
  type DefineUnixClusterOptions,
  type RunningUnixBroker,
  type UnixBrokerOptions,
  type UnixClusterNodeOptions,
  type UnixEndpoint,
} from "./unix-cluster.js";

// Internal re-election (Phase 4f.3) — single-host failover. Surviving
// workers race to bind the vacated socket after K consecutive connect
// failures; winner becomes new broker.
export {
  electableUnixClusterNode,
  type ElectableUnixClusterNode,
  type ElectableUnixClusterNodeOptions,
} from "./unix-re-election.js";

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
