/**
 * COM State Hook
 *
 * Provides state storage in the COM (Context Object Model).
 * State persists across renders and changes trigger re-renders.
 *
 * This is similar to useState but:
 * - State is stored in the shared COM, not component-local
 * - State persists across ticks
 * - Returns a Signal-like interface
 *
 * Reactivity: Subscribes to COM's "state:changed" events via a React
 * version counter, ensuring the component re-renders when state is
 * modified externally (e.g. from a tool handler).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

  // Version counter triggers React re-render when COM state changes externally
  const [, setVersion] = useState(0);
  const setVersionRef = useRef(setVersion);
  setVersionRef.current = setVersion;

  // Subscribe to COM "state:changed" events for this key
  useEffect(() => {
    const handler = (changedKey: string) => {
      if (changedKey === key) {
        setVersionRef.current((v) => v + 1);
      }
    };
    ctx.on("state:changed", handler);
    return () => {
      ctx.off("state:changed", handler);
    };
  }, [ctx, key]);

  // Read directly from COM (always fresh — works in tool handlers, effects, etc.)
  const getValue = useCallback((): T => {
    return (ctx.getState<T>(key) ?? initialValue) as T;
  }, [ctx, key, initialValue]);

  // Set a new value — writes to COM, which emits event, which triggers re-render
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      const currentValue = getValue();
      const newValue =
        typeof value === "function" ? (value as (prev: T) => T)(currentValue) : value;
      ctx.setState(key, newValue);
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

  // Create the Signal-like interface — reads from COM directly, always fresh
  const signal = useMemo((): Signal<T> => {
    const fn = getValue as Signal<T>;
    Object.defineProperty(fn, "value", {
      get: getValue,
      enumerable: true,
    });
    fn.set = setValue;
    fn.update = update;
    return fn;
  }, [getValue, setValue, update]);

  return signal;
}
