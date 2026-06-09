import { useEffect, useRef } from "react";
import type { LifecycleExecutionStart } from "@agentick/spec-next";
import { useLifecycleStore } from "../lifecycle-context.js";

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
  const store = useLifecycleStore();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return store.register("execution-start", (event) => ref.current(event));
  }, [store]);
}
