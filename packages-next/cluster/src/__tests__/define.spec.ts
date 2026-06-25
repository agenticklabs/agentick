/**
 * `defineCluster*` composition tests — exercise the bridge helpers
 * and the top-level `defineCluster` factory against minimal
 * Promise-flavored adapter impls.
 *
 * Phase 2 scope: validate that defineCluster composes the seams,
 * resolves the (optionally-lazy) nodeId, and produces a Cluster
 * value with the wired seams. Phase 3 adds the ClusterEventBus /
 * ClusterInbox wrappers; this test does NOT exercise cross-node
 * routing yet (Phase 4's LocalClusterTransport + conformance suite
 * cover that).
 */

import { describe, expect, it } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";

import { defineCluster, defineClusterMembership, defineClusterTransport } from "../define.js";
import type { ClusterParent } from "../cluster.js";
import type { MembershipChange, NodeId } from "../types.js";

// ---------------------------------------------------------------------------
// Minimal adapter impls used by the composition tests.
// ---------------------------------------------------------------------------

function noopTransport() {
  return defineClusterTransport({
    async send() {},
    async broadcast() {},
    subscribeInbox() {
      return async () => {};
    },
    subscribeBus() {
      return async () => {};
    },
    async close() {},
  });
}

function staticMembership(nodes: NodeId[], currentNode: NodeId) {
  return defineClusterMembership({
    currentNode,
    async nodes() {
      return nodes;
    },
    onChange(_handler: (c: MembershipChange) => void) {
      return async () => {};
    },
    async close() {},
  });
}

function mkParent(): ClusterParent {
  const closes: Array<() => Promise<void> | void> = [];
  return {
    id: "parent:test",
    bus: new LocalEventBus(),
    inbox: new LocalInbox(),
    journal: new MemoryJournal(),
    onClose(handler) {
      closes.push(handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("defineCluster — composition", () => {
  it("constructs a Cluster from required seams + resolves nodeId statically", async () => {
    const factory = defineCluster({
      nodeId: "node-1",
      transport: noopTransport(),
      membership: staticMembership(["node-1", "node-2"], "node-1"),
    });
    const cluster = await factory(mkParent());
    expect(cluster.currentNode).toBe("node-1");
    expect(await cluster.nodes()).toEqual(["node-1", "node-2"]);
  });

  it("resolves a lazy nodeId thunk at construction time", async () => {
    const factory = defineCluster({
      nodeId: () => "lazy-node-x",
      transport: noopTransport(),
      membership: staticMembership(["lazy-node-x"], "lazy-node-x"),
    });
    const cluster = await factory(mkParent());
    expect(cluster.currentNode).toBe("lazy-node-x");
  });

  it("resolves an async nodeId thunk at construction time", async () => {
    const factory = defineCluster({
      nodeId: async () => "async-node-y",
      transport: noopTransport(),
      membership: staticMembership(["async-node-y"], "async-node-y"),
    });
    const cluster = await factory(mkParent());
    expect(cluster.currentNode).toBe("async-node-y");
  });

  it("uses the default consistent-hash partitioning when none is supplied", async () => {
    const factory = defineCluster({
      nodeId: "n1",
      transport: noopTransport(),
      membership: staticMembership(["n1", "n2", "n3"], "n1"),
    });
    const cluster = await factory(mkParent());
    // ownerOf goes through partitioning.shardKeyFor + nodeFor; with
    // default impls, the result is one of the live nodes.
    const owner = await cluster.ownerOf("tasks:session-abc");
    expect(["n1", "n2", "n3"]).toContain(owner);
  });

  it("ownerOf is deterministic for the same address + membership", async () => {
    const factory = defineCluster({
      nodeId: "n1",
      transport: noopTransport(),
      membership: staticMembership(["n1", "n2", "n3"], "n1"),
    });
    const cluster = await factory(mkParent());
    const a = await cluster.ownerOf("tasks:session-x");
    const b = await cluster.ownerOf("tasks:session-x");
    expect(a).toBe(b);
  });

  it("bus / inbox / journal are pass-through from parent (Phase 2 — no wrapping yet)", async () => {
    const parent = mkParent();
    const factory = defineCluster({
      nodeId: "n1",
      transport: noopTransport(),
      membership: staticMembership(["n1"], "n1"),
    });
    const cluster = await factory(parent);
    expect(cluster.bus).toBe(parent.bus);
    expect(cluster.inbox).toBe(parent.inbox);
    expect(cluster.journal).toBe(parent.journal);
  });

  it("cluster.close() resolves without throwing (lifecycle wired via parent.onClose)", async () => {
    const factory = defineCluster({
      nodeId: "n1",
      transport: noopTransport(),
      membership: staticMembership(["n1"], "n1"),
    });
    const cluster = await factory(mkParent());
    await expect(cluster.close()).resolves.toBeUndefined();
  });
});

describe("defineCluster — adapter onClose registration", () => {
  it("registers transport.close() and membership.close() with the parent harness", async () => {
    const closeCalls: string[] = [];
    const transportFactory = defineClusterTransport({
      async send() {},
      async broadcast() {},
      subscribeInbox() {
        return async () => {};
      },
      subscribeBus() {
        return async () => {};
      },
      async close() {
        closeCalls.push("transport");
      },
    });
    const membershipFactory = defineClusterMembership({
      currentNode: "n1",
      async nodes() {
        return ["n1"];
      },
      onChange() {
        return async () => {};
      },
      async close() {
        closeCalls.push("membership");
      },
    });

    // Custom parent that records every onClose handler so we can
    // run them and verify the close order.
    const handlers: Array<() => Promise<void> | void> = [];
    const parent: ClusterParent = {
      id: "parent:test",
      bus: new LocalEventBus(),
      inbox: new LocalInbox(),
      journal: new MemoryJournal(),
      onClose(handler) {
        handlers.push(handler);
      },
    };

    const factory = defineCluster({
      nodeId: "n1",
      transport: transportFactory,
      membership: membershipFactory,
    });
    await factory(parent);

    // Two handlers registered (transport + membership; partitioning
    // and codec have no lifecycle).
    expect(handlers.length).toBe(2);
    // Fire them in order — defineCluster's factory body registered
    // transport first, then membership.
    for (const h of handlers) await h();
    expect(closeCalls).toEqual(["transport", "membership"]);
  });
});
