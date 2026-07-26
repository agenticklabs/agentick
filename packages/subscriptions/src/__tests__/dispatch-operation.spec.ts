/**
 * ADR 92 §Family 1 item 2 — subscription dispatch IS an operation.
 *
 * The claim under test: a cron/scheduler fire or an external driver no longer
 * reaches the declared handler as a bare callback. It goes through
 * `subscriptions:command:dispatch` — so it is guardable, hookable, and leaves
 * an audit record.
 *
 * Pins, one describe per contract clause:
 *
 *   1. A driver fire emits `subscriptions:command:dispatch` with the
 *      `{ sessionId, subscriptionId }` scope, and both `requested` and
 *      `terminal` are JOURNALED (PERSISTED policy), not bus-only.
 *   2. A guard veto blocks a scheduled fire — the handler never runs and the
 *      terminal outcome is `vetoed`.
 *   3. The bare bridge (no injected runner) still dispatches directly.
 *
 * @see docs/proposals/v2/blueprint/92-operation-grammar-completion.md
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Fiber, Stream } from "effect";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { ProtocolEvent, SubscriptionIntent } from "@agentick/spec";

import { createSubscriptionBridge, type SubscriptionBridge } from "../bridge.js";
import { SubscriptionsHarness } from "../harness.js";
import { attachInProcessScheduler } from "../scheduler.js";

// ============================================================================
// Fixtures
// ============================================================================

const OP_NAME = "subscriptions:command:dispatch";

const cron = (id: string, expr: string): SubscriptionIntent => ({
  id,
  kind: "cron",
  config: { expr },
});

interface Rig {
  readonly bridge: SubscriptionBridge;
  readonly harness: SubscriptionsHarness;
  readonly journal: MemoryJournal;
  readonly events: ProtocolEvent[];
  readonly stop: () => Promise<void>;
}

/**
 * Wire the harness + bridge exactly as `withSubscriptions` does — the harness's
 * registry lookup reads the bridge, the bridge's runner is the harness's
 * `runDispatch` — against a bus + journal we own, so every envelope is
 * observable and the journal proves policy.
 */
async function rig(sessionId = "sess-1"): Promise<Rig> {
  const bus = new LocalEventBus();
  const journal = new MemoryJournal({ capacity: 4096 });
  let bridge: SubscriptionBridge | undefined;
  const harness = new SubscriptionsHarness("app-1", journal, bus, new LocalInbox(), {
    resolveInvoker: (id) => bridge?.invoker(id),
  });
  await harness.ready;
  bridge = createSubscriptionBridge({
    sessionId,
    runDispatch: harness.runDispatch,
    harness,
  });

  const events: ProtocolEvent[] = [];
  const fiber = Effect.runFork(
    Stream.runForEach(bus.subscribe({ surface: "subscriptions" }), (e) =>
      Effect.sync(() => {
        events.push(e);
      }),
    ),
  );

  return {
    bridge,
    harness,
    journal,
    events,
    stop: async () => {
      await harness.close();
      await Effect.runPromise(Fiber.interrupt(fiber));
    },
  };
}

/** Settle the microtask + bus fan-out queue. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function opsNamed(events: readonly ProtocolEvent[], name: string): readonly ProtocolEvent[] {
  return events.filter((e) => e.name === name);
}

async function journaled(journal: MemoryJournal, name: string): Promise<readonly ProtocolEvent[]> {
  const out = await Effect.runPromise(
    Stream.runCollect(journal.readByQuery({ name: { exact: name } }, "beginning")),
  );
  return Array.from(out);
}

let active: Rig | undefined;
afterEach(async () => {
  await active?.stop();
  active = undefined;
  vi.useRealTimers();
});

// ============================================================================
// 1 — the op, its scope, and its journal policy
// ============================================================================

describe("a driver fire runs as subscriptions:command:dispatch", () => {
  it("emits the op with the sessionId + subscriptionId scope", async () => {
    const r = (active = await rig("sess-7"));
    const handler = vi.fn(async () => {});
    r.bridge.declare(cron("nightly", "@daily"), handler);

    await r.bridge.dispatch("nightly", { firedAt: 1 }, { metadata: { tenantId: "t-1" } });
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    const ops = opsNamed(r.events, OP_NAME);
    expect(ops.length).toBeGreaterThan(0);
    for (const e of ops) {
      expect(e.surface).toBe("subscriptions");
      expect(e.scope.sessionId).toBe("sess-7");
      expect(e.scope.subscriptionId).toBe("nightly");
    }
    const terminal = ops.find((e) => e.phase === "terminal")!;
    expect(terminal.outcome).toBe("succeeded");
  });

  it("journals BOTH requested and terminal (persisted policy, not bus-only)", async () => {
    const r = (active = await rig());
    r.bridge.declare(cron("hourly", "@hourly"), async () => {});

    await r.bridge.dispatch("hourly", { firedAt: 2 });
    await settle();

    const rows = await journaled(r.journal, OP_NAME);
    const phases = rows.map((e) => e.phase);
    expect(phases).toContain("requested");
    expect(phases).toContain("terminal");
    expect(rows.every((e) => e.scope.subscriptionId === "hourly")).toBe(true);
  });

  it("the in-process scheduler's tick takes the same op path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T10:00:00.000Z"));
    const r = (active = await rig());
    const detach = attachInProcessScheduler(r.bridge);
    const handler = vi.fn(async () => {});
    r.bridge.declare(cron("tick", "@hourly"), handler);

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(20);
    detach();

    expect(handler).toHaveBeenCalledTimes(1);
    const terminal = opsNamed(r.events, OP_NAME).find((e) => e.phase === "terminal");
    expect(terminal?.outcome).toBe("succeeded");
    expect(terminal?.scope.subscriptionId).toBe("tick");
  });

  it("carries the driver payload + metadata as the op input (signal form, no handler)", async () => {
    const r = (active = await rig("sess-9"));
    r.bridge.declare(cron("webhookish", "@daily"), async () => {});

    await r.bridge.dispatch("webhookish", { body: "hi" }, { metadata: { tenantId: "t-2" } });
    await settle();

    const requested = opsNamed(r.events, OP_NAME).find((e) => e.phase === "requested")!;
    expect(requested.payload).toEqual({
      id: "webhookish",
      sessionId: "sess-9",
      event: { body: "hi" },
      metadata: { tenantId: "t-2" },
    });
  });
});

// ============================================================================
// 2 — the guard seam
// ============================================================================

describe("a guard veto blocks a scheduled fire", () => {
  it("the handler never runs and the terminal outcome is vetoed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T10:00:00.000Z"));
    const r = (active = await rig());
    const detach = attachInProcessScheduler(r.bridge);
    const handler = vi.fn(async () => {});
    r.bridge.declare(cron("quiet", "@hourly"), handler);

    r.harness.guard(() => ({ kind: "veto", reason: "quiet-hours" }));

    // The scheduler swallows the rejection; the op still terminates `vetoed`.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(20);
    detach();

    expect(handler).not.toHaveBeenCalled();
    const terminal = opsNamed(r.events, OP_NAME).find((e) => e.phase === "terminal");
    expect(terminal?.outcome).toBe("vetoed");
  });

  it("a direct driver fire surfaces the veto as a rejection", async () => {
    const r = (active = await rig());
    const handler = vi.fn(async () => {});
    r.bridge.declare(cron("blocked", "@daily"), handler);
    r.harness.guard(() => ({ kind: "veto", reason: "policy" }));

    await expect(r.bridge.dispatch("blocked", null)).rejects.toBeTruthy();
    await settle();

    expect(handler).not.toHaveBeenCalled();
    const vetoed = await journaled(r.journal, OP_NAME);
    expect(vetoed.find((e) => e.phase === "terminal")?.outcome).toBe("vetoed");
  });

  it("a guard reading the input can veto ONE subscription and let a sibling through", async () => {
    const r = (active = await rig());
    const blocked = vi.fn(async () => {});
    const allowed = vi.fn(async () => {});
    r.bridge.declare(cron("blocked", "@daily"), blocked);
    r.bridge.declare(cron("allowed", "@daily"), allowed);
    r.harness.guard<{ readonly id: string }>((input) =>
      input.id === "blocked" ? { kind: "veto", reason: "policy" } : undefined,
    );

    await expect(r.bridge.dispatch("blocked", null)).rejects.toBeTruthy();
    await r.bridge.dispatch("allowed", null);
    await settle();

    expect(blocked).not.toHaveBeenCalled();
    expect(allowed).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 3 — the bare bridge is unchanged
// ============================================================================

describe("the bare bridge (no runDispatch) dispatches directly", () => {
  it("invokes the handler with no operation in the way", async () => {
    const bridge = createSubscriptionBridge({ sessionId: "bare" });
    const handler = vi.fn(async () => {});
    bridge.declare(cron("c1", "@hourly"), handler);
    await bridge.dispatch("c1", { firedAt: 3 });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bridge.harness).toBeUndefined();
  });

  it("exposes invoker() as the registry seam, undefined for an undeclared id", async () => {
    const bridge = createSubscriptionBridge({ sessionId: "bare" });
    const handler = vi.fn(async () => {});
    bridge.declare(cron("c1", "@hourly"), handler);

    expect(bridge.invoker("nope")).toBeUndefined();
    await bridge.invoker("c1")!({ firedAt: 4 }, { tenantId: "t" });
    expect(handler).toHaveBeenCalledTimes(1);
    const [, ctx] = handler.mock.calls[0] as unknown as [
      unknown,
      { readonly id: string; readonly sessionId: string; readonly metadata: unknown },
    ];
    expect(ctx.id).toBe("c1");
    expect(ctx.sessionId).toBe("bare");
    expect(ctx.metadata).toEqual({ tenantId: "t" });
  });
});

// ============================================================================
// 4 — the harness surfaces on the bridge for guard registration
// ============================================================================

describe("bridge.harness is the guard-registration handle", () => {
  it("a guard registered through bridges.subscriptions.harness takes effect", async () => {
    const r = (active = await rig());
    const handler = vi.fn(async () => {});
    r.bridge.declare(cron("c1", "@daily"), handler);

    r.bridge.harness!.guard(() => ({ kind: "veto", reason: "via-bridge" }));

    await expect(r.bridge.dispatch("c1", null)).rejects.toBeTruthy();
    expect(handler).not.toHaveBeenCalled();
  });
});
