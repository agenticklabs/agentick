/**
 * High-level TCP cluster factories. Wire-specific concerns (host/port,
 * length-prefix framing, max-frame-bytes) live in `tcp-listener.ts` /
 * `tcp-connector.ts`. The shared `{ xBroker, xClusterNode,
 * defineXCluster }` scaffolding lives in
 * `@agentick/cluster-broker` (`wire-helpers.ts`).
 *
 *   - `tcpBroker(opts)` — `BaseBroker` on a TCP listener; adopter
 *     calls this in the broker-elected process.
 *   - `tcpClusterNode(opts)` — `{transport, membership}` factory pair
 *     sharing ONE multiplexed connection.
 *   - `tcpTransport(opts)` / `tcpMembership(opts)` — individually-
 *     callable factories. Pairing them opens TWO connections per
 *     node — use `tcpClusterNode` to share.
 *   - `defineTcpCluster(spec)` — top-level convenience returning a
 *     `ClusterFactory`.
 *
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
  type NodeIdInput,
} from "@agentick/cluster";
import {
  createClusterNode,
  defineWireCluster,
  startBroker,
  type ClusterNodeFactories,
  type RunningBroker,
} from "@agentick/cluster-broker";

import { createTcpConnector } from "./tcp-connector.js";
import { createTcpListener } from "./tcp-listener.js";
import { omitUndefined } from "@agentick/utils";

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

export type RunningTcpBroker = RunningBroker;

/**
 * Create + start a broker on `host:port`. Caller is responsible for
 * calling `close()` to release the socket. For auto-elect (race to
 * bind), use `tryBindOrConnect` + adopt the server into the listener;
 * this helper assumes the adopter has decided to be the broker.
 */
export async function tcpBroker(opts: TcpBrokerOptions): Promise<RunningTcpBroker> {
  const listener = createTcpListener({
    host: opts.host,
    port: opts.port,
    ...omitUndefined({ maxFrameBytes: opts.maxFrameBytes, onDiagnostic: opts.onDiagnostic }),
  });
  return startBroker({
    listener,
    ...omitUndefined({ codec: opts.codec, onDiagnostic: opts.onDiagnostic }),
  });
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
 * backed by ONE underlying `BaseClusterClient` (= one TCP connection).
 * Both factories MUST be invoked against the same `ClusterParent`
 * (the caller passes both into `defineCluster`).
 */
export function tcpClusterNode(opts: TcpClusterNodeOptions): ClusterNodeFactories {
  return createClusterNode({
    nodeId: opts.nodeId,
    connector: createTcpConnector({
      ...omitUndefined({ host: opts.host }),
      port: opts.port,
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

/**
 * Standalone TCP transport — opens its own `BaseClusterClient` (= one
 * TCP connection). Use `tcpClusterNode` instead when you also want a
 * paired membership over the same connection.
 */
export function tcpTransport(opts: TcpClusterNodeOptions): ClusterTransportFactory {
  return tcpClusterNode(opts).transport;
}

/**
 * Standalone TCP membership — opens its own `BaseClusterClient`. If
 * paired with `tcpTransport` of the same options, you end up with TWO
 * connections per node — use `tcpClusterNode` to share.
 */
export function tcpMembership(opts: TcpClusterNodeOptions): ClusterMembershipFactory {
  return tcpClusterNode(opts).membership;
}

// ============================================================================
// defineTcpCluster — top-level convenience
// ============================================================================

export interface DefineTcpClusterOptions extends Omit<TcpClusterNodeOptions, "nodeId"> {
  /**
   * This node's identity. Optional — defaults to `${hostname}:${pid}`
   * via {@link resolveNodeId}. Accepts either a literal string or a
   * synchronous thunk (e.g. `() => process.env.NODE_ID ?? generateId()`).
   * A `cluster:nodeId:auto-defaulted` or `cluster:nodeId:suspicious`
   * diagnostic fires on the supplied `onDiagnostic` sink at
   * construction time.
   */
  readonly nodeId?: NodeIdInput;
  readonly partitioning?: ClusterPartitioningFactory;
  readonly journal?: DurableJournalFactory;
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

/**
 * One-shot factory that bundles `defineCluster + tcpClusterNode`.
 * Adopters write:
 *
 *     const cluster = defineTcpCluster({ port: 9876 });
 *     // ... pass `cluster` to createGateway / createApp ...
 *
 * `nodeId` and `host` both default — see the type definitions.
 */
export function defineTcpCluster(opts: DefineTcpClusterOptions): ClusterFactory {
  // Resolve nodeId once at the public boundary; pass concrete value
  // to both the wire factory and defineWireCluster so they agree.
  const nodeId = resolveNodeId(opts.nodeId, opts.onDiagnostic);
  return defineWireCluster({
    nodeId,
    node: tcpClusterNode({ ...opts, nodeId }),
    ...omitUndefined({
      codec: opts.codec,
      partitioning: opts.partitioning,
      journal: opts.journal,
      fanoutMode: opts.fanoutMode,
    }),
  });
}

// ============================================================================
// Re-exports of auto-elect for adopters writing custom topology
// ============================================================================

export { tryBindOrConnect } from "./auto-elect.js";
export type { AutoElectMode, AutoElectOptions, AutoElectResult } from "./auto-elect.js";
