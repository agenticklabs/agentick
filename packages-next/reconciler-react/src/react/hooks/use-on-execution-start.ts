import { useEffect, useRef } from "react";
import type { LifecycleExecutionStart } from "@agentick/spec-next";
import { useLifecycleDispatch } from "../lifecycle-context.js";

/**
 * `useOnExecutionStart` — register a callback fired at execution-start.
 *
 * Catch-up semantics: mounting mid-execution invokes the handler
 * immediately with the active execution-start event. Same shape as
 * `useOnTickStart`.
 */
export function useOnExecutionStart(
  callback: (event: LifecycleExecutionStart) => void | Promise<void>,
): void {
  const dispatch = useLifecycleDispatch();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return dispatch.register("execution-start", (event) => ref.current(event));
  }, [dispatch]);
}
