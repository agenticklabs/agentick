/**
 * `ClusterMembership` — the seam adapters implement to expose who
 * is currently in the cluster and emit transition events.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §2
 */

import type { MembershipChange, NodeId } from "./types.js";

/**
 * Membership tracking. The cluster's source of truth for "who's
 * here" — partitioning consults it for rebalances; the cluster
 * router consults it for delivery decisions; observability
 * surfaces emit `cluster:node:joined` / `cluster:node:lost` from
 * its change stream.
 *
 * Implementations MAY back this with: a primary-process registry
 * (IPC), a Redis presence key (TTL + heartbeat), NATS subscriber
 * discovery, k8s pod-list API, or a custom service-discovery
 * source.
 */
export interface ClusterMembership {
  /**
   * The current node's identity. Set at construction; stable for
   * the membership's lifetime.
   */
  readonly currentNode: NodeId;

  /**
   * Snapshot of currently-live nodes. Includes `currentNode`.
   * The order is implementation-defined; callers MUST NOT depend
   * on it being sorted, stable across calls, or matching any
   * particular order. Use {@link ClusterPartitioning.nodeFor}
   * for routing decisions, not this list directly.
   */
  nodes(): Promise<readonly NodeId[]>;

  /**
   * Subscribe to membership transitions. The handler fires on
   * every change AND once on subscription with a `snapshot` event
   * carrying the current member list (so subscribers don't need
   * a separate initial `nodes()` call).
   *
   * Returns an unsubscribe function. Calling it MUST NOT throw.
   */
  onChange(handler: (change: MembershipChange) => void): () => void;

  /**
   * Cooperative close. Withdraws `currentNode` from the cluster's
   * shared registry (announces a `lost` event with `reason:
   * "graceful"` if the adapter has the channel for it), drops
   * subscriptions, releases any heartbeat tasks. Idempotent on
   * double-close.
   */
  close(): Promise<void>;
}
