import { useEffect, useRef } from "react";
import type { LifecycleError } from "@agentick/spec";
import { useLifecycleStore } from "../lifecycle-context.js";

/**
 * `useOnError` — register a callback fired when the loop / executor /
 * tool layer surfaces an error via `notifyLifecycle`.
 */
export function useOnError(callback: (event: LifecycleError) => void | Promise<void>): void {
  const store = useLifecycleStore();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return store.register("error", (event) => ref.current(event));
  }, [store]);
}
