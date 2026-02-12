/**
 * Lifecycle Hooks
 *
 * Event-driven hooks for component and tick lifecycle phases.
 * All callbacks receive data first, ctx (context) last.
 */

import { useEffect, useRef, useDebugValue } from "react";
import { useRuntimeStore } from "./runtime-context";
import { useCom } from "./context";
import type {
  TickStartCallback,
  TickEndCallback,
  AfterCompileCallback,
  ExecutionEndCallback,
  MountCallback,
  UnmountCallback,
} from "./types";

/**
 * Register a callback to run when the component mounts.
 *
 * @example
 * ```tsx
 * useOnMount((ctx) => {
 *   console.log("Component mounted");
 *   ctx.setState("initialized", true);
 * });
 * ```
 */
export function useOnMount(callback: MountCallback): void {
  const ctx = useCom();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onMount registered");

  useEffect(() => {
    savedCallback.current(ctx as any);
  }, [ctx]);
}

/**
 * Register a callback to run when the component unmounts.
 *
 * @example
 * ```tsx
 * useOnUnmount((ctx) => {
 *   console.log("Component unmounting");
 *   ctx.setState("initialized", false);
 * });
 * ```
 */
export function useOnUnmount(callback: UnmountCallback): void {
  const ctx = useCom();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onUnmount registered");

  useEffect(() => {
    return () => {
      savedCallback.current(ctx as any);
    };
  }, [ctx]);
}

/**
 * Register a callback to run at the start of each tick.
 *
 * **Timing:** Fires on every tick the component is alive, including
 * the tick in which it mounts. Newly-mounted components receive a
 * catch-up call after their first render.
 *
 * @example
 * ```tsx
 * useOnTickStart((tickState) => {
 *   console.log(`Tick ${tickState.tick} starting!`);
 * });
 *
 * useOnTickStart((tickState, ctx) => {
 *   ctx.setState("lastTickStart", tickState.tick);
 * });
 * ```
 */
export function useOnTickStart(callback: TickStartCallback): void {
  const store = useRuntimeStore();
  const savedCallback = useRef(callback);

  // Update ref on each render so callback has fresh closure
  savedCallback.current = callback;

  useDebugValue("onTickStart registered");

  useEffect(() => {
    const cb: TickStartCallback = (tickState, ctx) => savedCallback.current(tickState, ctx);
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
 * useOnTickEnd((result, ctx) => {
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
    const cb: TickEndCallback = (result, ctx) => savedCallback.current(result, ctx);
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
 * useAfterCompile((compiled, ctx) => {
 *   if (compiled.tools.length === 0) {
 *     registerMoreTools();
 *     ctx.requestRecompile('adding tools');
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
    const cb: AfterCompileCallback = (compiled, ctx) => savedCallback.current(compiled, ctx);
    store.afterCompileCallbacks.add(cb);
    return () => {
      store.afterCompileCallbacks.delete(cb);
    };
  }, [store]);
}

/**
 * Register a callback to run when execution completes (after all ticks finish).
 * Fires once per send() call, after the tick loop exits.
 *
 * Timing: fires after the last tick_end but before the session snapshot
 * is persisted. State changes here are captured in the snapshot.
 *
 * @example
 * ```tsx
 * useOnExecutionEnd((ctx) => {
 *   console.log("Execution complete");
 *   ctx.setState("lastCompleted", Date.now());
 * });
 * ```
 */
export function useOnExecutionEnd(callback: ExecutionEndCallback): void {
  const store = useRuntimeStore();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onExecutionEnd registered");

  useEffect(() => {
    const cb: ExecutionEndCallback = (ctx) => savedCallback.current(ctx);
    store.executionEndCallbacks.add(cb);
    return () => {
      store.executionEndCallbacks.delete(cb);
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
