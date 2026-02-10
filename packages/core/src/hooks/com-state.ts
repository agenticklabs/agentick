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
 * Reactivity: Uses `useSyncExternalStore` to subscribe to COM state changes.
 * This is the React 18+ recommended pattern for external stores, and works
 * correctly with react-reconciler 0.33's synchronous rendering model where
 * external setState calls are batched on the async scheduler.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { useCom } from "./context";
import { useRuntimeStore, type HookPersistenceOptions } from "./runtime-context";
import type { Signal } from "./signal";

/**
 * Options for {@link useComState}.
 */
export interface UseComStateOptions extends HookPersistenceOptions {}

/**
 * Use state stored in the COM.
 *
 * @param key - Unique key for this state in the COM
 * @param initialValue - Initial value if not already set
 * @param options - Persistence options
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
 *
 * @example Opt out of snapshot persistence
 * ```tsx
 * // Transient UI state — don't survive persistence
 * const isExpanded = useComState('ui:expanded', false, { persist: false });
 * ```
 */
export function useComState<T>(
  key: string,
  initialValue: T,
  options?: UseComStateOptions,
): Signal<T> {
  const ctx = useCom();
  const store = useRuntimeStore();

  // Register persistence preference
  if (options?.persist === false) {
    store.comStatePersist.set(key, false);
  }

  // Initialize if needed
  if (ctx.getState<T>(key) === undefined) {
    ctx.setState(key, initialValue);
  }

  // Subscribe to COM state changes via useSyncExternalStore.
  // This replaces the old useState+useEffect pattern which relied on external
  // setState propagating synchronously — broken in react-reconciler 0.33.
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      const handler = (changedKey: string) => {
        if (changedKey === key) {
          onStoreChange();
        }
      };
      ctx.on("state:changed", handler);
      return () => {
        ctx.off("state:changed", handler);
      };
    },
    [ctx, key],
  );

  const getSnapshot = useCallback((): T => {
    return (ctx.getState<T>(key) ?? initialValue) as T;
  }, [ctx, key, initialValue]);

  // useSyncExternalStore ensures React re-renders when the snapshot changes,
  // even when the change originates outside of React (e.g. from a tool handler).
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Read directly from COM (always fresh — works in tool handlers, effects, etc.)
  const getValue = getSnapshot;

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

  // Subscribe to value changes (used by useComputed for dep tracking)
  const subscribeToValue = useCallback(
    (callback: (value: T) => void) => {
      const handler = (changedKey: string) => {
        if (changedKey === key) {
          callback(getValue());
        }
      };
      ctx.on("state:changed", handler);
      return () => {
        ctx.off("state:changed", handler);
      };
    },
    [ctx, key, getValue],
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
    fn.subscribe = subscribeToValue;
    return fn;
  }, [getValue, setValue, update, subscribeToValue]);

  return signal;
}
