/**
 * High-level TCP cluster factories. Wire-specific concerns (host/port,
 * length-prefix framing, max-frame-bytes) live in `tcp-listener.ts` /
 * `tcp-connector.ts`. The shared `{ xBroker, xClusterNode,
 * defineXCluster }` scaffolding lives in
 * `@agentick/cluster-broker-next` (`wire-helpers.ts`).
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

import type {
  ClusterCodec,
  ClusterFactory,
  ClusterMembershipFactory,
  ClusterPartitioningFactory,
  ClusterTransportFactory,
  DurableJournalFactory,
  NodeId,
} from "@agentick/cluster-next";
import {
  createClusterNode,
  defineWireCluster,
  startBroker,
  type ClusterNodeFactories,
  type RunningBroker,
} from "@agentick/cluster-broker-next";

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
    ...(opts.maxFrameBytes !== undefined ? { maxFrameBytes: opts.maxFrameBytes } : {}),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
  });
  return startBroker({
    listener,
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
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
      ...(opts.host !== undefined ? { host: opts.host } : {}),
      port: opts.port,
      ...(opts.maxFrameBytes !== undefined ? { maxFrameBytes: opts.maxFrameBytes } : {}),
      ...(opts.connectTimeoutMs !== undefined ? { connectTimeoutMs: opts.connectTimeoutMs } : {}),
      ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
    }),
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    ...(opts.missedPongLimit !== undefined ? { missedPongLimit: opts.missedPongLimit } : {}),
    ...(opts.reconnect !== undefined ? { reconnect: opts.reconnect } : {}),
    ...(opts.onDiagnostic !== undefined ? { onDiagnostic: opts.onDiagnostic } : {}),
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
  return defineWireCluster({
    nodeId: opts.nodeId,
    node: tcpClusterNode(opts),
    ...(opts.codec !== undefined ? { codec: opts.codec } : {}),
    ...(opts.partitioning !== undefined ? { partitioning: opts.partitioning } : {}),
    ...(opts.journal !== undefined ? { journal: opts.journal } : {}),
    ...(opts.fanoutMode !== undefined ? { fanoutMode: opts.fanoutMode } : {}),
  });
}

// ============================================================================
// Re-exports of auto-elect for adopters writing custom topology
// ============================================================================

export { tryBindOrConnect } from "./auto-elect.js";
export type { AutoElectMode, AutoElectOptions, AutoElectResult } from "./auto-elect.js";
