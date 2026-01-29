/**
 * Tests for ReconciliationScheduler
 *
 * The scheduler batches multiple state changes into single reconciliation passes.
 * This is the foundation of the reactive model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ReconciliationScheduler, type ReconcileEvent } from "../scheduler";
import type { FiberCompiler } from "../fiber-compiler";

describe("ReconciliationScheduler", () => {
  let mockCompiler: FiberCompiler;
  let reconcileFn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    reconcileFn = vi.fn().mockResolvedValue(undefined);
    mockCompiler = {
      reconcile: reconcileFn,
    } as unknown as FiberCompiler;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("basic scheduling", () => {
    it("should schedule and run reconciliation", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("test change");

      // Wait for microtask
      await Promise.resolve();
      await Promise.resolve();

      expect(reconcileFn).toHaveBeenCalledTimes(1);
    });

    it("should batch multiple schedules into one reconciliation", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change 1");
      scheduler.schedule("change 2");
      scheduler.schedule("change 3");

      // Wait for microtask
      await Promise.resolve();
      await Promise.resolve();

      expect(reconcileFn).toHaveBeenCalledTimes(1);
    });

    it("should collect reasons for debugging", async () => {
      const events: ReconcileEvent[] = [];
      const scheduler = new ReconciliationScheduler(mockCompiler, {
        onReconcile: (event) => events.push(event),
      });

      scheduler.schedule("change 1");
      scheduler.schedule("change 2");

      await Promise.resolve();
      await Promise.resolve();

      expect(events.length).toBe(1);
      expect(events[0].reasons).toContain("change 1");
      expect(events[0].reasons).toContain("change 2");
    });
  });

  describe("tick integration", () => {
    it("should not flush during tick", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.enterTick();
      scheduler.schedule("during tick");

      // Wait for microtask
      await Promise.resolve();
      await Promise.resolve();

      expect(reconcileFn).not.toHaveBeenCalled();
      expect(scheduler.isPending).toBe(true);
    });

    it("should flush after tick exits", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.enterTick();
      scheduler.schedule("during tick");
      scheduler.exitTick();

      // Wait for microtask
      await Promise.resolve();
      await Promise.resolve();

      expect(reconcileFn).toHaveBeenCalledTimes(1);
    });

    it("should track duringTick in event", async () => {
      const events: ReconcileEvent[] = [];
      const scheduler = new ReconciliationScheduler(mockCompiler, {
        onReconcile: (event) => events.push(event),
      });

      scheduler.enterTick();
      scheduler.schedule("during tick");
      scheduler.exitTick();

      await Promise.resolve();
      await Promise.resolve();

      expect(events[0].duringTick).toBe(false); // Flushed after exitTick
    });
  });

  describe("flush", () => {
    it("should flush immediately", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change");
      await scheduler.flush();

      expect(reconcileFn).toHaveBeenCalledTimes(1);
    });

    it("should be idempotent", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change");
      await scheduler.flush();
      await scheduler.flush();

      expect(reconcileFn).toHaveBeenCalledTimes(1);
    });

    it("should flush during tick", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.enterTick();
      scheduler.schedule("change");
      await scheduler.flush();

      expect(reconcileFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("cancel", () => {
    it("should cancel pending reconciliation", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change");
      scheduler.cancel();

      await Promise.resolve();
      await Promise.resolve();

      expect(reconcileFn).not.toHaveBeenCalled();
    });

    it("should clear pending reasons", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change 1");
      scheduler.schedule("change 2");
      scheduler.cancel();

      expect(scheduler.reasons.length).toBe(0);
    });
  });

  describe("isPending", () => {
    it("should be false initially", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);
      expect(scheduler.isPending).toBe(false);
    });

    it("should be true after schedule", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);
      scheduler.schedule("change");
      expect(scheduler.isPending).toBe(true);
    });

    it("should be false after flush", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);
      scheduler.schedule("change");
      await scheduler.flush();
      expect(scheduler.isPending).toBe(false);
    });
  });

  describe("performance tracking", () => {
    it("should measure reconciliation duration", async () => {
      const events: ReconcileEvent[] = [];

      // Slow reconcile
      reconcileFn.mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      const scheduler = new ReconciliationScheduler(mockCompiler, {
        onReconcile: (event) => events.push(event),
      });

      scheduler.schedule("change");
      await scheduler.flush();

      expect(events[0].duration).toBeGreaterThan(0);
    });
  });

  describe("observable state", () => {
    it("should expose initial idle state", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);
      const state = scheduler.state();

      expect(state.status).toBe("idle");
      expect(state.pendingReasons).toEqual([]);
      expect(state.lastReconcileAt).toBeNull();
      expect(state.lastReconcileDuration).toBeNull();
      expect(state.reconcileCount).toBe(0);
      expect(state.inTick).toBe(false);
    });

    it("should update state to pending on schedule", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("test reason");
      const state = scheduler.state();

      expect(state.status).toBe("pending");
      expect(state.pendingReasons).toContain("test reason");
    });

    it("should accumulate pending reasons", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("reason 1");
      scheduler.schedule("reason 2");
      scheduler.schedule("reason 3");
      const state = scheduler.state();

      expect(state.pendingReasons).toContain("reason 1");
      expect(state.pendingReasons).toContain("reason 2");
      expect(state.pendingReasons).toContain("reason 3");
    });

    it("should update state to in_tick on enterTick", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.enterTick();
      const state = scheduler.state();

      expect(state.status).toBe("in_tick");
      expect(state.inTick).toBe(true);
    });

    it("should update state on exitTick", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.enterTick();
      scheduler.exitTick();
      const state = scheduler.state();

      expect(state.status).toBe("idle");
      expect(state.inTick).toBe(false);
    });

    it("should update state to pending on exitTick if work is pending", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.enterTick();
      scheduler.schedule("pending work");
      scheduler.exitTick();
      const state = scheduler.state();

      expect(state.status).toBe("pending");
      expect(state.inTick).toBe(false);
    });

    it("should update state to reconciling during flush", async () => {
      const statesDuringReconcile: string[] = [];

      reconcileFn.mockImplementation(async () => {
        // Capture state during reconciliation
        statesDuringReconcile.push(scheduler.state().status);
        await Promise.resolve();
      });

      const scheduler = new ReconciliationScheduler(mockCompiler);
      scheduler.schedule("change");
      await scheduler.flush();

      expect(statesDuringReconcile).toContain("reconciling");
    });

    it("should update state to idle after flush", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change");
      await scheduler.flush();
      const state = scheduler.state();

      expect(state.status).toBe("idle");
      expect(state.pendingReasons).toEqual([]);
    });

    it("should track reconciliation metrics after flush", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change");
      await scheduler.flush();
      const state = scheduler.state();

      expect(state.reconcileCount).toBe(1);
      expect(state.lastReconcileAt).toBeGreaterThan(0);
      expect(state.lastReconcileDuration).toBeGreaterThanOrEqual(0);
    });

    it("should increment reconcileCount on each flush", async () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change 1");
      await scheduler.flush();

      scheduler.schedule("change 2");
      await scheduler.flush();

      scheduler.schedule("change 3");
      await scheduler.flush();

      expect(scheduler.state().reconcileCount).toBe(3);
    });

    it("should reset state on cancel", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change");
      scheduler.cancel();
      const state = scheduler.state();

      expect(state.status).toBe("idle");
      expect(state.pendingReasons).toEqual([]);
    });

    it("should provide status accessor", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      expect(scheduler.status).toBe("idle");

      scheduler.schedule("change");
      expect(scheduler.status).toBe("pending");

      scheduler.enterTick();
      expect(scheduler.status).toBe("in_tick");
    });

    it("should dispose signal on dispose", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.schedule("change");
      scheduler.dispose();

      expect(scheduler.state.disposed).toBe(true);
    });

    it("should have state signal that can be read at any time", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      // Initial state readable
      expect(scheduler.state().status).toBe("idle");

      // State changes are immediately reflected
      scheduler.schedule("test");
      expect(scheduler.state().status).toBe("pending");

      scheduler.enterTick();
      expect(scheduler.state().status).toBe("in_tick");

      scheduler.exitTick();
      // After exitTick with pending work, status becomes pending
      expect(scheduler.state().status).toBe("pending");
    });

    it("should expose state as a signal with callable interface", () => {
      const scheduler = new ReconciliationScheduler(mockCompiler);

      // Signal is callable
      expect(typeof scheduler.state).toBe("function");

      // Calling returns SchedulerState
      const state = scheduler.state();
      expect(state).toHaveProperty("status");
      expect(state).toHaveProperty("pendingReasons");
      expect(state).toHaveProperty("reconcileCount");
    });
  });
});
