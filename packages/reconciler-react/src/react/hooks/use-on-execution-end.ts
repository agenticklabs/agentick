import { useEffect, useRef } from "react";
import type { LifecycleExecutionEnd } from "@agentick/spec";
import { useLifecycleStore } from "../lifecycle-context.js";

/**
 * `useOnExecutionEnd` — register a callback fired at execution-end.
 * No catch-up.
 */
export function useOnExecutionEnd(
  callback: (event: LifecycleExecutionEnd) => void | Promise<void>,
): void {
  const store = useLifecycleStore();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return store.register("execution-end", (event) => ref.current(event));
  }, [store]);
}
