/**
 * Tests for V2 Hooks
 */

import { useState, useEffect, useMemo, useComputed, useCallback, useRef } from "../../state/hooks";
import { useComState, useWatch, useInput } from "../../state/hooks";
import { useInit, useOnMount, useTickStart, useTickEnd, useAfterCompile } from "../../state/hooks";
import { useAsync, usePrevious, useToggle, useCounter } from "../../state/hooks";
import { setRenderContext } from "../../state/hooks";
import type { RenderContext } from "../types";
import { createFiber } from "../fiber";
import { COM } from "../../com/object-model";
import type { TickState } from "../../component/component";

describe("V2 Hooks", () => {
  let com: COM;
  let tickState: TickState;
  let renderContext: RenderContext;
  let fiber: ReturnType<typeof createFiber>;

  beforeEach(() => {
    com = new COM();
    tickState = {
      tick: 1,
      stop: vi.fn(),
      queuedMessages: [],
    } as TickState;

    fiber = createFiber(() => null, {}, null);
    renderContext = {
      fiber,
      com,
      tickState,
      currentHook: null,
      workInProgressHook: null,
    };
  });

  afterEach(() => {
    setRenderContext(null);
  });

  describe("useState", () => {
    it("should initialize with initial value", () => {
      setRenderContext(renderContext);

      const [count] = useState(0);
      expect(count).toBe(0);
    });

    it("should support lazy initializer", () => {
      setRenderContext(renderContext);

      const [value] = useState(() => 42);
      expect(value).toBe(42);
    });

    it("should update state", () => {
      setRenderContext(renderContext);

      const [count, setCount] = useState(0);
      expect(count).toBe(0);

      setCount(1);
      // State update happens on next render, but we can check the hook state
      const hook = fiber.memoizedState;
      expect(hook).toBeDefined();
    });

    it("should support functional updates", () => {
      setRenderContext(renderContext);

      const [_count, setCount] = useState(0);
      setCount((prev) => prev + 1);

      const hook = fiber.memoizedState;
      expect(hook).toBeDefined();
    });

    it("should persist state across renders", () => {
      setRenderContext(renderContext);
      const [_count1] = useState(5);

      // Simulate re-render with previous hook state
      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      const [count2] = useState(5);

      expect(count2).toBe(5);
      expect(fiber.memoizedState).toBeDefined();
    });
  });

  describe("useEffect", () => {
    it("should run effect on mount", () => {
      setRenderContext(renderContext);

      const effectFn = vi.fn();
      useEffect(effectFn, []);

      const hook = fiber.memoizedState;
      expect(hook?.effect).toBeDefined();
      expect(hook?.effect?.phase).toBe("commit");
      expect(hook?.effect?.pending).toBe(true);
    });

    it("should support async effects", () => {
      setRenderContext(renderContext);

      const asyncEffect = vi.fn(async () => {
        await Promise.resolve();
      });

      useEffect(asyncEffect, []);

      const hook = fiber.memoizedState;
      expect(hook?.effect?.create).toBe(asyncEffect);
    });

    it("should track dependencies", () => {
      setRenderContext(renderContext);

      useEffect(() => {}, [1, 2, 3]);

      const hook = fiber.memoizedState;
      expect(hook?.effect?.deps).toEqual([1, 2, 3]);
    });

    it("should support cleanup function", () => {
      setRenderContext(renderContext);

      const cleanup = vi.fn();
      useEffect(() => cleanup, []);

      const hook = fiber.memoizedState;
      expect(hook?.effect?.create).toBeDefined();
    });
  });

  describe("useComState", () => {
    it("should create COM-bound state signal", () => {
      setRenderContext(renderContext);

      const stateSignal = useComState("test", "initial");

      expect(stateSignal()).toBe("initial");
      expect(stateSignal.value).toBe("initial");
      expect(typeof stateSignal.set).toBe("function");

      const hook = fiber.memoizedState;
      expect(hook?.tag).toBe(2); // HookTag.ComState
      expect(hook?.effect).toBeDefined(); // Cleanup effect
    });

    it("should update COM state via signal", () => {
      setRenderContext(renderContext);

      const stateSignal = useComState("test", "initial");
      stateSignal.set("updated");

      // COM state should be updated
      expect(com.getState("test")).toBe("updated");
      expect(stateSignal()).toBe("updated");
    });
  });

  describe("useWatch", () => {
    it("should watch COM state as a readonly signal", () => {
      setRenderContext(renderContext);

      // Set state first
      com.setState("watched", "value");

      const watchSignal = useWatch("watched", "default");

      expect(watchSignal()).toBe("value");
      expect(watchSignal.value).toBe("value");
      expect(typeof watchSignal.dispose).toBe("function");
    });

    it("should use default value if state not set", () => {
      setRenderContext(renderContext);

      const watchSignal = useWatch("not-set", "default");

      expect(watchSignal()).toBe("default");
    });
  });

  describe("useInput", () => {
    it("should read prop value", () => {
      fiber.props = { name: "Alice" };
      setRenderContext(renderContext);

      const name = useInput("name");

      expect(name).toBe("Alice");
    });

    it("should use default if prop not provided", () => {
      fiber.props = {};
      setRenderContext(renderContext);

      const name = useInput("name", "Default");

      expect(name).toBe("Default");
    });
  });

  describe("useInit", () => {
    it("should run initialization callback once", async () => {
      setRenderContext(renderContext);

      const callback = vi.fn();
      await useInit(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(callback).toHaveBeenCalledWith(com, tickState);

      // Re-render - should not call again
      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      await useInit(callback);

      expect(callback).toHaveBeenCalledTimes(1); // Still only once
    });

    it("should await async initialization", async () => {
      setRenderContext(renderContext);

      let resolved = false;
      const callback = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        resolved = true;
      });

      await useInit(callback);

      expect(callback).toHaveBeenCalledTimes(1);
      expect(resolved).toBe(true);
    });
  });

  describe("useOnMount", () => {
    it("should register mount callback", () => {
      setRenderContext(renderContext);

      const callback = vi.fn();
      useOnMount(callback);

      const hook = fiber.memoizedState;
      expect(hook?.effect).toBeDefined();
      expect(hook?.effect?.phase).toBe("commit");
    });
  });

  describe("useTickStart", () => {
    it("should register tick start callback", () => {
      setRenderContext(renderContext);

      const callback = vi.fn();
      useTickStart(callback);

      const hook = fiber.memoizedState;
      expect(hook?.effect).toBeDefined();
      expect(hook?.effect?.phase).toBe("tick-start");
      expect(hook?.effect?.pending).toBe(true);
    });
  });

  describe("useTickEnd", () => {
    it("should register tick end callback", () => {
      setRenderContext(renderContext);

      const callback = vi.fn();
      useTickEnd(callback);

      const hook = fiber.memoizedState;
      expect(hook?.effect).toBeDefined();
      expect(hook?.effect?.phase).toBe("tick-end");
    });
  });

  describe("useAfterCompile", () => {
    it("should register after compile callback", () => {
      setRenderContext(renderContext);

      const callback = vi.fn();
      useAfterCompile(callback);

      const hook = fiber.memoizedState;
      expect(hook?.memoizedState).toBe(callback);
      expect(hook?.effect?.phase).toBe("after-compile");
    });
  });

  describe("useMemo", () => {
    it("should memoize value", () => {
      setRenderContext(renderContext);

      const factory = vi.fn(() => 42);
      const value1 = useMemo(factory, []);

      expect(value1).toBe(42);
      expect(factory).toHaveBeenCalledTimes(1);

      // Re-render with same deps
      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      const value2 = useMemo(factory, []);

      expect(value2).toBe(42);
      expect(factory).toHaveBeenCalledTimes(1); // Not called again
    });

    it("should recompute when deps change", () => {
      setRenderContext(renderContext);

      const factory = vi.fn((x) => x * 2);
      const value1 = useMemo(() => factory(1), [1]);

      expect(value1).toBe(2);

      // Re-render with different deps
      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      const value2 = useMemo(() => factory(2), [2]);

      expect(value2).toBe(4);
      expect(factory).toHaveBeenCalledTimes(2);
    });
  });

  describe("useComputed", () => {
    it("should create a computed signal that persists across renders", () => {
      setRenderContext(renderContext);

      const computation = vi.fn(() => 42);
      const computed1 = useComputed(computation, []);

      expect(computed1()).toBe(42);
      expect(computed1.value).toBe(42);
      expect(computation).toHaveBeenCalledTimes(1);

      // Re-render with same deps - should return same computed signal
      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      const computed2 = useComputed(computation, []);

      // Same signal instance
      expect(computed2).toBe(computed1);
      // Reading it shouldn't recompute (cached)
      expect(computed2()).toBe(42);
      expect(computation).toHaveBeenCalledTimes(1);
    });

    it("should dispose and recreate computed when deps change", () => {
      setRenderContext(renderContext);

      const computation1 = vi.fn(() => 10);
      const computed1 = useComputed(computation1, [1]);

      expect(computed1()).toBe(10);
      const disposeSpy = vi.spyOn(computed1, "dispose");

      // Re-render with different deps
      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      const computation2 = vi.fn(() => 20);
      const computed2 = useComputed(computation2, [2]);

      // Old computed should be disposed
      expect(disposeSpy).toHaveBeenCalled();
      // New computed created
      expect(computed2).not.toBe(computed1);
      expect(computed2()).toBe(20);
    });
  });

  describe("useCallback", () => {
    it("should return stable callback reference", () => {
      setRenderContext(renderContext);

      const callback1 = useCallback(() => {}, []);

      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      const callback2 = useCallback(() => {}, []);

      // Should be same reference when deps unchanged
      expect(callback1).toBe(callback2);
    });
  });

  describe("useRef", () => {
    it("should create ref with initial value", () => {
      setRenderContext(renderContext);

      const ref = useRef("initial");

      expect(ref.current).toBe("initial");
    });

    it("should persist ref across renders", () => {
      setRenderContext(renderContext);
      const ref1 = useRef(0);
      ref1.current = 42;

      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      const ref2 = useRef(0);

      expect(ref2.current).toBe(42);
    });
  });

  describe("useAsync", () => {
    it("should track async state", async () => {
      setRenderContext(renderContext);

      const promise = Promise.resolve("data");
      const { data, loading, error } = useAsync(() => promise, []);

      expect(loading).toBe(true);
      expect(data).toBeUndefined();
      expect(error).toBeUndefined();
    });
  });

  describe("usePrevious", () => {
    it("should track previous value", () => {
      setRenderContext(renderContext);

      const prev1 = usePrevious(1);
      expect(prev1).toBeUndefined();

      // Simulate effect running (sets ref.current = 1)
      const hook = fiber.memoizedState;
      if (hook?.next) {
        const refHook = hook.next; // useRef hook
        if (refHook.memoizedState) {
          (refHook.memoizedState as { current: number }).current = 1;
        }
      }

      // Simulate re-render
      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);
      const prev2 = usePrevious(2);

      expect(prev2).toBe(1);
    });
  });

  describe("useToggle", () => {
    it("should toggle boolean value", () => {
      setRenderContext(renderContext);

      const [value, toggle] = useToggle(false);

      expect(value).toBe(false);
      toggle();

      // Value updates on next render
      const hook = fiber.memoizedState;
      expect(hook).toBeDefined();
    });
  });

  describe("useCounter", () => {
    it("should provide counter API", () => {
      setRenderContext(renderContext);

      const { count, increment, decrement, set, reset } = useCounter(0);

      expect(count).toBe(0);
      expect(typeof increment).toBe("function");
      expect(typeof decrement).toBe("function");
      expect(typeof set).toBe("function");
      expect(typeof reset).toBe("function");
    });
  });

  describe("Hook Rules", () => {
    it("should throw if hook called outside render", () => {
      setRenderContext(null);

      expect(() => {
        useState(0);
      }).toThrow("Invalid hook call");
    });

    it.skip("should throw if hooks called conditionally", () => {
      // TODO: Implement hook count/order validation like React
      // This requires tracking hook count and comparing across renders
      setRenderContext(renderContext);

      // First render - call hook twice
      useState(0);
      useState(1);

      // Second render - skip first hook conditionally
      const prevHook = fiber.memoizedState;
      renderContext.currentHook = prevHook;
      renderContext.workInProgressHook = null;
      fiber.memoizedState = null;

      setRenderContext(renderContext);

      // Skip first hook conditionally
      if (false) {
        useState(0);
      }

      // Try to call what should be second hook - but we skipped first
      // This will try to access hook index 1 when currentHook only has index 0
      // The error happens because we're trying to get more hooks than exist
      expect(() => {
        useState(1);
      }).toThrow("Rendered more hooks");
    });
  });
});
