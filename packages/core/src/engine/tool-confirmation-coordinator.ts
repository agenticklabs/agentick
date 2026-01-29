import type { ToolConfirmationResult } from "../tool/tool";

/**
 * Deferred promise pattern for async coordination
 */
class Deferred<T> {
  promise: Promise<T>;
  resolve!: (value: T) => void;
  reject!: (error: Error) => void;

  constructor() {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

/**
 * ToolConfirmationCoordinator - Manages tool confirmation requests
 *
 * Handles waiting for user confirmation before executing tools that have
 * requiresConfirmation enabled. Similar pattern to ClientToolCoordinator
 * but for confirmation flow instead of tool results.
 *
 * Flow:
 * 1. ToolExecutor checks if tool requiresConfirmation
 * 2. If true, calls waitForConfirmation() which blocks
 * 3. Engine yields 'tool_confirmation_required' event to client
 * 4. Client shows confirmation UI to user
 * 5. User confirms/denies (with optional "always" flag)
 * 6. Client sends confirmation via /api/channels/tool-confirmation
 * 7. Server calls resolveConfirmation() which unblocks the promise
 * 8. ToolExecutor proceeds or skips based on confirmation
 */
export class ToolConfirmationCoordinator {
  private pendingConfirmations = new Map<string, Deferred<ToolConfirmationResult>>();

  /**
   * Wait for user confirmation for a tool call.
   * Returns a promise that resolves when user confirms/denies.
   *
   * Note: No timeout by default - waits indefinitely for user response.
   * The tool is simply not executed if no confirmation is received.
   *
   * @param toolUseId - ID of the tool call awaiting confirmation
   * @param toolName - Name of the tool (for result)
   * @returns Promise that resolves with confirmation result
   */
  async waitForConfirmation(toolUseId: string, _toolName: string): Promise<ToolConfirmationResult> {
    // Create deferred promise for this confirmation
    const deferred = new Deferred<ToolConfirmationResult>();
    this.pendingConfirmations.set(toolUseId, deferred);

    try {
      return await deferred.promise;
    } finally {
      // Cleanup (in case of cancellation)
      this.pendingConfirmations.delete(toolUseId);
    }
  }

  /**
   * Check if there's a pending confirmation for a tool call.
   *
   * @param toolUseId - ID of the tool call
   * @returns true if confirmation is pending
   */
  hasPendingConfirmation(toolUseId: string): boolean {
    return this.pendingConfirmations.has(toolUseId);
  }

  /**
   * Resolve a pending confirmation with user's response.
   * Called when client sends confirmation via /api/channels/tool-confirmation.
   *
   * @param toolUseId - ID of the tool call
   * @param confirmed - Whether user confirmed the execution
   * @param always - Whether to remember this decision
   * @returns The confirmation result, or null if no pending confirmation found
   */
  resolveConfirmation(
    toolUseId: string,
    confirmed: boolean,
    always: boolean = false,
  ): ToolConfirmationResult | null {
    const pending = this.pendingConfirmations.get(toolUseId);
    if (!pending) {
      return null;
    }

    // Build result
    const result: ToolConfirmationResult = {
      toolUseId,
      toolName: "", // Will be filled by caller who has access to tool metadata
      confirmed,
      always,
    };

    // Resolve the promise
    this.pendingConfirmations.delete(toolUseId);
    pending.resolve(result);

    return result;
  }

  /**
   * Resolve a pending confirmation with full result (including tool name).
   * Used internally when we have all the context.
   *
   * @param result - Full confirmation result
   * @returns true if resolved, false if no pending confirmation found
   */
  resolveConfirmationWithResult(result: ToolConfirmationResult): boolean {
    const pending = this.pendingConfirmations.get(result.toolUseId);
    if (!pending) {
      return false;
    }

    this.pendingConfirmations.delete(result.toolUseId);
    pending.resolve(result);
    return true;
  }

  /**
   * Cancel a pending confirmation (e.g., execution cancelled).
   *
   * @param toolUseId - ID of the tool call to cancel
   */
  cancelConfirmation(toolUseId: string): void {
    const deferred = this.pendingConfirmations.get(toolUseId);
    if (deferred) {
      this.pendingConfirmations.delete(toolUseId);
      deferred.reject(new Error(`Tool confirmation cancelled: ${toolUseId}`));
    }
  }

  /**
   * Cancel all pending confirmations (e.g., engine shutdown).
   */
  cancelAll(): void {
    for (const [toolUseId, deferred] of this.pendingConfirmations.entries()) {
      deferred.reject(new Error(`Tool confirmation cancelled: ${toolUseId}`));
    }
    this.pendingConfirmations.clear();
  }

  /**
   * Get the number of pending confirmations.
   * Useful for debugging and testing.
   */
  getPendingCount(): number {
    return this.pendingConfirmations.size;
  }
}
