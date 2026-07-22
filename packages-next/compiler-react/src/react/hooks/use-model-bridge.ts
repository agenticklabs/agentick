/**
 * `useModelBridge` — render-time access to the session's model
 * registration bridge (ADR 56).
 *
 * Returns `undefined` when no `ModelBridge` is wired into HookBridges
 * (e.g. the compiler is running with stub bridges, or the session
 * didn't wire per-tick model selection). The exact analogue of
 * {@link useToolBridge}.
 *
 * @see docs/proposals/v2/blueprint/56-tree-declared-model-per-tick.md
 */

import type { ModelBridge } from "@agentick/spec-next";
import { useBridges } from "../bridge-context.js";

export function useModelBridge(): ModelBridge | undefined {
  return useBridges().models;
}
