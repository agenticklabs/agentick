/**
 * Lifecycle Hooks
 *
 * Event-driven hooks for component and tick lifecycle phases.
 * All callbacks receive data first, com (context) last.
 */

import { useEffect, useRef, useDebugValue } from "react";
import { useRuntimeStore } from "./runtime-context";
import { useCom } from "./context";
import type {
  TickStartCallback,
  TickEndCallback,
  AfterCompileCallback,
  MountCallback,
  UnmountCallback,
} from "./types";

/**
 * Register a callback to run when the component mounts.
 *
 * @example
 * ```tsx
 * useOnMount((com) => {
 *   console.log("Component mounted");
 *   com.setState("initialized", true);
 * });
 * ```
 */
export function useOnMount(callback: MountCallback): void {
  const com = useCom();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onMount registered");

  useEffect(() => {
    savedCallback.current(com as any);
  }, [com]);
}

/**
 * Register a callback to run when the component unmounts.
 *
 * @example
 * ```tsx
 * useOnUnmount((com) => {
 *   console.log("Component unmounting");
 *   com.setState("initialized", false);
 * });
 * ```
 */
export function useOnUnmount(callback: UnmountCallback): void {
  const com = useCom();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onUnmount registered");

  useEffect(() => {
    return () => {
      savedCallback.current(com as any);
    };
  }, [com]);
}

/**
 * Register a callback to run at the start of each tick.
 *
 * @example
 * ```tsx
 * useOnTickStart((tickState) => {
 *   console.log(`Tick ${tickState.tick} starting!`);
 * });
 *
 * useOnTickStart((tickState, com) => {
 *   com.setState("lastTickStart", tickState.tick);
 * });
 * ```
 *
 * > **Note:** Uses `useEffect` internally, so the callback is registered
 * > _after_ the component's first render. This means:
 * >
 * > - **Tick 1**: Component mounts, effect queues callback registration
 * > - **Tick 2+**: Callback fires at tick start
 * >
 * > If you need code to run on the very first tick, use component
 * > initialization or `useMemo` instead.
 */
export function useOnTickStart(callback: TickStartCallback): void {
  const store = useRuntimeStore();
  const savedCallback = useRef(callback);

  // Update ref on each render so callback has fresh closure
  savedCallback.current = callback;

  useDebugValue("onTickStart registered");

  useEffect(() => {
    const cb: TickStartCallback = (tickState, com) => savedCallback.current(tickState, com);
    store.tickStartCallbacks.add(cb);
    return () => {
      store.tickStartCallbacks.delete(cb);
    };
  }, [store]);
}

/**
 * Register a callback to run at the end of each tick.
 *
 * The callback receives TickResult (primary data) and COM (context).
 * TickResult contains data about the completed tick and control methods
 * to influence whether execution continues.
 *
 * @example
 * ```tsx
 * // Simple: inspect results
 * useOnTickEnd((result) => {
 *   console.log(`Tick ${result.tick} complete, tokens: ${result.usage?.totalTokens}`);
 * });
 *
 * // Control continuation with boolean return
 * useOnTickEnd((result) => !result.text?.includes("<DONE>"));
 *
 * // Control continuation with methods (includes reasons)
 * useOnTickEnd((result, com) => {
 *   if (result.text?.includes("<DONE>")) {
 *     result.stop("task-complete");
 *   } else {
 *     result.continue("still-working");
 *   }
 * });
 *
 * // Async verification
 * useOnTickEnd(async (result) => {
 *   const verified = await checkWithModel(result.text);
 *   return !verified; // continue if not verified
 * });
 * ```
 */
export function useOnTickEnd(callback: TickEndCallback): void {
  const store = useRuntimeStore();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onTickEnd registered");

  useEffect(() => {
    const cb: TickEndCallback = (result, com) => savedCallback.current(result, com);
    store.tickEndCallbacks.add(cb);
    return () => {
      store.tickEndCallbacks.delete(cb);
    };
  }, [store]);
}

/**
 * Register a callback to run after compilation.
 * This is where you can inspect the compiled output and request recompilation.
 *
 * @example
 * ```tsx
 * // Inspect compiled output
 * useAfterCompile((compiled) => {
 *   console.log(`Compiled ${compiled.tools.length} tools`);
 * });
 *
 * // Request recompilation when needed
 * useAfterCompile((compiled, com) => {
 *   if (compiled.tools.length === 0) {
 *     registerMoreTools();
 *     com.requestRecompile('adding tools');
 *   }
 * });
 * ```
 */
export function useAfterCompile(callback: AfterCompileCallback): void {
  const store = useRuntimeStore();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onAfterCompile registered");

  useEffect(() => {
    const cb: AfterCompileCallback = (compiled, com) => savedCallback.current(compiled, com);
    store.afterCompileCallbacks.add(cb);
    return () => {
      store.afterCompileCallbacks.delete(cb);
    };
  }, [store]);
}

/**
 * Control whether execution continues after each tick.
 *
 * This is the primary hook for implementing agent loops with custom termination conditions.
 * The callback receives TickResult and optionally COM, and should return whether to continue.
 *
 * The callback can:
 * 1. Return a boolean (true = continue, false = stop)
 * 2. Call result.stop(reason?) or result.continue(reason?) for control with reasons
 * 3. Be async for verification with external services
 *
 * @param shouldContinue - Callback that determines whether to continue execution
 *
 * @example
 * ```tsx
 * // Simple: continue until done token
 * useContinuation((r) => !r.text?.includes("<DONE>"));
 *
 * // With reasons
 * useContinuation((r) => {
 *   if (r.text?.includes("<DONE>")) {
 *     r.stop("task-complete");
 *   } else if (r.tick >= 10) {
 *     r.stop("max-ticks-reached");
 *   } else {
 *     r.continue("still-working");
 *   }
 * });
 *
 * // Async verification
 * useContinuation(async (r) => {
 *   const verified = await verifyWithModel(r.text);
 *   return verified ? false : true; // stop if verified
 * });
 *
 * // Multiple conditions
 * useContinuation((r) =>
 *   r.toolCalls.length > 0 ||           // pending tools
 *   (r.tick < 10 && !r.text?.includes("DONE"))
 * );
 * ```
 */
export function useContinuation(shouldContinue: TickEndCallback): void {
  useOnTickEnd(shouldContinue);
}
