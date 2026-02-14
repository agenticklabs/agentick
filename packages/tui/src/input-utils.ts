/**
 * Input routing utilities for centralized keystroke handling.
 *
 * These helpers let the orchestrator (Chat or custom TUI) route keystrokes
 * to the appropriate handler based on application state.
 */

import type { ToolConfirmationResponse } from "@agentick/client";

/**
 * Handle a keystroke during tool confirmation state.
 *
 * Routes Y/N/A keys to the respond callback. Returns true if the key
 * was handled (consumed), false otherwise.
 */
export function handleConfirmationKey(
  input: string,
  respond: (response: ToolConfirmationResponse) => void,
): boolean {
  const key = input.toLowerCase();
  if (key === "y") {
    respond({ approved: true });
    return true;
  }
  if (key === "n") {
    respond({ approved: false, reason: "rejected by user" });
    return true;
  }
  if (key === "a") {
    respond({ approved: true, always: true });
    return true;
  }
  return false;
}
