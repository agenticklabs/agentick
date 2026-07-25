/**
 * `joinWsCluster` — WS ergonomic facade. Mirrors the
 * `joinUnixCluster` spec shape, exercising the two role modes
 * (`"broker"` / `"client"`) end-to-end against an in-process server.
 */

import { createServer } from "node:net";

import type { ClusterNode } from "@agentick/cluster";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { joinWsCluster } from "../join-ws-cluster.js";

async function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const addr = probe.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        probe.close(() => resolve(port));
      } else {
        reject(new Error("ephemeralPort: no address"));
      }
    });
  });
}

describe("joinWsCluster — ergonomic facade", () => {
  let url: string;
  const liveNodes: ClusterNode[] = [];

  beforeEach(async () => {
    const port = await ephemeralPort();
    url = `ws://127.0.0.1:${port}/cluster`;
  });

  afterEach(async () => {
    while (liveNodes.length > 0) {
      const node = liveNodes.pop();
      if (node) await node.close();
    }
  });

  async function spawn(nodeId: string, mode: "broker" | "client"): Promise<ClusterNode> {
    const node = await joinWsCluster({
      nodeId,
      url,
      mode,
      reconnect: { initialMs: 5, maxMs: 20, maxAttempts: 50 },
      heartbeatMs: 0,
    });
    liveNodes.push(node);
    return node;
  }

  it("mode: 'broker' starts the broker; mode: 'client' joins existing broker; bus + waitForPeers end-to-end", async () => {
    const a = await spawn("node-A", "broker");
    expect(a.role).toBe("broker");
    expect(a.localBrokerRunning()).toBe(true);

    const b = await spawn("node-B", "client");
    expect(b.role).toBe("client");
    expect(b.localBrokerRunning()).toBe(false);

    await b.membership.waitForPeers(1, { timeoutMs: 2_000 });
    const received: string[] = [];
    a.bus.subscribe("ping", (env) => {
      received.push((env.payload as { msg: string }).msg);
    });
    await b.bus.broadcast("ping", { msg: "hi" });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual(["hi"]);
  });

  it("diagnostic sink receives layer-tagged broker + client events", async () => {
    const diags: Array<{ name: string; layer?: string }> = [];
    const node = await joinWsCluster({
      nodeId: "node-solo",
      url,
      mode: "broker",
      reconnect: { initialMs: 5, maxMs: 20, maxAttempts: 50 },
      heartbeatMs: 0,
      onDiagnostic: (name, _payload, layer) => {
        diags.push({ name, layer });
      },
    });
    liveNodes.push(node);
    const deadline = Date.now() + 2_000;
    while (
      !diags.some((d) => d.layer === "client" && d.name === "cluster:broker:client:connected") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(
      diags.some((d) => d.layer === "broker" && d.name === "cluster:broker:server:started"),
    ).toBe(true);
    expect(
      diags.some((d) => d.layer === "client" && d.name === "cluster:broker:client:connected"),
    ).toBe(true);
  });

  it("close() is idempotent and Symbol.asyncDispose works", async () => {
    const a = await spawn("node-A", "broker");
    await a.close();
    await expect(a.close()).resolves.toBeUndefined();
    liveNodes.pop();
    {
      const b = await joinWsCluster({
        nodeId: "node-B",
        url,
        mode: "broker",
        reconnect: { initialMs: 5, maxMs: 20, maxAttempts: 50 },
        heartbeatMs: 0,
      });
      await b[Symbol.asyncDispose]();
      await expect(b[Symbol.asyncDispose]()).resolves.toBeUndefined();
    }
  });
});
