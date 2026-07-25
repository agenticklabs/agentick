import { useEffect, useRef } from "react";
import type { LifecycleTickEnd } from "@agentick/spec";
import { useLifecycleDispatch } from "../lifecycle-context.js";

/**
 * `useOnTickEnd` — register a callback fired at tick-end.
 *
 * No catch-up. Components that mount AFTER tick-end fired for tick N
 * cannot retroactively observe tick N's result; they observe the next
 * tick-end normally.
 */
export function useOnTickEnd(callback: (event: LifecycleTickEnd) => void | Promise<void>): void {
  const dispatch = useLifecycleDispatch();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return dispatch.register("tick-end", (event) => ref.current(event));
  }, [dispatch]);
}
