/**
 * V2 COM State Hook
 *
 * Provides state storage in the COM (Context Object Model).
 * State persists across renders and changes trigger reconciliation.
 *
 * This is similar to useState but:
 * - State is stored in the shared COM, not component-local
 * - State persists across ticks
 * - Returns a Signal-like interface
 */

import { useCallback, useMemo } from "react";
import { useCom } from "./context";
import type { Signal } from "./signal";

/**
 * Use state stored in the COM.
 *
 * @param key - Unique key for this state in the COM
 * @param initialValue - Initial value if not already set
 * @returns A Signal-like object for reading and writing the state
 *
 * @example
 * ```tsx
 * function StatusComponent() {
 *   const status = useComState('status', 'pending');
 *
 *   // Read the value
 *   console.log(status()); // or status.value
 *
 *   // Update the value
 *   status.set('active');
 *
 *   return <System>Status: {status()}</System>;
 * }
 * ```
 */
export function useComState<T>(key: string, initialValue: T): Signal<T> {
  const ctx = useCom();

  // Initialize if needed
  if (ctx.getState<T>(key) === undefined) {
    ctx.setState(key, initialValue);
  }

  // Get the current value
  const getValue = useCallback((): T => {
    return (ctx.getState<T>(key) ?? initialValue) as T;
  }, [ctx, key, initialValue]);

  // Set a new value
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      const currentValue = getValue();
      const newValue =
        typeof value === "function" ? (value as (prev: T) => T)(currentValue) : value;
      ctx.setState(key, newValue);
      // Request recompilation to reflect the change
      ctx.requestRecompile(`COM state '${key}' changed`);
    },
    [ctx, key, getValue],
  );

  // Update with function
  const update = useCallback(
    (fn: (prev: T) => T) => {
      setValue(fn);
    },
    [setValue],
  );

  // Subscribe to changes (no-op for now, reconciliation handles this)
  const subscribe = useCallback((_callback: (value: T) => void): (() => void) => {
    // In v2, reconciliation handles reactivity
    // This is a placeholder for future subscription support
    return () => {};
  }, []);

  // Create the Signal-like interface
  const signal = useMemo((): Signal<T> => {
    const fn = getValue as Signal<T>;
    Object.defineProperty(fn, "value", {
      get: getValue,
      enumerable: true,
    });
    (fn as Signal<T>).set = setValue;
    (fn as Signal<T>).update = update;
    (fn as Signal<T>).subscribe = subscribe;
    return fn as Signal<T>;
  }, [getValue, setValue, update, subscribe]);

  return signal;
}
