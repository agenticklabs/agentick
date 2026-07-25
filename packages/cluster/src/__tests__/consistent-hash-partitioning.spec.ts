/**
 * `consistentHashPartitioning(membership)` — default partitioning
 * tests. Covers: address → shardKey extraction, shardKey → node
 * mapping, stability under same membership, distribution across
 * nodes, rebalancing when membership changes.
 */

import { describe, expect, it } from "vitest";

import { consistentHashPartitioning } from "../builtins/consistent-hash-partitioning.js";
import type { ClusterMembership } from "../membership.js";
import type { ClusterPartitioning } from "../partitioning.js";
import type { MembershipChange, NodeId } from "../types.js";

function fakeMembership(
  nodes: NodeId[],
  currentNode: NodeId = nodes[0] ?? "node-0",
): ClusterMembership {
  let current = [...nodes];
  return {
    currentNode,
    async nodes() {
      return current;
    },
    onChange(_handler: (c: MembershipChange) => void) {
      return async () => {};
    },
    async close() {},
    // Test helper attached for mutation in tests
    ...({
      __setNodes: (next: NodeId[]) => {
        current = [...next];
      },
    } as object),
  } as unknown as ClusterMembership & { __setNodes: (n: NodeId[]) => void };
}

describe("consistentHashPartitioning — shardKeyFor", () => {
  const membership = fakeMembership(["n1"]);
  const partitioning = consistentHashPartitioning(membership)({} as never) as ClusterPartitioning;

  it("extracts the scopeId from a `${surface}:${scopeId}` address", () => {
    expect(partitioning.shardKeyFor("tasks:session-abc-123")).toBe("session-abc-123");
    expect(partitioning.shardKeyFor("elicitation:foo")).toBe("foo");
    expect(partitioning.shardKeyFor("mcp:server-xyz")).toBe("server-xyz");
  });

  it("returns the full address when no colon is present", () => {
    expect(partitioning.shardKeyFor("opaque-address")).toBe("opaque-address");
  });

  it("returns the full address when colon is the last char (no scopeId)", () => {
    expect(partitioning.shardKeyFor("trailing:")).toBe("trailing:");
  });

  it("handles multi-colon scopeIds (everything after the first colon)", () => {
    expect(partitioning.shardKeyFor("surface:scope:with:colons")).toBe("scope:with:colons");
  });
});

describe("consistentHashPartitioning — nodeFor", () => {
  it("maps a shardKey to one of the live nodes", async () => {
    const membership = fakeMembership(["n1", "n2", "n3"]);
    const partitioning = consistentHashPartitioning(membership)({} as never) as ClusterPartitioning;
    const node = await partitioning.nodeFor("session-abc");
    expect(["n1", "n2", "n3"]).toContain(node);
  });

  it("is deterministic: same shardKey + same membership → same node", async () => {
    const membership = fakeMembership(["n1", "n2", "n3"]);
    const partitioning = consistentHashPartitioning(membership)({} as never) as ClusterPartitioning;
    const a = await partitioning.nodeFor("session-abc");
    const b = await partitioning.nodeFor("session-abc");
    expect(a).toBe(b);
  });

  it("distributes load across nodes (not all keys map to the same node)", async () => {
    const membership = fakeMembership(["n1", "n2", "n3", "n4"]);
    const partitioning = consistentHashPartitioning(membership)({} as never) as ClusterPartitioning;
    const distribution = new Map<NodeId, number>();
    for (let i = 0; i < 1000; i++) {
      const node = await partitioning.nodeFor(`session-${i}`);
      distribution.set(node, (distribution.get(node) ?? 0) + 1);
    }
    // Every node should own at least SOME keys — with 128 vnodes and
    // 4 real nodes, distribution should be reasonable. Each node
    // should hold ≥ 100 of 1000 keys (10%+; expected ≈250 with
    // perfect balance, but we test a loose lower bound).
    expect(distribution.size).toBe(4);
    for (const count of distribution.values()) {
      expect(count).toBeGreaterThan(100);
    }
  });

  it("rebuilds when membership changes (consistent-hash rebalances)", async () => {
    const membership = fakeMembership(["n1", "n2", "n3"]) as ClusterMembership & {
      __setNodes: (n: NodeId[]) => void;
    };
    const partitioning = consistentHashPartitioning(membership)({} as never) as ClusterPartitioning;

    // Capture initial mapping for a set of keys.
    const keys = Array.from({ length: 200 }, (_, i) => `key-${i}`);
    const before = new Map<string, NodeId>();
    for (const k of keys) before.set(k, await partitioning.nodeFor(k));

    // Add a node to the cluster.
    membership.__setNodes(["n1", "n2", "n3", "n4"]);

    // Some keys should re-map; most should stay (consistent hash's
    // whole point). We just check that AT LEAST ONE key now maps to
    // n4 (new node owns some load) and that AT LEAST ONE key stayed.
    let movedToN4 = 0;
    let stayed = 0;
    for (const k of keys) {
      const now = await partitioning.nodeFor(k);
      if (now === "n4") movedToN4++;
      if (now === before.get(k)) stayed++;
    }
    expect(movedToN4).toBeGreaterThan(0);
    expect(stayed).toBeGreaterThan(0);
  });

  it("throws when the cluster has no live members", async () => {
    const membership = fakeMembership([]);
    const partitioning = consistentHashPartitioning(membership)({} as never) as ClusterPartitioning;
    await expect(partitioning.nodeFor("any")).rejects.toThrow(/no members/i);
  });
});
