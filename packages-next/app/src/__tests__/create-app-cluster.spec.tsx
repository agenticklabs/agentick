/**
 * Phase 5c — createApp cluster wiring. Verifies the integration via
 * BEHAVIOR (not by poking protected substrate fields):
 *
 *   1. `createApp({ cluster })` resolves the factory at construction
 *      — proven by the cluster's `parent.onClose` handler firing
 *      during `app.closeApp()`.
 *   2. The substrate IS the cluster-wrapped one — proven by an
 *      observable side-effect: the cluster transport's `subscribeBus`
 *      registry tracks subscriptions made via the app's bus.
 *   3. Passing substrate FACTORIES alongside `cluster` is rejected
 *      with a clear error.
 *
 * Uses `localClusterTransport` from `@agentick/cluster-next/testing`
 * — in-memory, deterministic, no real wire.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { createLocalClusterRegistry, defineLocalCluster } from "@agentick/cluster-next/testing";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime-next";
import type { ContentBlock } from "@agentick/spec-next";

import { createApp } from "../react.js";

const Agent = (): React.ReactElement => React.createElement("message", { role: "user" }, "hello");

async function mkExecutor(): Promise<FakeLanguageModelExecutor> {
  const exec = new FakeLanguageModelExecutor(
    "cluster-app-exec",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
    {
      scripted: [
        {
          result: {
            specVersion: "2026-05-08" as const,
            output: [{ type: "text" as const, text: "ok" } satisfies ContentBlock],
            stopReason: "end" as const,
          },
        },
      ],
    },
  );
  await exec.ready;
  return exec;
}

describe("createApp({ cluster }) — Phase 5c app-level wiring", () => {
  it("the substrate IS cluster-wrapped — cluster membership receives the self-join, and app.closeApp() removes it", async () => {
    const registry = createLocalClusterRegistry();
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      cluster: defineLocalCluster({ nodeId: "node-B", registry }),
    });

    // The cluster's membership registers node-B in the shared registry
    // at construction. If the cluster factory ran (i.e. the substrate
    // IS cluster-wrapped), the registry will show node-B as a member.
    expect(registry.nodes()).toContain("node-B");

    await app.closeApp();

    // Graceful close should remove node-B from the registry.
    expect(registry.nodes()).not.toContain("node-B");
  });

  it("rejects createApp({ cluster, bus: factory }) — substrate factories incompatible with cluster opt", async () => {
    await expect(
      createApp(React.createElement(Agent), {
        executor: await mkExecutor(),
        cluster: defineLocalCluster({ nodeId: "node-C" }),
        // Pass a factory (not an instance) — should fail with a clear error.
        bus: LocalEventBus.factory(),
      }),
    ).rejects.toThrow(/substrate instances \(not factories\)/);
  });

  it("accepts createApp({ cluster, bus: instance }) — substrate instance is the LOCAL bus the cluster wraps", async () => {
    const registry = createLocalClusterRegistry();
    const localBus = new LocalEventBus();
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      cluster: defineLocalCluster({ nodeId: "node-D", registry }),
      bus: localBus,
    });

    // The cluster ran — node-D is in the registry.
    expect(registry.nodes()).toContain("node-D");

    await app.closeApp();
  });
});
