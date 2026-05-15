import { useEffect, useRef } from "react";

/**
 * `useOnMount` — convenience wrapper around `useEffect(() => ..., [])`.
 * Runs once after first commit. Returning a function schedules
 * `useOnUnmount` semantics.
 */
export function useOnMount(callback: () => void | (() => void) | Promise<void>): void {
  // Capture the latest callback in a ref so the empty-deps useEffect
  // doesn't stale-close on the first-render callback.
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    const ret = ref.current();
    return typeof ret === "function" ? ret : undefined;
  }, []);
}

/**
 * `useOnUnmount` — convenience wrapper around `useEffect(() => () => ..., [])`.
 */
export function useOnUnmount(callback: () => void): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return () => ref.current();
  }, []);
}
