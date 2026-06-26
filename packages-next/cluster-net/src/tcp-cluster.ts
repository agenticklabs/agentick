/**
 * High-level TCP cluster factories.
 *
 *   - `tcpBroker(opts)` — convenience that spins up a `BaseBroker` on
 *     a TCP listener. Adopters call this in their broker-elected
 *     process (e.g., the PM2 master, or whichever wins the
 *     auto-elect race). Returns the started broker + the underlying
 *     server for explicit lifecycle.
 *
 *   - `tcpClusterNode(opts)` — bundles a `ClusterTransportFactory` +
 *     `ClusterMembershipFactory` over ONE multiplexed connection.
 *     Adopters who use `defineCluster` directly destructure this:
 *
 *         const { transport, membership } = tcpClusterNode({...});
 *         defineCluster({ nodeId, transport, membership, ... });
 *
 *   - `tcpTransport(opts)` + `tcpMembership(opts)` — the
 *     individually-callable factories. Each opens its own
 *     `BaseClusterClient` (= its own TCP connection). Adopters who
 *     want one multiplexed connection use `tcpClusterNode` instead;
 *     these exist for the manual composition path with the
 *     two-connection trade-off documented.
 *
 *   - `defineTcpCluster(spec)` — top-level convenience returning a
 *     `ClusterFactory`. Wraps `defineCluster + tcpClusterNode`.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §6
 */

import type {
  ClusterCodec,
  ClusterFactory,
  ClusterMembership,
  ClusterMembershipFactory,
  ClusterParent,
  ClusterPartitioningFactory,
  ClusterTransportFactory,
  DurableJournalFactory,
  MembershipChange,
  NodeId,
} from "@agentick/cluster-next";
import { defineCluster, jsonCodec } from "@agentick/cluster-next";
import { BaseBroker, BaseClusterClient, type Listener } from "@agentick/cluster-broker-next";

import { tryBindOrConnect } from "./auto-elect.js";
import { createTcpConnector } from "./tcp-connector.js";
import { createTcpListener } from "./tcp-listener.js";

// ============================================================================
// Shared options
// ============================================================================

export interface TcpEndpoint {
  /** Bind/connect host. Default: `"127.0.0.1"` (loopback). */
  readonly host?: string;
  /** Bind/connect port. Required. */
  readonly port: number;
  /** Optional max frame bytes per inbound connection. */
  readonly maxFrameBytes?: number;
}

// ============================================================================
// tcpBroker — convenience for the broker-elected process
// ============================================================================

export interface TcpBrokerOptions extends TcpEndpoint {
  /** Optional codec. Default: bundled JSON. */
  readonly codec?: ClusterCodec;
  /** Optional diagnostic emitter; bridges into the parent's local bus. */
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export interface RunningTcpBroker {
  readonly broker: BaseBroker;
  readonly listener: Listener;
  close(): Promise<void>;
}

/**
 * Create + start a broker on `host:port`. Caller is responsible for
 * calling `close()` to release the socket. For auto-elect (race to
 * bind), use `tryBindOrConnect` + adopt the server into the
 * listener; this helper assumes the adopter has decided to be the
 * broker.
 */
export async function tcpBroker(opts: TcpBrokerOptions): Promise<RunningTcpBroker> {
  const listener = createTcpListener({
    host: opts.host,
    port: opts.port,
    ...(opts.maxFrameBytes !== undefined ? { maxFrameBytes: opts.maxFrameBytes } : {}),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
  const broker = new BaseBroker({
    listener,
    codec: opts.codec ?? defaultCodec(),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
  await broker.start();
  return {
    broker,
    listener,
    async close() {
      await broker.close();
    },
  };
}

// ============================================================================
// tcpClusterNode — multiplexed transport + membership
// ============================================================================

export interface TcpClusterNodeOptions extends TcpEndpoint {
  /** This node's identity in the cluster. Required. */
  readonly nodeId: NodeId;
  /** Optional codec. Default: bundled JSON. */
  readonly codec?: ClusterCodec;
  /** Heartbeat interval (ms). Default 30s. */
  readonly heartbeatMs?: number;
  /** Missed pong limit before declaring dead. Default 3. */
  readonly missedPongLimit?: number;
  /** Reconnect backoff knobs; see BaseClusterClientOptions. */
  readonly reconnect?: {
    readonly initialMs?: number;
    readonly maxMs?: number;
    readonly maxAttempts?: number;
  };
  /** Connection-establishment timeout per attempt (ms). Default 5s. */
  readonly connectTimeoutMs?: number;
  /** Optional diagnostic emitter. */
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

/**
 * Bundle a `ClusterTransport` + `ClusterMembership` factory pair
 * backed by ONE underlying `BaseClusterClient` (= one TCP
 * connection). Both factories MUST be invoked against the same
 * `ClusterParent` (the caller passes both into `defineCluster`).
 */
export function tcpClusterNode(opts: TcpClusterNodeOptions): {
  readonly transport: ClusterTransportFactory;
  readonly membership: ClusterMembershipFactory;
} {
  let client: BaseClusterClient | null = null;

  function ensureClient(parent: ClusterParent): BaseClusterClient {
    if (client) return client;
    const c = new BaseClusterClient({
      nodeId: opts.nodeId,
      connector: createTcpConnector({
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        port: opts.port,
        ...(opts.maxFrameBytes !== undefined ? { maxFrameBytes: opts.maxFrameBytes } : {}),
        ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
        ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
      }),
      codec: opts.codec ?? defaultCodec(),
      ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
      ...(opts.missedPongLimit !== undefined ? { missedPongLimit: opts.missedPongLimit } : {}),
      ...(opts.reconnect !== undefined ? { reconnect: opts.reconnect } : {}),
      ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
    });
    client = c;
    parent.onClose(() => c.close());
    return c;
  }

  return {
    transport: (parent) => ensureClient(parent),
    membership: (parent) => clientToMembership(ensureClient(parent), opts.nodeId),
  };
}

/** Wrap a BaseClusterClient's membership accessors as a ClusterMembership. */
function clientToMembership(client: BaseClusterClient, currentNode: NodeId): ClusterMembership {
  return {
    currentNode,
    async nodes() {
      return client.nodes();
    },
    onChange(handler: (change: MembershipChange) => void) {
      const detach = client.onMembershipChange(handler);
      return async () => detach();
    },
    async close() {
      // The shared client's close is wired through parent.onClose
      // by ensureClient. Membership-side close is a no-op so the
      // transport doesn't get torn down on a partial close.
    },
  };
}

// ============================================================================
// Individual factories (two-connection trade-off path)
// ============================================================================

/**
 * Standalone TCP transport — opens its own `BaseClusterClient` (=
 * one TCP connection). Use `tcpClusterNode` instead when you also
 * want a paired membership over the same connection.
 */
export function tcpTransport(opts: TcpClusterNodeOptions): ClusterTransportFactory {
  return tcpClusterNode(opts).transport;
}

/**
 * Standalone TCP membership — opens its own `BaseClusterClient`.
 * If paired with `tcpTransport` of the same options, you end up
 * with TWO connections per node — use `tcpClusterNode` to share.
 */
export function tcpMembership(opts: TcpClusterNodeOptions): ClusterMembershipFactory {
  return tcpClusterNode(opts).membership;
}

// ============================================================================
// defineTcpCluster — top-level convenience
// ============================================================================

export interface DefineTcpClusterOptions extends TcpClusterNodeOptions {
  readonly partitioning?: ClusterPartitioningFactory;
  readonly journal?: DurableJournalFactory;
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

/**
 * One-shot factory that bundles `defineCluster + tcpClusterNode`.
 * Adopters write:
 *
 *     const cluster = defineTcpCluster({
 *       nodeId: () => process.env.NODE_ID ?? `auto-${process.pid}`,
 *       host: "127.0.0.1",
 *       port: 9876,
 *     });
 *     // ... pass `cluster` to createGateway / createApp ...
 */
export function defineTcpCluster(opts: DefineTcpClusterOptions): ClusterFactory {
  const node = tcpClusterNode(opts);
  return defineCluster({
    nodeId: opts.nodeId,
    transport: node.transport,
    membership: node.membership,
    ...(opts.partitioning !== undefined ? { partitioning: opts.partitioning } : {}),
    ...(opts.journal !== undefined ? { journal: opts.journal } : {}),
    ...(opts.codec !== undefined ? { codec: () => opts.codec! } : {}),
    ...(opts.fanoutMode !== undefined ? { fanoutMode: opts.fanoutMode } : {}),
  });
}

// ============================================================================
// Re-exports of auto-elect for adopters writing custom topology
// ============================================================================

export { tryBindOrConnect } from "./auto-elect.js";
export type { AutoElectMode, AutoElectOptions, AutoElectResult } from "./auto-elect.js";

// ============================================================================
// Internals
// ============================================================================

function defaultCodec(): ClusterCodec {
  // Construct the bundled JSON codec by invoking its factory once
  // against a no-op parent — the codec has no lifecycle so this is
  // safe and matches how cluster-next composes it internally.
  return jsonCodec()({} as never);
}
