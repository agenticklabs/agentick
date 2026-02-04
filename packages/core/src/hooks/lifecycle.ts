/**
 * V2 Lifecycle Hooks
 *
 * Custom hooks for tick lifecycle phases.
 * These integrate with the engine's tick orchestration.
 */

import { useEffect, useRef, useDebugValue } from "react";
import { useRuntimeStore } from "./runtime-context";
import type { TickStartCallback, TickEndCallback, AfterCompileCallback, TickResult } from "./types";

/**
 * Register a callback to run at the start of each tick.
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   useTickStart(() => {
 *     console.log('Tick starting!');
 *   });
 *   return <Section>...</Section>;
 * };
 * ```
 */
export function useTickStart(callback: TickStartCallback): void {
  const store = useRuntimeStore();
  const savedCallback = useRef(callback);

  // Update ref on each render so callback has fresh closure
  savedCallback.current = callback;

  useDebugValue("onTickStart registered");

  useEffect(() => {
    const cb: TickStartCallback = () => savedCallback.current();
    store.tickStartCallbacks.add(cb);
    return () => {
      store.tickStartCallbacks.delete(cb);
    };
  }, [store]);
}

/**
 * Register a callback to run at the end of each tick.
 *
 * The callback receives a TickResult containing data about the completed tick
 * and control methods to influence whether execution continues.
 *
 * @example
 * ```tsx
 * // Simple: inspect results
 * useTickEnd((result) => {
 *   console.log(`Tick ${result.tick} complete, tokens: ${result.usage?.totalTokens}`);
 * });
 *
 * // Control continuation with boolean return
 * useTickEnd((result) => !result.text?.includes("<DONE>"));
 *
 * // Control continuation with methods (includes reasons)
 * useTickEnd((result) => {
 *   if (result.text?.includes("<DONE>")) {
 *     result.stop("task-complete");
 *   } else {
 *     result.continue("still-working");
 *   }
 * });
 *
 * // Async verification
 * useTickEnd(async (result) => {
 *   const verified = await checkWithModel(result.text);
 *   return !verified; // continue if not verified
 * });
 * ```
 */
export function useTickEnd(callback: TickEndCallback): void {
  const store = useRuntimeStore();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onTickEnd registered");

  useEffect(() => {
    const cb: TickEndCallback = (result) => savedCallback.current(result);
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
 * const MyComponent = () => {
 *   const com = useCom();
 *
 *   useAfterCompile((compiled) => {
 *     if (compiled.tools.length === 0) {
 *       // Need to add tools - request recompile
 *       registerMoreTools();
 *       com.requestRecompile('adding tools');
 *     }
 *   });
 *
 *   return <Section>...</Section>;
 * };
 * ```
 */
export function useAfterCompile(callback: AfterCompileCallback): void {
  const store = useRuntimeStore();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onAfterCompile registered");

  useEffect(() => {
    const cb: AfterCompileCallback = (compiled) => savedCallback.current(compiled);
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
 * The callback receives the TickResult and should return whether to continue or stop.
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
export function useContinuation(
  shouldContinue: (result: TickResult) => void | boolean | Promise<void | boolean>,
): void {
  useTickEnd(shouldContinue);
}
