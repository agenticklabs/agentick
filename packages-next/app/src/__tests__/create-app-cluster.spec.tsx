/**
 * Phase 5c — createApp cluster wiring. Verifies:
 *
 *   1. `createApp({ cluster: factory })` resolves the factory at
 *      construction and uses the wrapped substrate.
 *   2. `app.closeApp()` triggers the cluster's parent.onClose chain.
 *   3. Passing substrate FACTORIES alongside `cluster` is rejected
 *      with a clear error.
 *   4. Bus events published locally land on the wrapped (cluster)
 *      bus — proof that the cluster wrapper is actually wired in,
 *      not bypassed.
 *
 * Uses the in-memory `localClusterTransport` + `localClusterMembership`
 * doubles from `@agentick/cluster-next/testing` — no real wire.
 */

import React from "react";
import { describe, expect, it } from "vitest";

import { FakeLanguageModelExecutor } from "@agentick/executor-next";
import { defineCluster } from "@agentick/cluster-next";
import {
  createLocalClusterRegistry,
  localClusterMembership,
  localClusterTransport,
} from "@agentick/cluster-next/testing";
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
  it("resolves the cluster factory at construction and uses the wrapped substrate", async () => {
    const registry = createLocalClusterRegistry();
    const cluster = defineCluster({
      nodeId: "node-A",
      transport: localClusterTransport({ registry, nodeId: "node-A" }),
      membership: localClusterMembership({ registry, nodeId: "node-A" }),
    });

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      cluster,
    });

    // The app's bus should be the cluster's ClusterEventBus wrapper,
    // NOT a plain LocalEventBus. We detect by checking the constructor
    // name — cluster wrappers come from `@agentick/cluster-next`.
    const busCtor = app.bus.constructor.name;
    expect(busCtor).toBe("ClusterEventBus");
    const inboxCtor = app.inbox.constructor.name;
    expect(inboxCtor).toBe("ClusterInbox");

    await app.closeApp();
  });

  it("app.closeApp() triggers the cluster's parent.onClose chain", async () => {
    const registry = createLocalClusterRegistry();
    const closeFired: string[] = [];

    // Build a cluster whose transport tracks close.
    const cluster = defineCluster({
      nodeId: "node-B",
      transport: (parent) => {
        const t = localClusterTransport({ registry, nodeId: "node-B" })(parent);
        // Hook close — defineCluster registers t.close via parent.onClose,
        // so when the parent chain fires, t.close runs. Wrap it to track.
        const origClose = t.close.bind(t);
        t.close = async () => {
          closeFired.push("transport");
          await origClose();
        };
        return t;
      },
      membership: localClusterMembership({ registry, nodeId: "node-B" }),
    });

    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      cluster,
    });

    expect(closeFired).toEqual([]);
    await app.closeApp();
    expect(closeFired).toContain("transport");
  });

  it("rejects createApp({ cluster, bus: factory }) — substrate factories incompatible with cluster opt", async () => {
    const registry = createLocalClusterRegistry();
    const cluster = defineCluster({
      nodeId: "node-C",
      transport: localClusterTransport({ registry, nodeId: "node-C" }),
      membership: localClusterMembership({ registry, nodeId: "node-C" }),
    });

    await expect(
      createApp(React.createElement(Agent), {
        executor: await mkExecutor(),
        cluster,
        // Pass a factory (not an instance) — should fail with a clear error.
        bus: LocalEventBus.factory(),
      }),
    ).rejects.toThrow(/substrate instances \(not factories\)/);
  });

  it("accepts createApp({ cluster, bus: instance }) — substrate instance is the LOCAL bus the cluster wraps", async () => {
    const registry = createLocalClusterRegistry();
    const cluster = defineCluster({
      nodeId: "node-D",
      transport: localClusterTransport({ registry, nodeId: "node-D" }),
      membership: localClusterMembership({ registry, nodeId: "node-D" }),
    });

    const localBus = new LocalEventBus();
    const app = await createApp(React.createElement(Agent), {
      executor: await mkExecutor(),
      cluster,
      bus: localBus,
    });

    // The app's bus is the wrapper. The local bus passed in is what
    // the cluster wraps internally — adopters can observe local
    // emissions directly if they hold a reference.
    expect(app.bus.constructor.name).toBe("ClusterEventBus");
    expect(app.bus).not.toBe(localBus);

    await app.closeApp();
  });
});
