/**
 * High-level Redis cluster factories.
 *
 *   - `redisClusterNode(opts)` — bundles a {transport, membership}
 *     factory pair backed by Redis pub/sub + SET-with-TTL.
 *   - `redisTransport(opts)` / `redisMembership(opts)` — standalone
 *     factories.
 *   - `defineRedisCluster(opts)` — top-level convenience wrapping
 *     `defineCluster + redisClusterNode`.
 *
 * Adopter-facing API mirrors `defineTcpCluster` / `defineWsCluster`
 * for consistency. Unlike the broker-based wires, there's NO
 * `redisBroker(...)` — Redis IS the broker; every node is symmetric.
 *
 * Connections: one node gets THREE ioredis clients —
 *   - pub (regular commands; PUBLISH + membership SET/EXPIRE)
 *     also used by membership (the same client; multi-purpose
 *     non-pub/sub channel).
 *   - sub (subscriber mode; SUBSCRIBE/MESSAGE only).
 * The split is required by Redis pub/sub semantics: a connection in
 * subscriber mode can't issue most regular commands.
 */

import {
  createJsonCodec,
  defineCluster,
  resolveNodeId,
  type ClusterCodec,
  type ClusterFactory,
  type ClusterMembershipFactory,
  type ClusterPartitioningFactory,
  type ClusterTransportFactory,
  type DurableJournalFactory,
  type NodeId,
  type NodeIdInput,
} from "@agentick/cluster-next";

import type { RedisLikeClient } from "./redis-client-shape.js";
import { createRedisMembership } from "./redis-membership.js";
import { createRedisTransport } from "./redis-transport.js";
import { omitUndefined } from "@agentick/utils-next";

export interface RedisClusterNodeOptions {
  readonly nodeId: NodeId;
  /**
   * The publish/regular-command ioredis client. Used by transport
   * (PUBLISH) AND membership (SET/SREM/EXPIRE).
   */
  readonly pubClient: RedisLikeClient;
  /**
   * The subscribe-mode ioredis client. Held in SUBSCRIBE mode by
   * the transport; the membership impl doesn't touch it.
   */
  readonly subClient: RedisLikeClient;
  readonly codec?: ClusterCodec;
  /** Shared key/channel prefix. Default `"agentick:"`. */
  readonly keyPrefix?: string;
  /** Liveness TTL (seconds). Default 30. */
  readonly heartbeatTtlSec?: number;
  /** Heartbeat renewal interval (ms). Default 10_000. */
  readonly heartbeatIntervalMs?: number;
  /** Member-change poll interval (ms). Default 5000. */
  readonly pollIntervalMs?: number;
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
}

export interface RedisClusterNode {
  readonly transport: ClusterTransportFactory;
  readonly membership: ClusterMembershipFactory;
}

export function redisClusterNode(opts: RedisClusterNodeOptions): RedisClusterNode {
  const codec = opts.codec ?? createJsonCodec();
  return {
    transport: (parent) => {
      const t = createRedisTransport({
        nodeId: opts.nodeId,
        pubClient: opts.pubClient,
        subClient: opts.subClient,
        codec,
        ...omitUndefined({ keyPrefix: opts.keyPrefix, onDiagnostic: opts.onDiagnostic }),
      });
      parent.onClose(() => t.close());
      return t;
    },
    membership: (parent) => {
      const m = createRedisMembership({
        nodeId: opts.nodeId,
        client: opts.pubClient,
        ...omitUndefined({
          keyPrefix: opts.keyPrefix,
          heartbeatTtlSec: opts.heartbeatTtlSec,
          heartbeatIntervalMs: opts.heartbeatIntervalMs,
          pollIntervalMs: opts.pollIntervalMs,
          onDiagnostic: opts.onDiagnostic,
        }),
      });
      parent.onClose(() => m.close());
      return m;
    },
  };
}

export function redisTransport(opts: RedisClusterNodeOptions): ClusterTransportFactory {
  return redisClusterNode(opts).transport;
}

export function redisMembership(opts: RedisClusterNodeOptions): ClusterMembershipFactory {
  return redisClusterNode(opts).membership;
}

// ============================================================================
// defineRedisCluster — top-level convenience
// ============================================================================

export interface DefineRedisClusterOptions extends Omit<RedisClusterNodeOptions, "nodeId"> {
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

export function defineRedisCluster(opts: DefineRedisClusterOptions): ClusterFactory {
  // Resolve nodeId once at the public boundary; pass concrete value
  // to both the wire factory and defineCluster so they agree.
  const nodeId = resolveNodeId(opts.nodeId, opts.onDiagnostic);
  const node = redisClusterNode({ ...opts, nodeId });
  return defineCluster({
    nodeId,
    transport: node.transport,
    membership: node.membership,
    ...omitUndefined({ partitioning: opts.partitioning, journal: opts.journal }),
    ...(opts.codec !== undefined ? { codec: () => opts.codec! } : {}),
    ...omitUndefined({ fanoutMode: opts.fanoutMode }),
  });
}
