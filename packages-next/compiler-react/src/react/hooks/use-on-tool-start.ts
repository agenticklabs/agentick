import { useEffect, useRef } from "react";
import type { LifecycleToolStart } from "@agentick/spec-next";
import { useLifecycleDispatch } from "../lifecycle-context.js";

/**
 * `useOnToolStart` — register a callback fired when a tool dispatch
 * starts (ADR 55). Drives spinners, "searching…" affordances, and
 * per-tool side-effects.
 *
 * No catch-up. Components that mount AFTER tool-start fired for a call
 * cannot retroactively observe it; they observe the next tool-start
 * normally.
 *
 * @example
 * useOnToolStart((e) => setInflight((m) => ({ ...m, [e.callId]: `${e.name}…` })));
 */
export function useOnToolStart(
  callback: (event: LifecycleToolStart) => void | Promise<void>,
): void {
  const dispatch = useLifecycleDispatch();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return dispatch.register("tool-start", (event) => ref.current(event));
  }, [dispatch]);
}
