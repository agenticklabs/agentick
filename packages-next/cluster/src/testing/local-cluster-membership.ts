/**
 * `localClusterMembership(opts)` — in-memory `ClusterMembership`
 * fixture for tests. Backed by the same {@link LocalClusterRegistry}
 * as `localClusterTransport`; observes node registrations and
 * surfaces them as membership changes.
 */

import { defineClusterMembership } from "../define.js";
import type { ClusterMembershipFactory } from "../factories.js";
import type { LocalClusterRegistry } from "./local-cluster-registry.js";
import type { NodeId } from "../types.js";

export interface LocalClusterMembershipOptions {
  readonly registry: LocalClusterRegistry;
  readonly nodeId: NodeId;
}

/**
 * Construct a membership factory bound to `opts.registry` for
 * `opts.nodeId`. On factory invocation, registers the node into
 * the shared registry; the membership impl reads live state from
 * the registry on every `nodes()` call and forwards transition
 * events to subscribers.
 */
export function localClusterMembership(
  opts: LocalClusterMembershipOptions,
): ClusterMembershipFactory {
  const { registry, nodeId } = opts;
  return defineClusterMembership({
    currentNode: nodeId,
    async nodes() {
      // Live snapshot from the shared registry.
      return registry.nodes();
    },
    onChange(handler) {
      registry.registerNode(nodeId);
      const unsubscribe = registry.subscribeMembership(nodeId, handler);
      return async () => {
        unsubscribe();
      };
    },
    async close() {
      registry.unregisterNode(nodeId);
    },
  });
}
