/**
 * `useToolBridge` — render-time access to the session's tool
 * registration bridge.
 *
 * Returns `undefined` when no `ToolBridge` is wired into HookBridges
 * (e.g., the reconciler is running with stub bridges). React tools
 * built with `createTool` (the React-flavored variant) call this
 * during mount to register handlers that close over React-Context-
 * derived deps.
 */

import type { ToolBridge } from "@agentick/spec";
import { useBridges } from "../bridge-context.js";

export function useToolBridge(): ToolBridge | undefined {
  return useBridges().tools;
}
