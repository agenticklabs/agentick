import type { ToolResult } from "../tool/tool.js";

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
 * ClientToolCoordinator - Manages client tool execution and result coordination
 *
 * Handles waiting for client tool results when requiresResponse is true.
 * Tools are streamed to the client, and the coordinator waits for results
 * to be sent back via the /api/channels/tool-results endpoint.
 *
 * If no active execution is waiting (execution ended, timeout, etc.),
 * resolveResult() returns false and the application should handle persistence
 * and optionally trigger a new execution.
 */
export class ClientToolCoordinator {
  private pendingResults = new Map<string, Deferred<ToolResult>>();
  private timeouts = new Map<string, NodeJS.Timeout>();

  /**
   * Wait for a client tool result.
   * Returns immediately with defaultResult if requiresResponse is false.
   * Otherwise waits for client to send result via resolveResult().
   *
   * @param toolUseId - ID of the tool call
   * @param defaultResult - Default result if requiresResponse is false
   * @param requiresResponse - Whether tool requires client response
   * @param timeout - Timeout in ms (default: 30000)
   * @returns Promise that resolves when client sends result
   */
  async waitForResult(
    toolUseId: string,
    defaultResult: ToolResult,
    requiresResponse: boolean,
    timeout: number = 30000,
  ): Promise<ToolResult> {
    // If tool doesn't require response, return default immediately
    if (!requiresResponse) {
      return defaultResult;
    }

    // Create deferred promise for this tool call
    const deferred = new Deferred<ToolResult>();
    this.pendingResults.set(toolUseId, deferred);

    // Set timeout
    const timeoutHandle = setTimeout(() => {
      this.pendingResults.delete(toolUseId);
      this.timeouts.delete(toolUseId);
      deferred.reject(new Error(`Client tool '${toolUseId}' timed out after ${timeout}ms`));
    }, timeout);
    this.timeouts.set(toolUseId, timeoutHandle);

    try {
      return await deferred.promise;
    } finally {
      // Cleanup
      this.timeouts.delete(toolUseId);
    }
  }

  /**
   * Resolve a pending tool call with a result from the client.
   *
   * @param toolUseId - ID of the tool call
   * @param result - Result from client
   * @returns true if result was resolved to an active execution, false if no pending call found
   *
   * If false is returned, the execution likely ended (timeout, completion, cancellation).
   * The application should handle persistence and optionally trigger a new execution.
   */
  resolveResult(toolUseId: string, result: ToolResult): boolean {
    const pending = this.pendingResults.get(toolUseId);
    if (!pending) {
      return false;
    }

    // Clear timeout
    const timeoutHandle = this.timeouts.get(toolUseId);
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      this.timeouts.delete(toolUseId);
    }

    // Resolve the promise
    this.pendingResults.delete(toolUseId);
    pending.resolve(result);
    return true;
  }

  /**
   * Cancel waiting for a tool result (e.g., execution cancelled).
   *
   * @param toolUseId - ID of the tool call to cancel
   */
  cancelExecution(toolUseId: string): void {
    const deferred = this.pendingResults.get(toolUseId);
    if (deferred) {
      const timeoutHandle = this.timeouts.get(toolUseId);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        this.timeouts.delete(toolUseId);
      }
      this.pendingResults.delete(toolUseId);
      deferred.reject(new Error(`Tool execution cancelled: ${toolUseId}`));
    }
  }

  /**
   * Cancel all pending tool executions (e.g., engine shutdown).
   */
  cancelAll(): void {
    for (const [toolUseId, deferred] of this.pendingResults.entries()) {
      const timeoutHandle = this.timeouts.get(toolUseId);
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      deferred.reject(new Error(`Tool execution cancelled: ${toolUseId}`));
    }
    this.pendingResults.clear();
    this.timeouts.clear();
  }
}
