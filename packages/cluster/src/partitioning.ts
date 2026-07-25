/**
 * `ClusterPartitioning` — the seam that decides which node owns
 * which address. Adopters override to shard by tenant, by user,
 * or by any custom key derivable from an address.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §2, §7
 */

import type { NodeId } from "./types.js";

/**
 * Sharding strategy. Two functions, one pure + one async.
 *
 * `shardKeyFor` is pure — given an address (e.g.
 * `"tasks:session-abc-123"`), return a shard key string. The
 * default impl extracts the scopeId from the address ("session-abc-123").
 * Adopters override to shard by tenant: `(addr) => extractTenantId(addr)`.
 *
 * `nodeFor` maps a shard key to its owning node. The default impl
 * is a consistent-hash ring built from current membership; the
 * cluster keeps it fresh as nodes join/leave. Adopters override
 * for custom topologies (e.g. dedicated nodes per tenant tier).
 *
 * Composition: per-address routing is
 *   `nodeFor(shardKeyFor(address))`
 * — the framework calls this whenever it needs to know "which node
 * owns this address?" (inbox `send`, partition-aware bus fan-out).
 */
export interface ClusterPartitioning {
  /**
   * Project an address to its shard key. PURE function; no I/O.
   * The same address MUST always produce the same key for the
   * same partitioning instance — the cluster routing layer caches
   * results.
   *
   * Default impl: extract the scopeId substring after the surface
   * prefix (`"tasks:session-abc-123"` → `"session-abc-123"`).
   * Adopters override for multi-tenant: extract the tenant id
   * embedded in the scopeId or in a separate registry lookup.
   */
  shardKeyFor(address: string): string;

  /**
   * Map a shard key to its owning node. MAY consult live
   * membership state; MAY do I/O (rare — most impls are pure
   * consistent-hash). Async to allow membership lookups.
   *
   * The same shard key MAY resolve to different nodes over time
   * as cluster membership changes. The cluster routing layer
   * tolerates this — it re-resolves on each `send` rather than
   * caching long-term.
   */
  nodeFor(shardKey: string): Promise<NodeId>;
}
