/**
 * V2 Signal Hook
 *
 * Reactive signals integrated with React.
 */

import { useRef, useReducer, useEffect } from "react";
import type { Signal } from "./types";

/**
 * Create a signal - reactive state that can trigger reconciliation.
 *
 * Unlike useState, signals:
 * - Can be read outside of render
 * - Can be subscribed to
 * - Don't cause immediate re-render (schedule reconcile instead)
 *
 * @example
 * ```tsx
 * const MyComponent = () => {
 *   const count = useSignal(0);
 *
 *   const handleClick = () => {
 *     count.set(c => c + 1);
 *   };
 *
 *   return <Section>Count: {count()}</Section>;
 * };
 * ```
 */
export function useSignal<T>(initialValue: T): Signal<T> {
  // Force update function
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  // Create signal once
  const signalRef = useRef<Signal<T> | null>(null);

  if (signalRef.current === null) {
    signalRef.current = createSignal(initialValue);
  }

  // Subscribe to changes
  useEffect(() => {
    const unsubscribe = signalRef.current!.subscribe(() => {
      // For now, just force update
      // In the full implementation, this would schedule reconcile
      forceUpdate();
    });
    return unsubscribe;
  }, []);

  return signalRef.current;
}

/**
 * Create a standalone signal (not tied to a component).
 */
export function createSignal<T>(initialValue: T): Signal<T> {
  let value = initialValue;
  const subscribers = new Set<(value: T) => void>();

  const signal = (() => value) as Signal<T>;

  Object.defineProperty(signal, "value", {
    get: () => value,
    enumerable: true,
  });

  signal.set = (newValue: T | ((prev: T) => T)) => {
    const nextValue =
      typeof newValue === "function" ? (newValue as (prev: T) => T)(value) : newValue;

    if (nextValue !== value) {
      value = nextValue;
      subscribers.forEach((cb) => cb(value));
    }
  };

  signal.update = (fn: (prev: T) => T) => {
    signal.set(fn(value));
  };

  signal.subscribe = (callback: (value: T) => void) => {
    subscribers.add(callback);
    return () => {
      subscribers.delete(callback);
    };
  };

  return signal;
}

/**
 * Create a computed signal that derives from other signals.
 *
 * @example
 * ```tsx
 * const count = useSignal(5);
 * const doubled = useComputed(() => count() * 2, [count]);
 * // doubled() === 10
 * ```
 */
export function useComputed<T>(compute: () => T, deps: Signal<unknown>[]): Signal<T> {
  const computedRef = useRef<Signal<T> | null>(null);
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

  if (computedRef.current === null) {
    // Create a signal with initial computed value
    computedRef.current = createSignal(compute());
  }

  // Recompute when deps change
  useEffect(() => {
    const unsubscribes = deps.map((dep) =>
      dep.subscribe(() => {
        const newValue = compute();
        computedRef.current!.set(newValue);
        forceUpdate();
      }),
    );

    return () => {
      unsubscribes.forEach((unsub) => unsub());
    };
  }, deps);

  return computedRef.current;
}
