/**
 * Integration tests for the Reactive Model
 *
 * Tests the full reactive flow:
 * - Reconciliation happens anytime on state change (components are "alive")
 * - Compilation only happens during ticks (produces model input)
 * - useTick() provides tick control to components
 * - useChannel() enables pub/sub communication
 * - ReconciliationScheduler batches updates
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { FiberCompiler } from "../fiber-compiler";
import { ReconciliationScheduler } from "../scheduler";
import { COM } from "../../com/object-model";
import { Channel } from "../../core/channel";
import { jsx } from "../../jsx/jsx-runtime";
import { Section } from "../../jsx/components/primitives";
import { useState, useEffect, useSignal, useTick, useChannel } from "../../state/hooks";
import type { TickState } from "../../component/component";

describe("Reactive Model Integration", () => {
  let com: COM;
  let compiler: FiberCompiler;

  const createTickState = (tick = 1): TickState => ({
    tick,
    stop: vi.fn(),
    queuedMessages: [],
  });

  beforeEach(() => {
    com = new COM();
    compiler = new FiberCompiler(com);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("reconcile/compile separation", () => {
    it("should preserve state across multiple reconciliations", async () => {
      const renderCounts: number[] = [];
      let signalRef: ReturnType<typeof useSignal<number>> | undefined;

      const Counter = () => {
        const count = useSignal(0);
        signalRef = count;
        renderCounts.push(count());
        return jsx(Section, { id: "counter", children: `Count: ${count()}` });
      };

      // First reconcile
      await compiler.reconcile(jsx(Counter, {}), { tickState: createTickState(1) });
      expect(renderCounts).toEqual([0]);

      // Update state
      signalRef!.set(1);

      // Second reconcile
      await compiler.reconcile(undefined, { tickState: createTickState(2) });
      expect(renderCounts).toEqual([0, 1]);

      // Third reconcile with another update
      signalRef!.set(2);
      await compiler.reconcile(undefined, { tickState: createTickState(3) });
      expect(renderCounts).toEqual([0, 1, 2]);
    });

    it("should collect structures without re-running effects", async () => {
      const effectRuns: string[] = [];

      const EffectComponent = () => {
        useEffect(() => {
          effectRuns.push("effect");
        }, []);
        return jsx(Section, { id: "test", children: "Hello" });
      };

      await compiler.reconcile(jsx(EffectComponent, {}), { tickState: createTickState() });
      expect(effectRuns).toEqual(["effect"]);

      // Multiple collects should not run effects
      compiler.collect();
      compiler.collect();
      compiler.collect();

      expect(effectRuns).toEqual(["effect"]);
    });
  });

  describe("ReconciliationScheduler integration", () => {
    it("should batch multiple state changes into single reconciliation", async () => {
      const reconcileCalls: string[][] = [];

      const mockCompiler = {
        reconcile: vi.fn().mockImplementation(() => {
          return Promise.resolve();
        }),
      } as unknown as FiberCompiler;

      const scheduler = new ReconciliationScheduler(mockCompiler, {
        onReconcile: (event) => {
          reconcileCalls.push([...event.reasons]);
        },
      });

      // Multiple schedules in same microtask
      scheduler.schedule("change A");
      scheduler.schedule("change B");
      scheduler.schedule("change C");

      // Wait for flush
      await scheduler.flush();

      // Should have single reconciliation with all reasons
      expect(reconcileCalls.length).toBe(1);
      expect(reconcileCalls[0]).toContain("change A");
      expect(reconcileCalls[0]).toContain("change B");
      expect(reconcileCalls[0]).toContain("change C");
    });

    it("should not flush during tick, flush after", async () => {
      const mockCompiler = {
        reconcile: vi.fn().mockResolvedValue(undefined),
      } as unknown as FiberCompiler;

      const scheduler = new ReconciliationScheduler(mockCompiler);

      scheduler.enterTick();
      scheduler.schedule("during tick");

      // Wait for potential microtask
      await Promise.resolve();
      await Promise.resolve();

      expect(mockCompiler.reconcile).not.toHaveBeenCalled();
      expect(scheduler.isPending).toBe(true);

      scheduler.exitTick();

      // Wait for flush after exit
      await Promise.resolve();
      await Promise.resolve();

      expect(mockCompiler.reconcile).toHaveBeenCalledTimes(1);
    });
  });

  describe("useTick hook", () => {
    it("should provide tick control to components", async () => {
      let capturedTickResult: ReturnType<typeof useTick> | undefined;

      const mockTickControl = {
        requestTick: vi.fn(),
        cancelTick: vi.fn(),
        status: "running" as const,
        tickCount: 5,
      };

      const TickAwareComponent = () => {
        capturedTickResult = useTick();
        return jsx(Section, { id: "tick", children: `Tick ${capturedTickResult.tickCount}` });
      };

      await compiler.reconcile(jsx(TickAwareComponent, {}), {
        tickState: createTickState(5),
        tickControl: mockTickControl,
      });

      expect(capturedTickResult).toBeDefined();
      expect(capturedTickResult!.tickStatus).toBe("running");
      expect(capturedTickResult!.tickCount).toBe(5);

      // Test delegation
      capturedTickResult!.requestTick();
      expect(mockTickControl.requestTick).toHaveBeenCalled();
    });

    it("should work without tickControl (graceful degradation)", async () => {
      let capturedTickResult: ReturnType<typeof useTick> | undefined;

      const TickAwareComponent = () => {
        capturedTickResult = useTick();
        return jsx(Section, { id: "tick", children: "No control" });
      };

      // Compile without tickControl
      await compiler.compile(jsx(TickAwareComponent, {}), createTickState(3));

      expect(capturedTickResult).toBeDefined();
      expect(capturedTickResult!.tickStatus).toBe("idle");
      expect(capturedTickResult!.tickCount).toBe(3); // Falls back to tickState.tick
    });
  });

  describe("useChannel hook", () => {
    it("should provide channel access to components", async () => {
      const channels = new Map<string, Channel>();
      const getChannel = (name: string) => {
        if (!channels.has(name)) {
          channels.set(name, new Channel(name));
        }
        return channels.get(name)!;
      };

      let channelResult: ReturnType<typeof useChannel> | undefined;
      const receivedEvents: unknown[] = [];

      const ChannelComponent = () => {
        const result = useChannel("events");
        channelResult = result;

        if (result.available) {
          result.subscribe((event) => {
            receivedEvents.push(event.payload);
          });
        }

        return jsx(Section, { id: "channel", children: "Listening" });
      };

      await compiler.reconcile(jsx(ChannelComponent, {}), {
        tickState: createTickState(),
        getChannel,
      });

      expect(channelResult!.available).toBe(true);

      // Publish and verify receipt
      channelResult!.publish({ type: "test", payload: { value: 42 } });

      expect(receivedEvents).toContainEqual({ value: 42 });
    });

    it("should enable bidirectional communication", async () => {
      const channels = new Map<string, Channel>();
      const getChannel = (name: string) => {
        if (!channels.has(name)) {
          channels.set(name, new Channel(name));
        }
        return channels.get(name)!;
      };

      let channelResult: ReturnType<typeof useChannel> | undefined;

      const BidirectionalComponent = () => {
        channelResult = useChannel("confirm");
        return jsx(Section, { id: "confirm", children: "Ready" });
      };

      await compiler.reconcile(jsx(BidirectionalComponent, {}), {
        tickState: createTickState(),
        getChannel,
      });

      // Start waiting for response
      const responsePromise = channelResult!.waitForResponse("req-1", 5000);

      // Simulate external response
      setTimeout(() => {
        channelResult!.channel!.publish({
          type: "response",
          id: "req-1",
          channel: "confirm",
          payload: { confirmed: true },
        });
      }, 10);

      const response = await responsePromise;
      expect(response.payload.confirmed).toBe(true);
    });
  });

  describe("full reactive flow", () => {
    it("should handle state updates -> reconciliation -> collect cycle", async () => {
      const renderHistory: string[] = [];
      let signalRef: ReturnType<typeof useSignal<string>> | undefined;

      const DynamicComponent = () => {
        const message = useSignal("initial");
        signalRef = message;
        renderHistory.push(message());
        return jsx(Section, { id: "dynamic", children: message() });
      };

      // Initial reconcile
      await compiler.reconcile(jsx(DynamicComponent, {}), { tickState: createTickState() });
      let structure = compiler.collect();

      // Verify section exists and has correct id
      expect(structure.sections.has("dynamic")).toBe(true);
      expect(renderHistory).toEqual(["initial"]);

      // Update state
      signalRef!.set("updated");

      // Reconcile again
      await compiler.reconcile(undefined, { tickState: createTickState(2) });
      structure = compiler.collect();

      // State should have updated
      expect(renderHistory).toEqual(["initial", "updated"]);
    });

    it("should handle effects during reconciliation lifecycle", async () => {
      const effectLog: string[] = [];
      const renderHistory: number[] = [];
      let setCountRef: ((n: number) => void) | undefined;

      const LifecycleComponent = () => {
        const [count, setCount] = useState(0);
        setCountRef = setCount;
        renderHistory.push(count);

        useEffect(() => {
          effectLog.push(`effect-${count}`);
          return () => {
            effectLog.push(`cleanup-${count}`);
          };
        }, [count]);

        return jsx(Section, { id: "lifecycle", children: `Count: ${count}` });
      };

      // First reconcile - renders with count=0
      await compiler.reconcile(jsx(LifecycleComponent, {}), { tickState: createTickState() });

      expect(renderHistory).toEqual([0]);
      expect(effectLog).toContain("effect-0");

      // Update state between reconciliations (this is the reactive model)
      setCountRef!(1);

      // Second reconcile - should see updated state
      await compiler.reconcile(undefined, { tickState: createTickState(2) });

      expect(renderHistory).toEqual([0, 1]);
      // Cleanup for 0 should have run, then effect for 1
      expect(effectLog).toContain("cleanup-0");
      expect(effectLog).toContain("effect-1");
    });

    it("should maintain component identity across reconciliations", async () => {
      const mountLog: string[] = [];

      const IdentityComponent = () => {
        useEffect(() => {
          mountLog.push("mounted");
          return () => {
            mountLog.push("unmounted");
          };
        }, []);
        return jsx(Section, { id: "identity", children: "Hello" });
      };

      // First reconcile
      await compiler.reconcile(jsx(IdentityComponent, {}), { tickState: createTickState(1) });
      expect(mountLog).toEqual(["mounted"]);

      // Second reconcile (same component, should not remount)
      await compiler.reconcile(undefined, { tickState: createTickState(2) });
      expect(mountLog).toEqual(["mounted"]); // No additional mounts

      // Third reconcile
      await compiler.reconcile(undefined, { tickState: createTickState(3) });
      expect(mountLog).toEqual(["mounted"]); // Still no additional mounts
    });
  });
});
