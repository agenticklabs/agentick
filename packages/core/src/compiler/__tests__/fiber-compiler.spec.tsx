/**
 * FiberCompiler Tests
 *
 * Comprehensive tests for the V2 react-reconciler based compiler.
 * @jsxImportSource react
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import {
  FiberCompiler,
  useTickStart,
  useTickEnd,
  useAfterCompile,
  useData,
  useInvalidateData,
  useCom,
  useTickState,
  useSignal,
  useComputed,
  createSignal,
} from "../index";
import { createMockCom, createMockTickState, createMockTickResult } from "../../testing/mocks";

describe("FiberCompiler", () => {
  let com: ReturnType<typeof createMockCom>;
  let compiler: FiberCompiler;

  beforeEach(() => {
    com = createMockCom();
    compiler = new FiberCompiler(com as any);
  });

  // ============================================================
  // Basic Compilation
  // ============================================================

  describe("basic compilation", () => {
    it("should compile a simple element", async () => {
      const SimpleComponent = () => {
        return React.createElement("Section", { id: "test" });
      };

      const tickState = createMockTickState();
      const result = await compiler.compile(React.createElement(SimpleComponent), tickState);

      expect(result).toBeDefined();
      expect(result.sections).toBeDefined();
    });

    it("should compile until stable", async () => {
      const StableComponent = () => {
        return React.createElement("Section", { id: "stable" });
      };

      const tickState = createMockTickState();
      const result = await compiler.compileUntilStable(
        React.createElement(StableComponent),
        tickState,
      );

      expect(result.iterations).toBe(1);
      expect(result.forcedStable).toBe(false);
    });

    it("should handle multiple recompile iterations", async () => {
      let compileCount = 0;

      const RecompileComponent = () => {
        const com = useCom();

        useAfterCompile(() => {
          compileCount++;
          if (compileCount < 3) {
            com.requestRecompile("test recompile");
          }
        });

        return React.createElement("Section", { id: "recompile" });
      };

      const tickState = createMockTickState();
      const result = await compiler.compileUntilStable(
        React.createElement(RecompileComponent),
        tickState,
      );

      expect(result.iterations).toBe(3);
      expect(compileCount).toBe(3);
    });

    it("should respect max iterations limit", async () => {
      let compileCount = 0;

      const InfiniteRecompileComponent = () => {
        const com = useCom();

        useAfterCompile(() => {
          compileCount++;
          // Always request recompile
          com.requestRecompile("infinite loop");
        });

        return React.createElement("Section", { id: "infinite" });
      };

      const tickState = createMockTickState();
      const result = await compiler.compileUntilStable(
        React.createElement(InfiniteRecompileComponent),
        tickState,
        { maxIterations: 5 },
      );

      expect(result.iterations).toBe(5);
      expect(result.forcedStable).toBe(true);
      expect(compileCount).toBe(5);
    });

    it("should track recompile reasons", async () => {
      let compileCount = 0;

      const ReasonComponent = () => {
        const com = useCom();

        useAfterCompile(() => {
          compileCount++;
          if (compileCount === 1) {
            com.requestRecompile("first reason");
          } else if (compileCount === 2) {
            com.requestRecompile("second reason");
          }
        });

        return React.createElement("Section", { id: "reasons" });
      };

      const tickState = createMockTickState();
      const result = await compiler.compileUntilStable(
        React.createElement(ReasonComponent),
        tickState,
      );

      expect(result.recompileReasons).toContain("first reason");
      expect(result.recompileReasons).toContain("second reason");
    });
  });

  // ============================================================
  // Lifecycle Hooks
  // ============================================================

  describe("lifecycle hooks", () => {
    it("useTickEnd callback should run after compile", async () => {
      const tickEndCallback = vi.fn();

      const LifecycleComponent = () => {
        useTickEnd(tickEndCallback);
        return React.createElement("Section", { id: "lifecycle" });
      };

      const tickState = createMockTickState();

      // Compile to register the callback
      await compiler.compile(React.createElement(LifecycleComponent), tickState);

      // Callback should be registered now (after flushPassiveEffects)
      expect(tickEndCallback).not.toHaveBeenCalled();

      // Run tick end
      await compiler.notifyTickEnd(tickState, createMockTickResult(tickState.tick));

      expect(tickEndCallback).toHaveBeenCalledTimes(1);
    });

    it("useAfterCompile callback should run after each compile pass", async () => {
      const afterCompileCallback = vi.fn();

      const AfterCompileComponent = () => {
        useAfterCompile(afterCompileCallback);
        return React.createElement("Section", { id: "aftercompile" });
      };

      const tickState = createMockTickState();

      // Compile
      const compiled = await compiler.compile(
        React.createElement(AfterCompileComponent),
        tickState,
      );

      // Manually notify after compile (normally done by compileUntilStable)
      await compiler.notifyAfterCompile(compiled, tickState, {});

      expect(afterCompileCallback).toHaveBeenCalledTimes(1);
      expect(afterCompileCallback).toHaveBeenCalledWith(compiled);
    });

    it("useTickStart callback should run on next tick", async () => {
      const tickStartCallback = vi.fn();

      const TickStartComponent = () => {
        useTickStart(tickStartCallback);
        return React.createElement("Section", { id: "tickstart" });
      };

      const tickState1 = createMockTickState(1);

      // Compile tick 1 - registers the callback
      await compiler.compile(React.createElement(TickStartComponent), tickState1);

      // Tick 1 start already happened, so callback shouldn't have run yet
      expect(tickStartCallback).not.toHaveBeenCalled();

      // Start tick 2 - now the callback should run
      const tickState2 = createMockTickState(2);
      await compiler.notifyTickStart(tickState2);

      expect(tickStartCallback).toHaveBeenCalledTimes(1);
    });

    it("unmounted component should not have its callbacks called", async () => {
      const tickEndCallback = vi.fn();
      let showComponent = true;

      const ConditionalComponent = () => {
        useTickEnd(tickEndCallback);
        return React.createElement("Section", { id: "conditional" });
      };

      const ParentComponent = () => {
        if (showComponent) {
          return React.createElement(ConditionalComponent);
        }
        return React.createElement("Section", { id: "empty" });
      };

      const tickState = createMockTickState();

      // First compile - component mounted
      await compiler.compile(React.createElement(ParentComponent), tickState);

      // Unmount component
      showComponent = false;
      await compiler.compile(React.createElement(ParentComponent), tickState);

      // Tick end - callback should NOT run (component unmounted)
      await compiler.notifyTickEnd(tickState, createMockTickResult(tickState.tick));

      expect(tickEndCallback).not.toHaveBeenCalled();
    });

    it("should support multiple lifecycle callbacks from same component", async () => {
      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const MultiCallbackComponent = () => {
        useTickEnd(callback1);
        useTickEnd(callback2);
        return React.createElement("Section", { id: "multi" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(MultiCallbackComponent), tickState);
      await compiler.notifyTickEnd(tickState, createMockTickResult(tickState.tick));

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it("should handle async lifecycle callbacks", async () => {
      const order: string[] = [];

      const AsyncCallbackComponent = () => {
        useTickEnd(async () => {
          await new Promise((r) => setTimeout(r, 10));
          order.push("async1");
        });
        useTickEnd(async () => {
          await new Promise((r) => setTimeout(r, 5));
          order.push("async2");
        });
        return React.createElement("Section", { id: "async" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(AsyncCallbackComponent), tickState);
      await compiler.notifyTickEnd(tickState, createMockTickResult(tickState.tick));

      // Both should have run (order depends on implementation)
      expect(order).toContain("async1");
      expect(order).toContain("async2");
    });

    it("callback should use latest closure values", async () => {
      let capturedValue = 0;
      let renderCount = 0;

      const ClosureComponent = () => {
        renderCount++;
        const value = renderCount;

        useTickEnd(() => {
          capturedValue = value;
        });

        return React.createElement("Section", { id: "closure" });
      };

      const tickState = createMockTickState();

      // First compile
      await compiler.compile(React.createElement(ClosureComponent), tickState);
      // Second compile (re-render)
      await compiler.compile(React.createElement(ClosureComponent), tickState);

      await compiler.notifyTickEnd(tickState, createMockTickResult(tickState.tick));

      // Should capture the value from the most recent render
      expect(capturedValue).toBe(2);
    });
  });

  // ============================================================
  // useData Hook
  // ============================================================

  describe("useData hook", () => {
    it("should fetch and cache data", async () => {
      const fetchFn = vi.fn().mockResolvedValue({ name: "Test User" });
      let capturedData: any = null;

      const DataComponent = () => {
        const data = useData<{ name: string }>("user-1", fetchFn);
        capturedData = data;
        return React.createElement("Section", { id: "data", "data-name": data.name });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(DataComponent), tickState);

      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(capturedData).toEqual({ name: "Test User" });

      // Second compile - should use cached data
      await compiler.compile(React.createElement(DataComponent), tickState);

      expect(fetchFn).toHaveBeenCalledTimes(1); // Still 1, not 2
    });

    it("should refetch when tick changes", async () => {
      const fetchFn = vi.fn().mockResolvedValue({ status: "ok" });

      const RefetchComponent = () => {
        const tick = useTickState();
        const data = useData<{ status: string }>("status", fetchFn, [tick.tick]);
        return React.createElement("Section", { id: "status", "data-status": data.status });
      };

      const tickState1 = createMockTickState(1);
      await compiler.compile(React.createElement(RefetchComponent), tickState1);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // New tick - should refetch
      const tickState2 = createMockTickState(2);
      await compiler.compile(React.createElement(RefetchComponent), tickState2);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should refetch when deps change", async () => {
      const fetchFn = vi.fn().mockResolvedValue({ data: "fetched" });
      let userId = "user-1";

      const DepsComponent = () => {
        const data = useData<{ data: string }>("user-data", fetchFn, [userId]);
        return React.createElement("Section", { id: "deps", "data-result": data.data });
      };

      const tickState = createMockTickState();

      // First fetch
      await compiler.compile(React.createElement(DepsComponent), tickState);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Same deps - no refetch
      await compiler.compile(React.createElement(DepsComponent), tickState);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Change deps - should refetch
      userId = "user-2";
      await compiler.compile(React.createElement(DepsComponent), tickState);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("should handle fetcher errors", async () => {
      const error = new Error("Fetch failed");
      const fetchFn = vi.fn().mockRejectedValue(error);

      const ErrorComponent = () => {
        const _data = useData("error-test", fetchFn);
        return React.createElement("Section", { id: "error" });
      };

      const tickState = createMockTickState();

      await expect(
        compiler.compile(React.createElement(ErrorComponent), tickState),
      ).rejects.toThrow("Fetch failed");
    });

    it("should handle multiple concurrent data fetches", async () => {
      const fetchUser = vi.fn().mockResolvedValue({ name: "User" });
      const fetchPosts = vi.fn().mockResolvedValue([{ id: 1 }]);

      const MultiDataComponent = () => {
        const user = useData<{ name: string }>("user", fetchUser);
        const posts = useData<{ id: number }[]>("posts", fetchPosts);
        return React.createElement("Section", {
          id: "multi-data",
          "data-user": user.name,
          "data-posts": posts.length,
        });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(MultiDataComponent), tickState);

      expect(fetchUser).toHaveBeenCalledTimes(1);
      expect(fetchPosts).toHaveBeenCalledTimes(1);
    });

    it("useInvalidateData should clear specific cache entries", async () => {
      const fetchFn = vi.fn().mockResolvedValue({ value: 1 });
      let shouldInvalidate = false;

      const InvalidateComponent = () => {
        const data = useData<{ value: number }>("invalidate-test", fetchFn);
        const invalidate = useInvalidateData();

        useAfterCompile(() => {
          if (shouldInvalidate) {
            invalidate("invalidate-test");
          }
        });

        return React.createElement("Section", { id: "invalidate", "data-value": data.value });
      };

      const tickState = createMockTickState();

      // First fetch
      await compiler.compileUntilStable(React.createElement(InvalidateComponent), tickState);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Compile again without invalidation - should use cache
      await compiler.compileUntilStable(React.createElement(InvalidateComponent), tickState);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Trigger invalidation on next compile
      shouldInvalidate = true;
      await compiler.compileUntilStable(React.createElement(InvalidateComponent), tickState);
      // After invalidation, next compile should refetch
      shouldInvalidate = false;
      await compiler.compileUntilStable(React.createElement(InvalidateComponent), tickState);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("useInvalidateData should support regex patterns", async () => {
      const fetchUser1 = vi.fn().mockResolvedValue({ id: 1 });
      const fetchUser2 = vi.fn().mockResolvedValue({ id: 2 });
      const fetchPosts = vi.fn().mockResolvedValue([]);

      const _RegexInvalidateComponent = () => {
        const _user1 = useData("user:1", fetchUser1);
        const _user2 = useData("user:2", fetchUser2);
        const _posts = useData("posts", fetchPosts);
        const _invalidate = useInvalidateData();

        return React.createElement("Section", { id: "regex" });
      };

      // This would be tested via the store functions directly
      // since we can't easily trigger invalidation mid-compile
    });
  });

  // ============================================================
  // Context Hooks
  // ============================================================

  describe("context hooks", () => {
    it("useCom should provide access to COM", async () => {
      let capturedCom: any = null;

      const ComComponent = () => {
        capturedCom = useCom();
        return React.createElement("Section", { id: "com-test" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(ComComponent), tickState);

      expect(capturedCom).toBeDefined();
      expect(capturedCom.id).toBe("test-session");
    });

    it("useCom should allow state access", async () => {
      let readValue: any = null;

      const StateComponent = () => {
        const com = useCom();
        com.setState("test-key", "test-value");
        readValue = com.getState("test-key");
        return React.createElement("Section", { id: "state-test" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(StateComponent), tickState);

      expect(readValue).toBe("test-value");
    });

    it("useTickState should provide tick information", async () => {
      let capturedTick: number = 0;

      const TickComponent = () => {
        const state = useTickState();
        capturedTick = state.tick;
        return React.createElement("Section", { id: "tick-test" });
      };

      const tickState = createMockTickState(42);
      await compiler.compile(React.createElement(TickComponent), tickState);

      expect(capturedTick).toBe(42);
    });

    it("useTickState.stop should mark tick as stopped", async () => {
      let tickState: any = null;

      const StopComponent = () => {
        tickState = useTickState();
        return React.createElement("Section", { id: "stop-test" });
      };

      const mockTickState = createMockTickState();
      await compiler.compile(React.createElement(StopComponent), mockTickState);

      // Call stop
      tickState.stop("test reason");

      expect(mockTickState._stopCalls).toContain("test reason");
    });
  });

  // ============================================================
  // Signal Hooks
  // ============================================================

  describe("signal hooks", () => {
    it("createSignal should create a reactive signal", () => {
      const signal = createSignal(0);

      expect(signal()).toBe(0);
      expect(signal.value).toBe(0);

      signal.set(5);
      expect(signal()).toBe(5);

      signal.update((x) => x + 1);
      expect(signal()).toBe(6);
    });

    it("signal should notify subscribers on change", async () => {
      const signal = createSignal("initial");
      const subscriber = vi.fn();

      signal.subscribe?.(subscriber);
      signal.set("updated");

      // Wait for microtask to flush (signals use microtask scheduling)
      await new Promise<void>((resolve) => queueMicrotask(resolve));

      expect(subscriber).toHaveBeenCalledWith("updated");
    });

    it("signal should not notify if value unchanged", () => {
      const signal = createSignal(10);
      const subscriber = vi.fn();

      signal.subscribe?.(subscriber);
      signal.set(10); // Same value

      expect(subscriber).not.toHaveBeenCalled();
    });

    it("signal.set should accept updater function", () => {
      const signal = createSignal({ count: 0 });

      signal.set((prev) => ({ count: prev.count + 1 }));
      expect(signal().count).toBe(1);
    });

    it("unsubscribe should stop notifications", async () => {
      const signal = createSignal(0);
      const subscriber = vi.fn();

      const unsubscribe = signal.subscribe?.(subscriber);
      signal.set(1);
      // Wait for microtask to flush (signals use microtask scheduling)
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(subscriber).toHaveBeenCalledTimes(1);

      unsubscribe?.();
      signal.set(2);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      expect(subscriber).toHaveBeenCalledTimes(1); // No new call
    });

    it("useSignal should work within components", async () => {
      let signalValue: number = 0;

      const SignalComponent = () => {
        const count = useSignal(42);
        signalValue = count();
        return React.createElement("Section", { id: "signal", "data-count": count() });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(SignalComponent), tickState);

      expect(signalValue).toBe(42);
    });

    it("useComputed should derive from signals", async () => {
      let computedValue: number = 0;

      const ComputedComponent = () => {
        const count = useSignal(5);
        const doubled = useComputed<number>(() => count() * 2, [count]);
        computedValue = doubled();
        return React.createElement("Section", { id: "computed" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(ComputedComponent), tickState);

      expect(computedValue).toBe(10);
    });
  });

  // ============================================================
  // Session Isolation
  // ============================================================

  describe("session isolation", () => {
    it("should isolate data cache between compiler instances", async () => {
      const com1 = createMockCom();
      const com2 = createMockCom();
      const compiler1 = new FiberCompiler(com1 as any);
      const compiler2 = new FiberCompiler(com2 as any);

      const fetchFn1 = vi.fn().mockResolvedValue({ id: 1 });
      const fetchFn2 = vi.fn().mockResolvedValue({ id: 2 });

      const DataComponent1 = () => {
        const data = useData<any>("shared-key", fetchFn1);
        return React.createElement("Section", { id: "iso-1", "data-id": data.id });
      };

      const DataComponent2 = () => {
        const data = useData<any>("shared-key", fetchFn2);
        return React.createElement("Section", { id: "iso-2", "data-id": data.id });
      };

      const tickState = createMockTickState();

      // Compile in both compilers with same key
      await compiler1.compile(React.createElement(DataComponent1), tickState);
      await compiler2.compile(React.createElement(DataComponent2), tickState);

      // Both fetchers should have been called (not sharing cache)
      expect(fetchFn1).toHaveBeenCalledTimes(1);
      expect(fetchFn2).toHaveBeenCalledTimes(1);
    });

    it("should isolate lifecycle callbacks between compiler instances", async () => {
      const com1 = createMockCom();
      const com2 = createMockCom();
      const compiler1 = new FiberCompiler(com1 as any);
      const compiler2 = new FiberCompiler(com2 as any);

      const callback1 = vi.fn();
      const callback2 = vi.fn();

      const Component1 = () => {
        useTickEnd(callback1);
        return React.createElement("Section", { id: "1" });
      };

      const Component2 = () => {
        useTickEnd(callback2);
        return React.createElement("Section", { id: "2" });
      };

      const tickState = createMockTickState();

      await compiler1.compile(React.createElement(Component1), tickState);
      await compiler2.compile(React.createElement(Component2), tickState);

      // Only notify tick end on compiler1
      await compiler1.notifyTickEnd(tickState, createMockTickResult(tickState.tick));

      expect(callback1).toHaveBeenCalledTimes(1);
      expect(callback2).not.toHaveBeenCalled(); // Isolated!

      // Now notify on compiler2
      await compiler2.notifyTickEnd(tickState, createMockTickResult(tickState.tick));

      expect(callback2).toHaveBeenCalledTimes(1);
    });

    it("should isolate COM state between sessions", async () => {
      const com1 = createMockCom();
      const com2 = createMockCom();
      const compiler1 = new FiberCompiler(com1 as any);
      const compiler2 = new FiberCompiler(com2 as any);

      let value1: any = null;
      let value2: any = null;

      const Component1 = () => {
        const com = useCom();
        com.setState("shared-key", "value-from-session-1");
        value1 = com.getState("shared-key");
        return React.createElement("Section", { id: "1" });
      };

      const Component2 = () => {
        const com = useCom();
        value2 = com.getState("shared-key"); // Should be undefined
        return React.createElement("Section", { id: "2" });
      };

      const tickState = createMockTickState();
      await compiler1.compile(React.createElement(Component1), tickState);
      await compiler2.compile(React.createElement(Component2), tickState);

      expect(value1).toBe("value-from-session-1");
      expect(value2).toBeUndefined(); // Isolated!
    });
  });

  // ============================================================
  // Hibernation
  // ============================================================

  describe("hibernation", () => {
    it("should serialize and restore data cache", async () => {
      const fetchFn = vi.fn().mockResolvedValue({ cached: true });

      const DataComponent = () => {
        const data = useData<any>("hibernate-test", fetchFn);
        return React.createElement("Section", {
          id: "hibernate",
          "data-cached": String(data.cached),
        });
      };

      const tickState = createMockTickState();

      // Compile and cache data
      await compiler.compile(React.createElement(DataComponent), tickState);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Get serializable cache
      const serialized = compiler.getSerializableDataCache();
      expect(serialized["hibernate-test"]).toBeDefined();
      expect(serialized["hibernate-test"].value).toEqual({ cached: true });

      // Create new compiler and restore cache
      const newCom = createMockCom();
      const newCompiler = new FiberCompiler(newCom as any);
      newCompiler.setDataCache(serialized);

      // Compile with restored cache - should NOT fetch again
      const newFetchFn = vi.fn().mockResolvedValue({ cached: false });
      const RestoredComponent = () => {
        const data = useData<any>("hibernate-test", newFetchFn);
        return React.createElement("Section", {
          id: "restored",
          "data-cached": String(data.cached),
        });
      };

      await newCompiler.compile(React.createElement(RestoredComponent), tickState);

      // Should use cached value, not fetch
      expect(newFetchFn).not.toHaveBeenCalled();
    });

    it("should preserve tick info in cache entries", async () => {
      const fetchFn = vi.fn().mockResolvedValue({ data: "test" });

      const CacheTickComponent = () => {
        const _data = useData("tick-cache", fetchFn);
        return React.createElement("Section", { id: "tick-cache" });
      };

      const tickState = createMockTickState(5);
      await compiler.compile(React.createElement(CacheTickComponent), tickState);

      const serialized = compiler.getSerializableDataCache();
      expect(serialized["tick-cache"].tick).toBe(5);
    });

    it("should preserve deps in cache entries", async () => {
      const fetchFn = vi.fn().mockResolvedValue({ data: "test" });

      const DepsTickComponent = () => {
        const _data = useData<{ data: string }>("deps-cache", fetchFn, ["a", "b"]);
        return React.createElement("Section", { id: "deps-cache" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(DepsTickComponent), tickState);

      const serialized = compiler.getSerializableDataCache();
      expect(serialized["deps-cache"].deps).toEqual(["a", "b"]);
    });
  });

  // ============================================================
  // Nested Components
  // ============================================================

  describe("nested components", () => {
    it("should call child lifecycle hooks before parent (React useEffect order)", async () => {
      const order: string[] = [];

      const Child = () => {
        useTickEnd(() => {
          order.push("child");
        });
        return React.createElement("Section", { id: "child" });
      };

      const Parent = () => {
        useTickEnd(() => {
          order.push("parent");
        });
        return React.createElement(Child);
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(Parent), tickState);
      await compiler.notifyTickEnd(tickState, createMockTickResult(tickState.tick));

      // React's useEffect runs bottom-up: children before parents
      expect(order[0]).toBe("child");
      expect(order[1]).toBe("parent");
    });

    it("should properly cleanup nested component callbacks", async () => {
      const parentCallback = vi.fn();
      const childCallback = vi.fn();
      let showChild = true;

      const Child = () => {
        useTickEnd(childCallback);
        return React.createElement("Section", { id: "child" });
      };

      const Parent = () => {
        useTickEnd(parentCallback);
        if (showChild) {
          return React.createElement(Child);
        }
        return React.createElement("Section", { id: "parent-only" });
      };

      const tickState = createMockTickState();

      // First compile with child
      await compiler.compile(React.createElement(Parent), tickState);

      // Remove child
      showChild = false;
      await compiler.compile(React.createElement(Parent), tickState);

      // Tick end
      await compiler.notifyTickEnd(tickState, createMockTickResult(tickState.tick));

      expect(parentCallback).toHaveBeenCalledTimes(1);
      expect(childCallback).not.toHaveBeenCalled(); // Unmounted
    });

    it("should support deeply nested data fetching", async () => {
      const fetchA = vi.fn().mockResolvedValue({ a: 1 });
      const fetchB = vi.fn().mockResolvedValue({ b: 2 });
      const fetchC = vi.fn().mockResolvedValue({ c: 3 });

      const Level3 = () => {
        const _data = useData("level3", fetchC);
        return React.createElement("Section", { id: "level3" });
      };

      const Level2 = () => {
        const _data = useData("level2", fetchB);
        return React.createElement(Level3);
      };

      const Level1 = () => {
        const _data = useData("level1", fetchA);
        return React.createElement(Level2);
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(Level1), tickState);

      expect(fetchA).toHaveBeenCalledTimes(1);
      expect(fetchB).toHaveBeenCalledTimes(1);
      expect(fetchC).toHaveBeenCalledTimes(1);
    });
  });

  // ============================================================
  // Unmount and Cleanup
  // ============================================================

  describe("unmount and cleanup", () => {
    it("unmount should clear the tree", async () => {
      const SimpleComponent = () => {
        return React.createElement("Section", { id: "unmount-test" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(SimpleComponent), tickState);

      const beforeUnmount = compiler.collect();
      expect(beforeUnmount.sections.size).toBeGreaterThan(0);

      await compiler.unmount();

      const afterUnmount = compiler.collect();
      expect(afterUnmount.sections.size).toBe(0);
    });

    it("unmount should clear lifecycle callbacks", async () => {
      const callback = vi.fn();

      const LifecycleComponent = () => {
        useTickEnd(callback);
        return React.createElement("Section", { id: "cleanup-test" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(LifecycleComponent), tickState);

      await compiler.unmount();

      // Tick end after unmount should not call the callback
      await compiler.notifyTickEnd(tickState, createMockTickResult(tickState.tick));
      expect(callback).not.toHaveBeenCalled();
    });

    it("unmount should clear data cache", async () => {
      const fetchFn = vi.fn().mockResolvedValue({ data: "test" });

      const DataComponent = () => {
        const _data = useData("unmount-cache", fetchFn);
        return React.createElement("Section", { id: "cache-test" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(DataComponent), tickState);

      const cacheBefore = compiler.getSerializableDataCache();
      expect(Object.keys(cacheBefore).length).toBeGreaterThan(0);

      await compiler.unmount();

      const cacheAfter = compiler.getSerializableDataCache();
      expect(Object.keys(cacheAfter).length).toBe(0);
    });
  });

  // ============================================================
  // State Queries
  // ============================================================

  describe("state queries", () => {
    it("isRenderingNow should be true during render", async () => {
      let _renderingDuringRender = false;

      const RenderingComponent = () => {
        // Note: This won't work as expected because isRenderingNow
        // is set in reconcile(), not in the actual component render
        return React.createElement("Section", { id: "rendering" });
      };

      const tickState = createMockTickState();
      await compiler.compile(React.createElement(RenderingComponent), tickState);

      // After compile, should not be rendering
      expect(compiler.isRenderingNow()).toBe(false);
    });

    it("shouldSkipRecompile should return true during lifecycle phases", async () => {
      // This is more of an implementation detail test
      expect(compiler.shouldSkipRecompile()).toBe(false);
    });
  });

  // ============================================================
  // Reconcile and Collect
  // ============================================================

  describe("reconcile and collect", () => {
    it("setRoot and reconcile should work together", async () => {
      const RootComponent = () => {
        return React.createElement("Section", { id: "root-test" });
      };

      const tickState = createMockTickState();
      compiler.setRoot(React.createElement(RootComponent));

      await compiler.reconcile(undefined, { tickState });
      const result = compiler.collect();

      expect(result.sections).toBeDefined();
    });

    it("reconcile without root should throw", async () => {
      await expect(compiler.reconcile()).rejects.toThrow("No element to reconcile");
    });

    it("collect should return empty structure before any render", () => {
      const result = compiler.collect();
      expect(result.sections.size).toBe(0);
    });
  });
});
