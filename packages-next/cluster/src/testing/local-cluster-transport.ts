/**
 * `localClusterTransport(opts)` — in-memory `ClusterTransport`
 * fixture for tests. Multiple instances sharing the same
 * {@link LocalClusterRegistry} route to each other via the
 * registry; pure JS, no I/O, deterministic ordering via microtask
 * scheduling.
 *
 * Use for:
 *   - the cluster conformance suite (validates the registry-backed
 *     impl conforms to the protocol)
 *   - cross-cluster integration tests in adopter codebases (no
 *     Docker / Redis / NATS needed)
 *
 * NOT for production — real adapters (`@agentick/cluster-ipc-next`,
 * `@agentick/cluster-redis-next`, etc.) provide the actual wire.
 */

import { defineClusterTransport } from "../define.js";
import type { ClusterTransportFactory } from "../factories.js";
import type { LocalClusterRegistry } from "./local-cluster-registry.js";
import type { NodeId } from "../types.js";

export interface LocalClusterTransportOptions {
  readonly registry: LocalClusterRegistry;
  readonly nodeId: NodeId;
}

/**
 * Construct a transport factory bound to `opts.registry` for
 * `opts.nodeId`. Register the node on first construction;
 * unregister on `close()`.
 */
export function localClusterTransport(opts: LocalClusterTransportOptions): ClusterTransportFactory {
  const { registry, nodeId } = opts;
  return defineClusterTransport({
    async send(toNode, env) {
      await registry.routeMessage(nodeId, toNode, env);
    },
    async broadcast(env) {
      await registry.routeBroadcast(nodeId, env);
    },
    subscribeInbox(filter, onMessage) {
      registry.registerNode(nodeId);
      const unsubscribe = registry.subscribeInbox(nodeId, { filter, onMessage });
      return async () => {
        unsubscribe();
      };
    },
    subscribeBus(filter, onEvent) {
      registry.registerNode(nodeId);
      const unsubscribe = registry.subscribeBus(nodeId, { filter, onEvent });
      return async () => {
        unsubscribe();
      };
    },
    async flush() {
      // In-memory subscriptions are recorded synchronously in the
      // registry, so flush has nothing to wait for. We still yield a
      // microtask so callers using flush() defensively across all
      // transport classes get consistent "I'm at a stable point"
      // semantics.
      await Promise.resolve();
    },
    async close() {
      registry.unregisterNode(nodeId);
    },
  });
}
