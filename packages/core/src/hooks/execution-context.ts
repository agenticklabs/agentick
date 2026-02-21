/**
 * Execution Context Hooks
 *
 * Hooks for execution-level lifecycle events.
 */

import { useRef } from "react";
import { useOnTickStart } from "./lifecycle.js";
import type { COM } from "../com/object-model.js";

/**
 * Register a callback that fires once at the start of each execution.
 *
 * Derived from useOnTickStart — fires on the first tick of each new execution
 * by tracking executionId changes across ticks. Does NOT fire on mount
 * (same as useOnTickStart behavior).
 *
 * @example
 * ```tsx
 * useOnExecutionStart((executionId, ctx) => {
 *   console.log(`Execution ${executionId} started`);
 *   ctx.setState("lastExecutionId", executionId);
 * });
 * ```
 */
export function useOnExecutionStart(
  handler: (executionId: string, ctx: COM) => void | Promise<void>,
): void {
  const lastExecRef = useRef<string | null>(null);

  useOnTickStart((tickState, ctx) => {
    const execId = tickState.executionId;
    if (execId && execId !== lastExecRef.current) {
      lastExecRef.current = execId;
      handler(execId, ctx);
    }
  });
}
