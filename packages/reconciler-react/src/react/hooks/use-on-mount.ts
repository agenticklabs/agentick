import { useEffect } from "react";

/**
 * `useOnMount` — convenience wrapper around `useEffect(() => ..., [])`.
 * Runs once after first commit. Returning a function schedules
 * `useOnUnmount` semantics.
 */
export function useOnMount(callback: () => void | (() => void) | Promise<void>): void {
  useEffect(() => {
    const ret = callback();
    return typeof ret === "function" ? ret : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * `useOnUnmount` — convenience wrapper around `useEffect(() => () => ..., [])`.
 */
export function useOnUnmount(callback: () => void): void {
  useEffect(() => {
    return callback;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
