import { useEffect, useRef } from "react";
import type { LifecycleToolStart } from "@agentick/spec-next";
import { useLifecycleStore } from "../lifecycle-context.js";

/**
 * `useOnToolStart` — register a callback fired when a tool dispatch
 * starts (ADR 55). Drives spinners, "searching…" affordances, and
 * per-tool side-effects.
 *
 * No catch-up. Components that mount AFTER tool-start fired for a call
 * cannot retroactively observe it; they observe the next tool-start
 * normally.
 */
export function useOnToolStart(
  callback: (event: LifecycleToolStart) => void | Promise<void>,
): void {
  const store = useLifecycleStore();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return store.register("tool-start", (event) => ref.current(event));
  }, [store]);
}
