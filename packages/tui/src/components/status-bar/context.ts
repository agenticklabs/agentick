/**
 * StatusBar context — provides data from hooks to child widgets.
 *
 * `<StatusBar>` calls `useContextInfo` and `useStreamingText` once,
 * then populates this context so widgets can read shared data without
 * each widget subscribing independently.
 */

import { createContext, useContext } from "react";
import type { ContextInfo } from "@agentick/shared";
import type { ChatMode } from "@agentick/client";

export interface StatusBarData {
  /** Current chat mode (idle, streaming, confirming_tool) */
  mode: ChatMode;
  /** Whether an execution is currently running */
  isExecuting: boolean;
  /** Session ID */
  sessionId: string;
  /** Context info from latest tick (null before first tick) */
  contextInfo: ContextInfo | null;
}

export const StatusBarContext = createContext<StatusBarData | null>(null);

/**
 * Read StatusBar data from context.
 * Returns null when used outside a `<StatusBar>` — widgets should
 * fall back to explicit props in that case.
 */
export function useStatusBarData(): StatusBarData | null {
  return useContext(StatusBarContext);
}
