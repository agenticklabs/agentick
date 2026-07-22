import { useEffect, useRef } from "react";
import type { LifecycleError } from "@agentick/spec-next";
import { useLifecycleDispatch } from "../lifecycle-context.js";

/**
 * `useOnError` — register a callback fired when a failure is projected
 * from the command-hook system (ADR 89 §4): a FAILED model-executor
 * terminal (`phase: "model"`, from the session's `onAfterLoopTick`
 * forwarder) or a HARD tool-handler failure (`phase: "tool"`, from the
 * `tool:dispatch` around forwarder's catch). `event.phase` names where
 * it happened; `event.error` is `{ name, message, data? }`. Drives
 * corrective-context patterns — stash the message in state and render a
 * recovery section.
 *
 * @example
 * useOnError((e) => setLastError(`${e.phase}: ${e.error.message}`));
 */
export function useOnError(callback: (event: LifecycleError) => void | Promise<void>): void {
  const dispatch = useLifecycleDispatch();
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    return dispatch.register("error", (event) => ref.current(event));
  }, [dispatch]);
}
