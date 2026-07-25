/**
 * Subscription JSX components — declare via the bridge on mount.
 */

import React from "react";
import { describe, expect, it, vi } from "vitest";

import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { CompilerHarness } from "@agentick/compiler-react";
import { fakeBridges } from "@agentick/compiler";
import type { HookBridges } from "@agentick/spec";

import { createSubscriptionBridge } from "../../bridge.js";
import { Cron, Webhook, EventListener } from "../components.js";

async function makeHarness() {
  const h = new CompilerHarness(
    "h_sub",
    new MemoryJournal(),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await h.ready;
  return h;
}

describe("<Cron> — declare via bridge", () => {
  it("registers a cron intent on mount and dispatches the handler", async () => {
    const bridge = createSubscriptionBridge();
    const bridges: HookBridges = {
      ...fakeBridges(),
      subscriptions: bridge,
    } as HookBridges;
    const onTick = vi.fn(async () => {});

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m1",
      sessionId: "s1",
      element: React.createElement(Cron, {
        id: "c1",
        expr: "@hourly",
        onTick,
      }),
      bridges,
    });
    await harness.renderTree({ mountId: "m1", sessionId: "s1" });

    const declared = bridge.list();
    expect(declared).toEqual([{ id: "c1", kind: "cron", config: { expr: "@hourly" } }]);

    await bridge.dispatch("c1", { firedAt: 1 });
    expect(onTick).toHaveBeenCalledTimes(1);
  });
});

describe("<Webhook> — declare via bridge", () => {
  it("registers a webhook intent with path + method", async () => {
    const bridge = createSubscriptionBridge();
    const bridges: HookBridges = {
      ...fakeBridges(),
      subscriptions: bridge,
    } as HookBridges;
    const onRequest = vi.fn(async () => {});

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m2",
      sessionId: "s2",
      element: React.createElement(Webhook, {
        id: "w1",
        path: "/events",
        method: "POST",
        onRequest,
      }),
      bridges,
    });
    await harness.renderTree({ mountId: "m2", sessionId: "s2" });

    expect(bridge.list()).toEqual([
      {
        id: "w1",
        kind: "webhook",
        config: { path: "/events", method: "POST" },
      },
    ]);
  });
});

describe("<EventListener> — declare via bridge", () => {
  it("registers an event-listener intent with channel", async () => {
    const bridge = createSubscriptionBridge();
    const bridges: HookBridges = {
      ...fakeBridges(),
      subscriptions: bridge,
    } as HookBridges;
    const onEvent = vi.fn(async () => {});

    const harness = await makeHarness();
    await harness.mount({
      mountId: "m3",
      sessionId: "s3",
      element: React.createElement(EventListener, {
        id: "e1",
        channel: "user.created",
        onEvent,
      }),
      bridges,
    });
    await harness.renderTree({ mountId: "m3", sessionId: "s3" });

    expect(bridge.list()).toEqual([
      {
        id: "e1",
        kind: "event-listener",
        config: { channel: "user.created" },
      },
    ]);
  });
});

describe("subscription components — error when bridge missing", () => {
  it("throws a clear error if `withSubscriptions()` isn't installed", async () => {
    const bridges: HookBridges = fakeBridges();
    const harness = await makeHarness();
    await harness.mount({
      mountId: "m4",
      sessionId: "s4",
      element: React.createElement(Cron, {
        id: "c",
        expr: "@hourly",
        onTick: () => {},
      }),
      bridges,
    });
    await expect(harness.renderTree({ mountId: "m4", sessionId: "s4" })).rejects.toMatchObject({
      _tag: "RenderFailed",
    });
  });
});
