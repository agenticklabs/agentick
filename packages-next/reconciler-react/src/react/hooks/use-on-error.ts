import { useEffect, useRef } from "react";
import type { LifecycleError } from "@agentick/spec-next";
import { useLifecycleStore } from "../lifecycle-context.js";

/**
 * `useOnError` — register a callback fired when the loop / executor /
 * tool layer surfaces an error via `notifyLifecycle`. `event.phase`
 * names where it happened (`tick` | `execution` | `tool` | `model` | …);
 * `event.error` is `{ name, message, data? }`. Drives corrective-context
 * patterns — stash the message in state and render a recovery section.
 *
 * @example
 * useOnError((e) => setLastError(`${e.phase}: ${e.error.message}`));
 */
export function useOnError(callback: (event: LifecycleError) => void | Promise<void>): void {
  const store = useLifecycleStore();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return store.register("error", (event) => ref.current(event));
  }, [store]);
}
