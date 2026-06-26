/**
 * Wire-agnostic convenience helpers for concrete wire packages
 * (cluster-net-next, cluster-ws-next, future wires). Every wire's
 * `{ xBroker, xClusterNode, defineXCluster }` triple followed the
 * same shape; this module is the single source of truth for that
 * shape. Each wire's *-cluster.ts now does only the wire-specific
 * option-translation + listener/connector construction.
 *
 * What lives here:
 *
 *   - `startBroker(opts)`   — open BaseBroker around an already-built
 *                             Listener; return `{ broker, listener, close }`
 *   - `createClusterNode(opts)` — lazy BaseClusterClient + transport
 *                             /membership factories. Shared across
 *                             every wire.
 *   - `defineWireCluster(opts)` — top-level convenience: delegates to
 *                             `defineCluster` from `cluster-next` with
 *                             a pre-built node + optional partitioning
 *                             /journal/codec/fanoutMode.
 *
 * Wire-specific concerns (mount-on-httpServer, allowed-origins,
 * subprotocol, socket-mode, TCP host/port) live in each wire's
 * listener/connector module — those still differ.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §6
 */

import {
  createJsonCodec,
  defineCluster,
  type ClusterCodec,
  type ClusterFactory,
  type ClusterMembership,
  type ClusterMembershipFactory,
  type ClusterParent,
  type ClusterPartitioningFactory,
  type ClusterTransportFactory,
  type DurableJournalFactory,
  type MembershipChange,
  type NodeId,
} from "@agentick/cluster-next";

import { BaseBroker } from "./base-broker.js";
import { BaseClusterClient } from "./base-cluster-client.js";
import type { Connector, Listener } from "./connection.js";

// ============================================================================
// startBroker
// ============================================================================

/**
 * What every `xBroker(...)` returns. Wire-specific wrappers may extend
 * this with additional fields (port number for TCP-with-OS-assignment,
 * resolved socket path for Unix-stale-cleanup), but the canonical
 * shape is `{ broker, listener, close }`.
 */
export interface RunningBroker {
  readonly broker: BaseBroker;
  readonly listener: Listener;
  close(): Promise<void>;
}

export interface StartBrokerOptions {
  readonly listener: Listener;
  readonly codec?: ClusterCodec;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

/**
 * Open a `BaseBroker` around a pre-built `Listener` + start serving.
 * Returns the running broker bundle. Caller closes via the returned
 * `close()` (which closes broker + listener in order).
 */
export async function startBroker(opts: StartBrokerOptions): Promise<RunningBroker> {
  const broker = new BaseBroker({
    listener: opts.listener,
    codec: opts.codec ?? createJsonCodec(),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
  await broker.start();
  return {
    broker,
    listener: opts.listener,
    async close() {
      await broker.close();
    },
  };
}

// ============================================================================
// createClusterNode
// ============================================================================

/**
 * Common knobs every wire's `xClusterNode(...)` accepts. Wire-specific
 * options (URL, host/port, socket path) construct the `Connector`
 * before calling into here.
 */
export interface CreateClusterNodeOptions {
  readonly nodeId: NodeId;
  readonly connector: Connector;
  readonly codec?: ClusterCodec;
  readonly heartbeatMs?: number;
  readonly missedPongLimit?: number;
  readonly reconnect?: {
    readonly initialMs?: number;
    readonly maxMs?: number;
    readonly maxAttempts?: number;
  };
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

/**
 * The transport + membership factory pair every wire exposes. Both
 * factories share a single lazily-created `BaseClusterClient` — the
 * client's socket is opened once on first `parent.onClose` registration
 * and reused for both seams.
 */
export interface ClusterNodeFactories {
  readonly transport: ClusterTransportFactory;
  readonly membership: ClusterMembershipFactory;
}

/**
 * Construct the lazy {transport, membership} pair from a `Connector` +
 * client config. The shared `BaseClusterClient` is created on first
 * factory invocation and closed via `parent.onClose`.
 *
 * Multiplexing the two seams over one client connection (instead of
 * opening two sockets) is the design choice that makes every wire's
 * `xClusterNode` worth having as a unit — the alternative (two
 * separate factories opening two sockets) doubles the wire-level
 * connection count for no gain.
 */
export function createClusterNode(opts: CreateClusterNodeOptions): ClusterNodeFactories {
  let client: BaseClusterClient | null = null;

  function ensureClient(parent: ClusterParent): BaseClusterClient {
    if (client) return client;
    const c = new BaseClusterClient({
      nodeId: opts.nodeId,
      connector: opts.connector,
      codec: opts.codec ?? createJsonCodec(),
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

/**
 * Adapt a `BaseClusterClient` (which exposes broker-handshake
 * membership over its single socket) to the `ClusterMembership` seam.
 *
 * `close()` is a no-op here — the client's lifecycle is owned by the
 * `parent.onClose` registration in `createClusterNode`. Closing the
 * membership view doesn't close the underlying client (which the
 * transport seam still uses).
 */
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
      // No-op — client.close wired via parent.onClose in createClusterNode.
    },
  };
}

// ============================================================================
// defineWireCluster
// ============================================================================

/**
 * Options for the top-level `defineXCluster(...)` convenience. The
 * caller has already built the `{transport, membership}` pair via
 * `xClusterNode(...)`; this wrapper just plumbs it into
 * `defineCluster` from `cluster-next` along with optional
 * partitioning/journal/codec/fanoutMode.
 */
export interface DefineWireClusterOptions {
  readonly nodeId: NodeId | (() => NodeId | Promise<NodeId>);
  readonly node: ClusterNodeFactories;
  readonly codec?: ClusterCodec;
  readonly partitioning?: ClusterPartitioningFactory;
  readonly journal?: DurableJournalFactory;
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

/**
 * Wrap a `{transport, membership}` factory pair into a top-level
 * `ClusterFactory` via `defineCluster`. Each wire's `defineXCluster`
 * delegates here; this is where the shared option plumbing lives.
 */
export function defineWireCluster(opts: DefineWireClusterOptions): ClusterFactory {
  return defineCluster({
    nodeId: opts.nodeId,
    transport: opts.node.transport,
    membership: opts.node.membership,
    ...(opts.partitioning !== undefined ? { partitioning: opts.partitioning } : {}),
    ...(opts.journal !== undefined ? { journal: opts.journal } : {}),
    ...(opts.codec !== undefined ? { codec: () => opts.codec! } : {}),
    ...(opts.fanoutMode !== undefined ? { fanoutMode: opts.fanoutMode } : {}),
  });
}
