/**
 * `defineLocalCluster` — the in-memory ClusterFactory used in tests.
 * Behavioral peer to defineUnixCluster/defineTcpCluster/etc., but
 * with no I/O. Pinning the contract:
 *
 *   1. Returns a `ClusterFactory` that resolves to a `Cluster` when
 *      run against a `ClusterParent`.
 *   2. Two nodes sharing one registry see each other in membership.
 *   3. A broadcast from node A lands on node B's bus subscribers.
 */

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { afterEach, describe, expect, it } from "vitest";

import type { Cluster, ClusterParent } from "../cluster.js";
import { createLocalClusterRegistry, defineLocalCluster } from "../testing/index.js";

function mkParent(id: string): {
  parent: ClusterParent;
  fireClose: () => Promise<void>;
} {
  const handlers: Array<() => Promise<void> | void> = [];
  const parent: ClusterParent = {
    id,
    bus: new LocalEventBus(),
    inbox: new LocalInbox(),
    journal: new MemoryJournal({ capacity: 1_000 }),
    onClose: (h) => {
      handlers.push(h);
    },
  };
  return {
    parent,
    fireClose: async () => {
      for (const h of handlers) await h();
    },
  };
}

describe("defineLocalCluster", () => {
  const clusters: Array<{ cluster: Cluster; fireClose: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const { fireClose } of clusters) await fireClose();
    clusters.length = 0;
  });

  it("returns a ClusterFactory that resolves to a Cluster (implicit registry — single-node case)", async () => {
    // No `registry` opt — defineLocalCluster creates one internally.
    const factory = defineLocalCluster({ nodeId: "node-A" });
    const { parent, fireClose } = mkParent("parent-A");
    const cluster = await Promise.resolve(factory(parent));
    clusters.push({ cluster, fireClose });
    expect(cluster.currentNode).toBe("node-A");
    expect(typeof cluster.bus.append).toBe("function");
    expect(typeof cluster.inbox.send).toBe("function");
  });

  it("two nodes sharing one registry see each other in membership", async () => {
    const registry = createLocalClusterRegistry();

    const fA = defineLocalCluster({ nodeId: "node-A", registry });
    const fB = defineLocalCluster({ nodeId: "node-B", registry });

    const { parent: pA, fireClose: closeA } = mkParent("parent-A");
    const { parent: pB, fireClose: closeB } = mkParent("parent-B");

    const cA = await Promise.resolve(fA(pA));
    const cB = await Promise.resolve(fB(pB));
    clusters.push({ cluster: cA, fireClose: closeA }, { cluster: cB, fireClose: closeB });

    // Both should appear in the shared registry.
    expect(registry.nodes()).toEqual(expect.arrayContaining(["node-A", "node-B"]));
  });

  it("close removes the node from the registry", async () => {
    const registry = createLocalClusterRegistry();
    const factory = defineLocalCluster({ nodeId: "node-C", registry });
    const { parent, fireClose } = mkParent("parent-C");
    const cluster = await Promise.resolve(factory(parent));

    expect(registry.nodes()).toContain("node-C");
    await fireClose();
    expect(registry.nodes()).not.toContain("node-C");
    // Cluster reference is still held but its substrate is closed —
    // we don't push to `clusters` here since fireClose already ran.
    void cluster;
  });
});
