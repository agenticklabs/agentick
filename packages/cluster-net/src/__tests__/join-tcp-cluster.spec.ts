/**
 * `joinTcpCluster` — TCP ergonomic facade. Mirrors the
 * `joinUnixCluster` spec shape, exercising the three role modes
 * (`"broker"` / `"client"` / `"auto"`).
 */

import { createServer } from "node:net";

import type { ClusterNode } from "@agentick/cluster";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { joinTcpCluster } from "../join-tcp-cluster.js";

async function ephemeralPort(): Promise<number> {
  // Bind a server to port 0, read the assigned port, close — the
  // tester then reuses that port. Race-prone in theory; fine in
  // practice for isolated test runs.
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("ephemeralPort: no address"));
      }
    });
  });
}

describe("joinTcpCluster — ergonomic facade", () => {
  let port: number;
  const liveNodes: ClusterNode[] = [];

  beforeEach(async () => {
    port = await ephemeralPort();
  });

  afterEach(async () => {
    while (liveNodes.length > 0) {
      const node = liveNodes.pop();
      if (node) await node.close();
    }
  });

  async function spawn(nodeId: string, mode: "broker" | "client" | "auto"): Promise<ClusterNode> {
    const node = await joinTcpCluster({
      nodeId,
      host: "127.0.0.1",
      port,
      mode,
      reconnect: { initialMs: 5, maxMs: 20, maxAttempts: 50 },
      heartbeatMs: 0,
    });
    liveNodes.push(node);
    return node;
  }

  it("mode: 'broker' starts the broker and joins as client; mode: 'client' joins existing broker", async () => {
    const a = await spawn("node-A", "broker");
    expect(a.role).toBe("broker");
    expect(a.localBrokerRunning()).toBe(true);

    const b = await spawn("node-B", "client");
    expect(b.role).toBe("client");
    expect(b.localBrokerRunning()).toBe(false);

    // Verify the wire is live end-to-end via name-based bus.
    await b.membership.waitForPeers(1, { timeoutMs: 2_000 });
    const received: string[] = [];
    a.bus.subscribe("ping", (env) => {
      received.push((env.payload as { msg: string }).msg);
    });
    await b.bus.broadcast("ping", { msg: "hi" });
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual(["hi"]);
  });

  it("mode: 'auto' races to bind; loser joins as client", async () => {
    const a = await spawn("node-A", "auto");
    expect(a.role).toBe("broker");
    expect(a.localBrokerRunning()).toBe(true);
    // Second "auto" hits EADDRINUSE — falls back to client.
    const b = await spawn("node-B", "auto");
    expect(b.role).toBe("client");
    expect(b.localBrokerRunning()).toBe(false);
  });

  it("diagnostic sink receives layer-tagged broker + client events", async () => {
    const diags: Array<{ name: string; layer?: string }> = [];
    const node = await joinTcpCluster({
      nodeId: "node-solo",
      host: "127.0.0.1",
      port,
      mode: "broker",
      reconnect: { initialMs: 5, maxMs: 20, maxAttempts: 50 },
      heartbeatMs: 0,
      onDiagnostic: (name, _payload, layer) => {
        diags.push({ name, layer });
      },
    });
    liveNodes.push(node);
    // Wait for the self-client to handshake.
    const deadline = Date.now() + 1_000;
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
});
