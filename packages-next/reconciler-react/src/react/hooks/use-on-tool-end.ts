import { useEffect, useRef } from "react";
import type { LifecycleToolEnd } from "@agentick/spec-next";
import { useLifecycleStore } from "../lifecycle-context.js";

/**
 * `useOnToolEnd` — register a callback fired when a tool dispatch
 * finishes (ADR 55). Carries the terminal `outcome` + `durationMs` —
 * inject corrective context after a failure, record results after a
 * search.
 *
 * No catch-up. Components that mount AFTER tool-end fired for a call
 * cannot retroactively observe it; they observe the next tool-end
 * normally.
 *
 * @example
 * useOnToolEnd((e) => {
 *   if (e.outcome === "failed") setLastError(`${e.name}: ${e.durationMs}ms`);
 * });
 */
export function useOnToolEnd(callback: (event: LifecycleToolEnd) => void | Promise<void>): void {
  const store = useLifecycleStore();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return store.register("tool-end", (event) => ref.current(event));
  }, [store]);
}
