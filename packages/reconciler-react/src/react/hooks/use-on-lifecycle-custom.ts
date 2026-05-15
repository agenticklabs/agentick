import { useEffect, useRef } from "react";
import type { LifecycleCustom } from "@agentick/spec";
import { useLifecycleStore } from "../lifecycle-context.js";

/**
 * `useOnLifecycleCustom` — register a callback fired when a
 * `LifecycleCustom` event with the matching namespaced `kind` is
 * dispatched.
 *
 * Custom kinds MUST be namespaced (e.g. `"app:my-app:phase-x"`); the
 * spec reserves the bare framework kinds. No catch-up — application
 * code owns replay semantics if it needs them.
 */
export function useOnLifecycleCustom(
  kind: string,
  callback: (event: LifecycleCustom) => void | Promise<void>,
): void {
  const store = useLifecycleStore();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return store.registerCustom(kind, (event) => ref.current(event as LifecycleCustom));
  }, [store, kind]);
}
