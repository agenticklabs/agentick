/**
 * V2 Lifecycle Hooks
 *
 * Custom hooks for tick lifecycle phases.
 * These integrate with the engine's tick orchestration.
 */

import { useEffect, useRef, useDebugValue } from "react";
import { useRuntimeStore } from "./runtime-context";
import type { TickStartCallback, TickEndCallback, AfterCompileCallback } from "./types";

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
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   useTickEnd(() => {
 *     console.log('Tick complete!');
 *   });
 *   return <Section>...</Section>;
 * };
 * ```
 */
export function useTickEnd(callback: TickEndCallback): void {
  const store = useRuntimeStore();
  const savedCallback = useRef(callback);
  savedCallback.current = callback;

  useDebugValue("onTickEnd registered");

  useEffect(() => {
    const cb: TickEndCallback = () => savedCallback.current();
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
