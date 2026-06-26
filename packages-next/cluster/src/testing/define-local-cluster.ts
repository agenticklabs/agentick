/**
 * `defineLocalCluster(opts)` — the in-memory "fifth wire" ClusterFactory.
 *
 * Tests that need a cluster substrate without standing up sockets,
 * pub/sub, or any real wire infrastructure reach for this. It's the
 * symmetric peer to `defineUnixCluster` / `defineTcpCluster` /
 * `defineWsCluster` / `defineRedisCluster` — same factory shape, same
 * substrate-wrapping semantics, no I/O.
 *
 * Multiple cluster nodes can share one `LocalClusterRegistry`. That's
 * the simulation of a multi-node cluster — each `defineLocalCluster`
 * call binds to its node id; broadcasts and sends route through the
 * shared registry just like the real wires route through their
 * transport.
 *
 * @example
 * ```ts
 * import { createLocalClusterRegistry, defineLocalCluster } from "@agentick/cluster-next/testing";
 *
 * const registry = createLocalClusterRegistry();
 *
 * const appA = await createApp(<A />, {
 *   executor: ...,
 *   cluster: defineLocalCluster({ nodeId: "a", registry }),
 * });
 * const appB = await createApp(<B />, {
 *   executor: ...,
 *   cluster: defineLocalCluster({ nodeId: "b", registry }),
 * });
 *
 * // A and B now exchange events / messages via the in-memory wire.
 * ```
 */

import {
  defineCluster,
  type ClusterCodec,
  type ClusterFactory,
  type ClusterPartitioningFactory,
  type DurableJournalFactory,
  type NodeId,
} from "../index.js";
import { localClusterMembership } from "./local-cluster-membership.js";
import { createLocalClusterRegistry, type LocalClusterRegistry } from "./local-cluster-registry.js";
import { localClusterTransport } from "./local-cluster-transport.js";

export interface DefineLocalClusterOptions {
  /**
   * This node's identity. Required — local-cluster tests typically
   * need deterministic ids. (The wire-specific facades default this
   * via {@link resolveNodeId}; the local cluster does NOT, because
   * tests want to control routing precisely.)
   */
  readonly nodeId: NodeId;
  /**
   * Shared in-memory registry. Omit for single-node tests — a fresh
   * registry will be created internally. Pass an EXPLICIT registry
   * when you have multiple `defineLocalCluster` calls that should
   * see each other; both factories MUST share the same registry
   * instance to simulate one multi-node cluster.
   *
   * @example
   * // Single-node test — registry is implicit.
   * const cluster = defineLocalCluster({ nodeId: "test" });
   *
   * @example
   * // Multi-node test — adopter creates the shared registry.
   * const registry = createLocalClusterRegistry();
   * const clusterA = defineLocalCluster({ nodeId: "a", registry });
   * const clusterB = defineLocalCluster({ nodeId: "b", registry });
   */
  readonly registry?: LocalClusterRegistry;
  readonly codec?: ClusterCodec;
  readonly partitioning?: ClusterPartitioningFactory;
  readonly journal?: DurableJournalFactory;
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

/**
 * Construct a {@link ClusterFactory} backed by the in-memory
 * `LocalClusterRegistry`. Suitable for unit / integration tests that
 * exercise cluster behavior without real I/O.
 */
export function defineLocalCluster(opts: DefineLocalClusterOptions): ClusterFactory {
  const registry = opts.registry ?? createLocalClusterRegistry();
  return defineCluster({
    nodeId: opts.nodeId,
    transport: localClusterTransport({ registry, nodeId: opts.nodeId }),
    membership: localClusterMembership({ registry, nodeId: opts.nodeId }),
    ...(opts.codec !== undefined ? { codec: () => opts.codec! } : {}),
    ...(opts.partitioning !== undefined ? { partitioning: opts.partitioning } : {}),
    ...(opts.journal !== undefined ? { journal: opts.journal } : {}),
    ...(opts.fanoutMode !== undefined ? { fanoutMode: opts.fanoutMode } : {}),
  });
}
