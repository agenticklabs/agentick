/**
 * High-level Unix-socket cluster factories. Mirror of
 * `tcp-cluster.ts` with filesystem-path addressing instead of
 * host:port.
 *
 *   - `unixBroker(opts)` — spins up a broker on a socket path.
 *     Cleans up stale predecessor sockets automatically.
 *   - `unixClusterNode(opts)` — multiplexed transport + membership
 *     over one Unix-socket connection.
 *   - `unixTransport` / `unixMembership` — standalone factories.
 *   - `defineUnixCluster(spec)` — top-level convenience.
 *
 * @see ./tcp-cluster.ts (TCP equivalent)
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

import { createUnixConnector } from "./unix-connector.js";
import { createUnixListener } from "./unix-listener.js";

// ============================================================================
// Shared options
// ============================================================================

export interface UnixEndpoint {
  /** Filesystem path to the Unix socket. Required. */
  readonly socketPath: string;
  /** Optional max frame bytes per connection. */
  readonly maxFrameBytes?: number;
}

// ============================================================================
// unixBroker — convenience for the broker-elected process
// ============================================================================

export interface UnixBrokerOptions extends UnixEndpoint {
  /** Optional codec. Default: bundled JSON. */
  readonly codec?: ClusterCodec;
  /**
   * Filesystem permission mode (e.g., `0o600` for owner-only).
   * Applied via `fs.chmod` after bind.
   */
  readonly mode?: number;
  /**
   * Auto-unlink a stale socket file before binding. Default `true`.
   * Set `false` when a supervisor (PM2 / systemd) handles cleanup.
   */
  readonly cleanupStaleSocket?: boolean;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export interface RunningUnixBroker {
  readonly broker: BaseBroker;
  readonly listener: Listener;
  close(): Promise<void>;
}

export async function unixBroker(opts: UnixBrokerOptions): Promise<RunningUnixBroker> {
  const listener = createUnixListener({
    socketPath: opts.socketPath,
    ...(opts.maxFrameBytes !== undefined ? { maxFrameBytes: opts.maxFrameBytes } : {}),
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.cleanupStaleSocket !== undefined
      ? { cleanupStaleSocket: opts.cleanupStaleSocket }
      : {}),
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
// unixClusterNode — multiplexed transport + membership
// ============================================================================

export interface UnixClusterNodeOptions extends UnixEndpoint {
  readonly nodeId: NodeId;
  readonly codec?: ClusterCodec;
  readonly heartbeatMs?: number;
  readonly missedPongLimit?: number;
  readonly reconnect?: {
    readonly initialMs?: number;
    readonly maxMs?: number;
    readonly maxAttempts?: number;
  };
  /** Connection-establishment timeout. Default 2s (Unix is local). */
  readonly connectTimeoutMs?: number;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export function unixClusterNode(opts: UnixClusterNodeOptions): {
  readonly transport: ClusterTransportFactory;
  readonly membership: ClusterMembershipFactory;
} {
  let client: BaseClusterClient | null = null;

  function ensureClient(parent: ClusterParent): BaseClusterClient {
    if (client) return client;
    const c = new BaseClusterClient({
      nodeId: opts.nodeId,
      connector: createUnixConnector({
        socketPath: opts.socketPath,
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
      // No-op — shared client's close is wired through parent.onClose.
    },
  };
}

// ============================================================================
// Individual factories (two-connection trade-off path)
// ============================================================================

export function unixTransport(opts: UnixClusterNodeOptions): ClusterTransportFactory {
  return unixClusterNode(opts).transport;
}

export function unixMembership(opts: UnixClusterNodeOptions): ClusterMembershipFactory {
  return unixClusterNode(opts).membership;
}

// ============================================================================
// defineUnixCluster — top-level convenience
// ============================================================================

export interface DefineUnixClusterOptions extends UnixClusterNodeOptions {
  readonly partitioning?: ClusterPartitioningFactory;
  readonly journal?: DurableJournalFactory;
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

export function defineUnixCluster(opts: DefineUnixClusterOptions): ClusterFactory {
  const node = unixClusterNode(opts);
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
// Internals
// ============================================================================

function defaultCodec(): ClusterCodec {
  return jsonCodec()({} as never);
}
