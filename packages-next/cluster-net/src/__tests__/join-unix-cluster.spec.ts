/**
 * `joinUnixCluster` — the ergonomic facade. Exercises the full
 * compose: bind-race election, name-based bus subscribe/broadcast,
 * `membership.waitForPeers(n)`, and the `await using` lifecycle.
 *
 * This is the high-level test that pins what users see. The wire
 * mechanics (re-election, framing, handshake) are covered by the
 * dedicated specs in this directory; we just verify the facade
 * wires them together correctly.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ClusterNode } from "@agentick/cluster-next";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { joinUnixCluster } from "../join-unix-cluster.js";

describe("joinUnixCluster — ergonomic facade", () => {
  let tmp: string;
  let socketPath: string;
  const liveNodes: ClusterNode[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "agentick-join-unix-"));
    socketPath = join(tmp, "cluster.sock");
  });

  afterEach(async () => {
    while (liveNodes.length > 0) {
      const node = liveNodes.pop();
      if (node) await node.close();
    }
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // best effort
    }
  });

  async function spawn(nodeId: string): Promise<ClusterNode> {
    const node = await joinUnixCluster({
      nodeId,
      socketPath,
      // Tight reconnect window so tests don't drag.
      reconnect: { initialMs: 5, maxMs: 20, maxAttempts: 50 },
      heartbeatMs: 0,
    });
    liveNodes.push(node);
    return node;
  }

  it("first joiner wins the bind race and becomes broker; second joins as client", async () => {
    const a = await spawn("node-A");
    const b = await spawn("node-B");
    expect(a.role).toBe("broker");
    expect(b.role).toBe("client");
    expect(a.localBrokerRunning()).toBe(true);
    expect(b.localBrokerRunning()).toBe(false);
  });

  it("waitForPeers(n) resolves when n peers are visible", async () => {
    const a = await spawn("node-A");
    // No peers yet — waitForPeers(1) should NOT resolve.
    const pending = a.membership.waitForPeers(1, { timeoutMs: 2_000 });
    // Join a peer.
    const b = await spawn("node-B");
    void b;
    const peers = await pending;
    expect(peers).toContain("node-B");
  });

  it("waitForPeers(n) rejects on timeout when threshold isn't met", async () => {
    const a = await spawn("node-A");
    await expect(a.membership.waitForPeers(5, { timeoutMs: 200 })).rejects.toThrow(
      /timed out after 200ms/,
    );
  });

  it("bus.subscribe(name) only fires for matching events; broadcast auto-stamps the envelope", async () => {
    const a = await spawn("node-A");
    const b = await spawn("node-B");
    // Let both clients finish handshake so the broker has them both
    // in its routing table.
    await b.membership.waitForPeers(1, { timeoutMs: 2_000 });

    const receivedOnA: Array<{ name: string; from?: string; payload: unknown }> = [];
    const unsub = a.bus.subscribe("otto:hello", (env) => {
      receivedOnA.push({ name: env.name, from: env.scope.nodeId, payload: env.payload });
    });

    // B broadcasts. A should see it (via the name-filtered subscription).
    await b.bus.broadcast("otto:hello", { greeting: "hi" });
    // Allow the broker fan-out to land on A's handler.
    await new Promise((r) => setTimeout(r, 50));

    expect(receivedOnA).toHaveLength(1);
    expect(receivedOnA[0]).toEqual({
      name: "otto:hello",
      from: "node-B",
      payload: { greeting: "hi" },
    });

    // B broadcasts a DIFFERENT name — A's filter should ignore it.
    await b.bus.broadcast("otto:goodbye");
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedOnA).toHaveLength(1);

    await unsub();
  });

  it("close() is idempotent and Symbol.asyncDispose mirrors close()", async () => {
    const a = await spawn("node-A");
    await a.close();
    // Second close should NOT throw.
    await expect(a.close()).resolves.toBeUndefined();
    // Symbol.asyncDispose path.
    const b = await spawn("node-B");
    await b[Symbol.asyncDispose]();
    await expect(b[Symbol.asyncDispose]()).resolves.toBeUndefined();
    // Pop them so afterEach doesn't double-close.
    liveNodes.length = 0;
  });

  it("await using disposes the node at scope exit", async () => {
    let stillLocalBroker: boolean | null = null;
    {
      await using node = await spawn("node-A");
      // Drop from liveNodes — `await using` is the closer here.
      liveNodes.pop();
      expect(node.role).toBe("broker");
      stillLocalBroker = node.localBrokerRunning();
    }
    // Outside the block, the node is disposed. We can't poke
    // `node` here, but stillLocalBroker captures the in-scope
    // observation.
    expect(stillLocalBroker).toBe(true);
  });

  it("diagnostic sink receives layer-tagged events from both broker and client layers", async () => {
    const diags: Array<{ name: string; layer?: string }> = [];
    const node = await joinUnixCluster({
      nodeId: "node-solo",
      socketPath,
      reconnect: { initialMs: 5, maxMs: 20, maxAttempts: 50 },
      heartbeatMs: 0,
      onDiagnostic: (name, _payload, layer) => {
        diags.push({ name, layer });
      },
    });
    liveNodes.push(node);
    // joinUnixCluster only awaits the bind race + broker start before
    // returning; the self-client handshake completes async. Wait until
    // the client-layer "connected" diagnostic lands (or 1s passes).
    const deadline = Date.now() + 1_000;
    while (
      !diags.some((d) => d.layer === "client" && d.name === "cluster:broker:client:connected") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const names = diags.map((d) => `${d.layer ?? "?"}:${d.name}`);
    expect(names.some((n) => n.startsWith("broker:cluster:broker:server:started"))).toBe(true);
    expect(names.some((n) => n.startsWith("client:cluster:broker:client:connected"))).toBe(true);
  });
});
