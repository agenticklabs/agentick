/**
 * `useLoopControl` — imperative tick control.
 *
 * Returns the `LoopBridge` directly — `{ continueAfterTick,
 * stopAfterTick }`. Components call these from event handlers, effects,
 * or lifecycle hooks to request loop behavior; whether the loop honors
 * the request is governed by the loop executor's handler/middleware
 * chain.
 *
 * @see packages/spec/src/protocol/hook-bridges.ts §LoopBridge
 */

import type { LoopBridge } from "@agentick/spec-next";
import { useBridges } from "../bridge-context.js";

export function useLoopControl(): LoopBridge {
  return useBridges().loop;
}
