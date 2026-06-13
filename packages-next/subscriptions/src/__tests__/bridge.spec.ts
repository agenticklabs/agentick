/**
 * SubscriptionBridge — core declare/dispatch/snapshot behavior.
 */

import { describe, expect, it, vi } from "vitest";
import type { SubscriptionIntent } from "@agentick/spec-next";

import { createSubscriptionBridge, type SubscriptionHandler } from "../bridge.js";

const cron = (id: string, expr: string): SubscriptionIntent => ({
  id,
  kind: "cron",
  config: { expr },
});

describe("createSubscriptionBridge — declare/dispatch", () => {
  it("declare adds the intent to list()", () => {
    const bridge = createSubscriptionBridge();
    bridge.declare(cron("c1", "@hourly"), async () => {});
    expect(bridge.list().map((i) => i.id)).toEqual(["c1"]);
  });

  it("dispatch invokes the handler with ctx", async () => {
    const bridge = createSubscriptionBridge({ sessionId: "sess-1" });
    const handler = vi.fn<SubscriptionHandler>(async () => {});
    bridge.declare(cron("c1", "@daily"), handler);
    await bridge.dispatch("c1", { firedAt: 42 });
    expect(handler).toHaveBeenCalledTimes(1);
    const [event, ctx] = handler.mock.calls[0]!;
    expect(event).toEqual({ firedAt: 42 });
    expect(ctx!.id).toBe("c1");
    expect(ctx!.sessionId).toBe("sess-1");
    expect(ctx!.signal.aborted).toBe(false);
  });

  it("dispatch passes metadata into ctx", async () => {
    const bridge = createSubscriptionBridge();
    let observedMeta: Readonly<Record<string, unknown>> | undefined;
    bridge.declare(cron("c1", "@hourly"), async (_e, ctx) => {
      observedMeta = ctx.metadata;
    });
    await bridge.dispatch("c1", {}, { metadata: { tenantId: "t-1" } });
    expect(observedMeta).toEqual({ tenantId: "t-1" });
  });

  it("re-declaring the same id aborts the previous controller", async () => {
    const bridge = createSubscriptionBridge();
    let firstSignal: AbortSignal | null = null;
    bridge.declare(cron("c1", "@hourly"), async (_e, ctx) => {
      firstSignal = ctx.signal;
    });
    await bridge.dispatch("c1", null);
    expect(firstSignal!.aborted).toBe(false);

    bridge.declare(cron("c1", "@daily"), async () => {});
    expect(firstSignal!.aborted).toBe(true);
  });

  it("dispatch on unknown id throws", async () => {
    const bridge = createSubscriptionBridge();
    await expect(bridge.dispatch("missing", null)).rejects.toThrow(/no handler/);
  });

  it("declare's return unsubscribes", () => {
    const bridge = createSubscriptionBridge();
    const unsub = bridge.declare(cron("c1", "@hourly"), async () => {});
    expect(bridge.list()).toHaveLength(1);
    unsub();
    expect(bridge.list()).toHaveLength(0);
  });
});

describe("createSubscriptionBridge — snapshot/restore", () => {
  it("exports and re-imports intents", () => {
    const bridge = createSubscriptionBridge();
    bridge.declare(cron("c1", "@hourly"), async () => {});
    bridge.declare(cron("c2", "@daily"), async () => {});
    const snap = bridge.exportSnapshot();
    expect(snap.map((s) => s.id).sort()).toEqual(["c1", "c2"]);

    const next = createSubscriptionBridge();
    next.importSnapshot(snap);
    expect(
      next
        .list()
        .map((i) => i.id)
        .sort(),
    ).toEqual(["c1", "c2"]);
  });

  it("pending intents (no handler) reject dispatch", async () => {
    const bridge = createSubscriptionBridge();
    bridge.importSnapshot([cron("c1", "@hourly")]);
    await expect(bridge.dispatch("c1", null)).rejects.toThrow(/no handler/i);
  });

  it("re-declaring an imported intent promotes pending → live", async () => {
    const bridge = createSubscriptionBridge();
    bridge.importSnapshot([cron("c1", "@hourly")]);
    const handler = vi.fn(async () => {});
    bridge.declare(cron("c1", "@hourly"), handler);
    await bridge.dispatch("c1", { firedAt: 1 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("createSubscriptionBridge — subscribe", () => {
  it("fires the listener on declare + unregister", () => {
    const bridge = createSubscriptionBridge();
    const listener = vi.fn();
    bridge.subscribe(listener);
    const unsub = bridge.declare(cron("c1", "@hourly"), async () => {});
    expect(listener).toHaveBeenCalledTimes(1);
    unsub();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
