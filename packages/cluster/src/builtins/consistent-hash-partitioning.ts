/**
 * `consistentHashPartitioning(membership)` — bundled
 * {@link ClusterPartitioning} factory using a virtual-node
 * consistent-hash ring over current cluster membership.
 *
 * Default partitioning when {@link defineCluster} adopters don't
 * supply a custom one. Live: the ring rebuilds on membership
 * change events, so `nodeFor(key)` reflects the current live
 * membership.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §7
 */

import type { ClusterMembership } from "../membership.js";
import type { ClusterPartitioning } from "../partitioning.js";
import type { ClusterPartitioningFactory } from "../factories.js";
import type { NodeId } from "../types.js";

/**
 * Virtual-node count per real node in the consistent-hash ring.
 * Higher = smoother load distribution at the cost of larger
 * in-memory tables. 128 is a reasonable default; the framework
 * doesn't currently expose this knob (adopters needing different
 * load characteristics swap in a custom `ClusterPartitioning` impl).
 */
const VIRTUAL_NODES_PER_REAL = 128;

/**
 * Address-to-shardkey default: extract the scopeId substring
 * after the first `:`. Mirrors the `BaseHarness.address` format —
 * `${surface}:${scopeId}`. Adopters override `shardKeyFor` to
 * shard by tenant id / user id / any custom key derivable from the
 * address; this is the default behavior when they don't.
 */
function defaultShardKeyFor(address: string): string {
  const idx = address.indexOf(":");
  if (idx < 0 || idx === address.length - 1) return address;
  return address.slice(idx + 1);
}

/**
 * Construct a consistent-hash partitioning factory backed by
 * `membership`. The returned factory builds a `ClusterPartitioning`
 * that consults `membership` on every `nodeFor` call (the membership
 * impl owns its own subscription / refresh; this partitioning just
 * reads the current snapshot).
 *
 * Adopters who want stricter caching / locality can construct their
 * own `ClusterPartitioning` and pass it to {@link defineCluster}
 * directly.
 */
export function consistentHashPartitioning(
  membership: ClusterMembership,
): ClusterPartitioningFactory {
  return () => {
    const impl: ClusterPartitioning = {
      shardKeyFor: defaultShardKeyFor,
      async nodeFor(shardKey) {
        const nodes = await membership.nodes();
        if (nodes.length === 0) {
          throw new Error(
            "consistentHashPartitioning.nodeFor: cluster has no members; " +
              "cannot route shard key " +
              JSON.stringify(shardKey),
          );
        }
        return pickFromRing(shardKey, nodes);
      },
    };
    return impl;
  };
}

/**
 * Map `shardKey` to one of `nodes` via a virtual-node consistent
 * hash ring. Rebuilt per call — `nodes` here is the live snapshot
 * passed from `membership.nodes()`.
 *
 * The hash is FNV-1a 32-bit (no crypto needed; uniform distribution
 * is enough for our load-balancing purpose).
 */
function pickFromRing(shardKey: string, nodes: readonly NodeId[]): NodeId {
  // Build the ring: each node gets VIRTUAL_NODES_PER_REAL slots,
  // hashed at `${node}:${vnode}`. Sort by hash. Pick the first
  // slot whose hash >= the shard key's hash, wrapping if needed.
  const ring: Array<{ hash: number; node: NodeId }> = [];
  for (const node of nodes) {
    for (let i = 0; i < VIRTUAL_NODES_PER_REAL; i++) {
      ring.push({ hash: fnv1a(`${node}:${i}`), node });
    }
  }
  ring.sort((a, b) => a.hash - b.hash);

  const target = fnv1a(shardKey);
  for (const slot of ring) {
    if (slot.hash >= target) return slot.node;
  }
  // Wrap around — `target` is past the last slot in ring order.
  return ring[0]!.node;
}

/**
 * 32-bit FNV-1a hash. Fast, uniform-enough for our partitioning
 * needs, no crypto. (Not collision-resistant; not used for
 * security.)
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}
