/**
 * High-level Unix-socket cluster factories. Mirror of `tcp-cluster.ts`
 * with filesystem-path addressing instead of host:port. Wire-specific
 * concerns (socket path, fs mode, stale-cleanup) live in
 * `unix-listener.ts` / `unix-connector.ts`. The shared
 * `{ xBroker, xClusterNode, defineXCluster }` scaffolding lives in
 * `@agentick/cluster-broker-next` (`wire-helpers.ts`).
 *
 *   - `unixBroker(opts)` — broker on a socket path; cleans stale
 *     predecessor sockets.
 *   - `unixClusterNode(opts)` — `{transport, membership}` factory pair.
 *   - `unixTransport` / `unixMembership` — standalone factories.
 *   - `defineUnixCluster(spec)` — top-level convenience.
 *
 * @see ./tcp-cluster.ts (TCP equivalent)
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §6
 */

import {
  resolveNodeId,
  type ClusterCodec,
  type ClusterFactory,
  type ClusterMembershipFactory,
  type ClusterPartitioningFactory,
  type ClusterTransportFactory,
  type DurableJournalFactory,
  type NodeId,
} from "@agentick/cluster-next";
import {
  createClusterNode,
  defineWireCluster,
  startBroker,
  type ClusterNodeFactories,
  type RunningBroker,
} from "@agentick/cluster-broker-next";

import { createUnixConnector } from "./unix-connector.js";
import { createUnixListener } from "./unix-listener.js";
import { omitUndefined } from "@agentick/utils-next";

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

export type RunningUnixBroker = RunningBroker;

export async function unixBroker(opts: UnixBrokerOptions): Promise<RunningUnixBroker> {
  const listener = createUnixListener({
    socketPath: opts.socketPath,
    ...omitUndefined({
      maxFrameBytes: opts.maxFrameBytes,
      mode: opts.mode,
      cleanupStaleSocket: opts.cleanupStaleSocket,
      onDiagnostic: opts.onDiagnostic,
    }),
  });
  return startBroker({
    listener,
    ...omitUndefined({ codec: opts.codec, onDiagnostic: opts.onDiagnostic }),
  });
}

// ============================================================================
// unixClusterNode — multiplexed transport + membership
// ============================================================================

export interface UnixClusterNodeOptions extends UnixEndpoint {
  /**
   * This node's identity. Required at the wire-factory level — the
   * adopter-facing `defineUnixCluster(...)` / `joinUnixCluster(...)`
   * facades accept this as OPTIONAL and resolve via
   * {@link resolveNodeId} before reaching this layer.
   */
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

export function unixClusterNode(opts: UnixClusterNodeOptions): ClusterNodeFactories {
  return createClusterNode({
    nodeId: opts.nodeId,
    connector: createUnixConnector({
      socketPath: opts.socketPath,
      ...omitUndefined({
        maxFrameBytes: opts.maxFrameBytes,
        connectTimeoutMs: opts.connectTimeoutMs,
        onDiagnostic: opts.onDiagnostic,
      }),
    }),
    ...omitUndefined({
      codec: opts.codec,
      heartbeatMs: opts.heartbeatMs,
      missedPongLimit: opts.missedPongLimit,
      reconnect: opts.reconnect,
      onDiagnostic: opts.onDiagnostic,
    }),
  });
}

export function unixTransport(opts: UnixClusterNodeOptions): ClusterTransportFactory {
  return unixClusterNode(opts).transport;
}

export function unixMembership(opts: UnixClusterNodeOptions): ClusterMembershipFactory {
  return unixClusterNode(opts).membership;
}

// ============================================================================
// defineUnixCluster — top-level convenience
// ============================================================================

export interface DefineUnixClusterOptions extends Omit<UnixClusterNodeOptions, "nodeId"> {
  /**
   * This node's identity. Optional — defaults to `${hostname}:${pid}`
   * via {@link resolveNodeId}. A `cluster:nodeId:auto-defaulted` or
   * `cluster:nodeId:suspicious` diagnostic fires on the supplied
   * `onDiagnostic` sink at construction time.
   */
  readonly nodeId?: NodeId;
  readonly partitioning?: ClusterPartitioningFactory;
  readonly journal?: DurableJournalFactory;
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

export function defineUnixCluster(opts: DefineUnixClusterOptions): ClusterFactory {
  // Resolve nodeId once at the public boundary, then pass the
  // concrete value to BOTH the wire factory and defineWireCluster.
  // If they diverge, routing breaks (broker thinks node is "X",
  // inbox thinks node is "Y").
  const nodeId = resolveNodeId(opts.nodeId, opts.onDiagnostic);
  return defineWireCluster({
    nodeId,
    node: unixClusterNode({ ...opts, nodeId }),
    ...omitUndefined({
      codec: opts.codec,
      partitioning: opts.partitioning,
      journal: opts.journal,
      fanoutMode: opts.fanoutMode,
    }),
  });
}
