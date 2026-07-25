/**
 * `joinRedisCluster` — Redis ergonomic facade. Brokerless tier:
 * no role election, no broker start. Tests the facade against the
 * in-memory FakeRedis hub.
 */

import type { ClusterNode } from "@agentick/cluster";
import { afterEach, describe, expect, it } from "vitest";

import { joinRedisCluster } from "../join-redis-cluster.js";
import { createFakeRedis } from "./fake-redis.js";

describe("joinRedisCluster — ergonomic facade", () => {
  const liveNodes: ClusterNode[] = [];

  afterEach(async () => {
    while (liveNodes.length > 0) {
      const node = liveNodes.pop();
      if (node) await node.close();
    }
  });

  async function spawn(
    nodeId: string,
    hub: ReturnType<typeof createFakeRedis>,
  ): Promise<ClusterNode> {
    const node = await joinRedisCluster({
      nodeId,
      pubClient: hub.newClient(),
      subClient: hub.newClient(),
      // Tight polling for fast test convergence.
      heartbeatIntervalMs: 50,
      pollIntervalMs: 50,
    });
    liveNodes.push(node);
    return node;
  }

  it("every node is always 'client' (brokerless tier)", async () => {
    const hub = createFakeRedis();
    const a = await spawn("node-A", hub);
    const b = await spawn("node-B", hub);
    expect(a.role).toBe("client");
    expect(b.role).toBe("client");
    expect(a.localBrokerRunning()).toBe(false);
    expect(b.localBrokerRunning()).toBe(false);
  });

  it("bus.subscribe + bus.broadcast round-trip via Redis pub/sub", async () => {
    const hub = createFakeRedis();
    const a = await spawn("node-A", hub);
    const b = await spawn("node-B", hub);

    const received: Array<{ name: string; from?: string; payload: unknown }> = [];
    a.bus.subscribe("ping", (env) => {
      received.push({ name: env.name, from: env.scope.nodeId, payload: env.payload });
    });
    // Give A's subscription a moment to register on the Redis bus.
    await new Promise((r) => setTimeout(r, 50));
    await b.bus.broadcast("ping", { msg: "hi" });
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ name: "ping", from: "node-B", payload: { msg: "hi" } });
  });

  it("membership.waitForPeers resolves when peers join", async () => {
    const hub = createFakeRedis();
    const a = await spawn("node-A", hub);
    const pending = a.membership.waitForPeers(1, { timeoutMs: 3_000 });
    const b = await spawn("node-B", hub);
    void b;
    const peers = await pending;
    expect(peers).toContain("node-B");
  });

  it("diagnostic sink tags every event with layer='client'", async () => {
    const hub = createFakeRedis();
    const diags: Array<{ name: string; layer?: string }> = [];
    const node = await joinRedisCluster({
      nodeId: "node-solo",
      pubClient: hub.newClient(),
      subClient: hub.newClient(),
      heartbeatIntervalMs: 50,
      pollIntervalMs: 50,
      onDiagnostic: (name, _payload, layer) => {
        diags.push({ name, layer });
      },
    });
    liveNodes.push(node);
    // Trigger at least one diagnostic by subscribing.
    node.bus.subscribe("trigger", () => {});
    await new Promise((r) => setTimeout(r, 100));
    // Redis tier emits diagnostics via the wrapped sink; every one
    // should be tagged "client".
    if (diags.length > 0) {
      expect(diags.every((d) => d.layer === "client")).toBe(true);
    }
    // We don't pin a specific event name here — the redis transport's
    // diagnostic schedule is implementation-detail. The contract is:
    // if anything fires, it carries layer='client'.
  });

  it("close() is idempotent and Symbol.asyncDispose mirrors close()", async () => {
    const hub = createFakeRedis();
    const a = await spawn("node-A", hub);
    await a.close();
    await expect(a.close()).resolves.toBeUndefined();
    liveNodes.length = 0;

    const node = await joinRedisCluster({
      nodeId: "node-B",
      pubClient: hub.newClient(),
      subClient: hub.newClient(),
      heartbeatIntervalMs: 50,
      pollIntervalMs: 50,
    });
    await node[Symbol.asyncDispose]();
    await expect(node[Symbol.asyncDispose]()).resolves.toBeUndefined();
  });
});
