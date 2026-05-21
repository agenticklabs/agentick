/**
 * In-process scheduler — fires cron intents via setTimeout.
 *
 * Uses fake timers to drive the clock forward deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSubscriptionBridge } from "../bridge.js";
import { attachInProcessScheduler } from "../scheduler.js";

describe("attachInProcessScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Anchor at a stable wall-clock so the next-minute math is
    // predictable across runs.
    vi.setSystemTime(new Date("2026-05-20T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires the handler when an @hourly intent's window arrives", async () => {
    const bridge = createSubscriptionBridge();
    const unsubscribe = attachInProcessScheduler(bridge);
    const handler = vi.fn(async () => {});
    bridge.declare(
      { id: "c", kind: "cron", config: { expr: "@hourly" } },
      handler,
    );
    // @hourly fires on the next :00. We're at 10:00:00, so the
    // next fire is 11:00:00 — one hour out.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(handler).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not fire after the unsubscribe handle is invoked", async () => {
    const bridge = createSubscriptionBridge();
    const detach = attachInProcessScheduler(bridge);
    const handler = vi.fn(async () => {});
    bridge.declare(
      { id: "c", kind: "cron", config: { expr: "@hourly" } },
      handler,
    );
    detach();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("ignores intents whose kind is not 'cron'", async () => {
    const bridge = createSubscriptionBridge();
    attachInProcessScheduler(bridge);
    const handler = vi.fn(async () => {});
    bridge.declare(
      { id: "w", kind: "webhook", config: { path: "/x" } },
      handler,
    );
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("schedules an explicit 5-field expression", async () => {
    const bridge = createSubscriptionBridge();
    attachInProcessScheduler(bridge);
    const handler = vi.fn(async () => {});
    // Every minute
    bridge.declare(
      { id: "c", kind: "cron", config: { expr: "* * * * *" } },
      handler,
    );
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
