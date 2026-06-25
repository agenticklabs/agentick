/**
 * Run the {@link runClusterTransportConformance} suite against the
 * bundled `LocalClusterTransport` fixture. Validates BOTH:
 *
 *   1. The fixture conforms to the protocol contract — adapter
 *      authors using it as a peer transport in their own conformance
 *      tests can trust it.
 *   2. The conformance suite itself is wired correctly — its
 *      describe/it discovery, setup/teardown lifecycle, and helper
 *      assertions work against a real impl.
 *
 * This file is the framework's own canonical pass of the suite.
 * Adapter packages (cluster-ipc-next, cluster-redis-next) will mirror
 * the same structure with their own transport factories.
 */

import { runClusterTransportConformance } from "../conformance.js";
import { createLocalClusterRegistry, localClusterTransport } from "../testing/index.js";

runClusterTransportConformance({
  label: "ClusterTransport conformance — localClusterTransport",
  async setup() {
    // Per-test fresh registry → no cross-test leakage.
    const registry = createLocalClusterRegistry();
    return {
      factoryA: localClusterTransport({ registry, nodeId: "node-A" }),
      factoryB: localClusterTransport({ registry, nodeId: "node-B" }),
      nodeAId: "node-A",
      nodeBId: "node-B",
      async teardown() {
        // No external resources to release for the in-memory
        // fixture; the registry GCs naturally.
      },
    };
  },
});
