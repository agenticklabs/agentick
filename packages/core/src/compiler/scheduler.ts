/**
 * V2 Reconciliation Scheduler
 *
 * Manages reconciliation timing and batching for the v2 fiber compiler.
 *
 * In v2 with react-reconciler:
 * - The React tree stays mounted (persistent fiber root)
 * - State changes trigger React's own reconciliation
 * - This scheduler coordinates when to notify listeners about reconciliation
 * - Batches multiple schedule() calls in the same microtask
 */

import type { FiberCompiler } from "./fiber-compiler";

// ============================================================================
// Types
// ============================================================================

export interface ReconcileEvent {
  /** Reason for reconciliation */
  reason: string;

  /** Timestamp of reconciliation */
  timestamp: number;

  /** Whether this was during a tick (deferred) or idle */
  deferred: boolean;
}

/**
 * Current state of the reconciliation scheduler.
 * Used for DevTools and debugging.
 */
export interface SchedulerState {
  /** Whether the scheduler is currently executing a tick */
  isExecutingTick: boolean;

  /** Whether a reconciliation is scheduled */
  isScheduled: boolean;

  /** Pending reconciliation reasons */
  pendingReasons: string[];

  /** Deferred reconciliation reasons (during tick) */
  deferredReasons: string[];
}

export interface ReconciliationSchedulerOptions {
  /** Callback when reconciliation completes */
  onReconcile?: (event: ReconcileEvent) => void;

  /** Delay before executing reconciliation (for debouncing) */
  debounceMs?: number;
}

// ============================================================================
// ReconciliationScheduler
// ============================================================================

/**
 * Coordinates reconciliation timing for the fiber compiler.
 *
 * Features:
 * - Batches multiple schedule() calls in the same microtask
 * - Defers reconciliation during tick execution
 * - Emits events when reconciliation completes
 */
export class ReconciliationScheduler {
  private compiler: FiberCompiler;
  private options: ReconciliationSchedulerOptions;

  // Pending reconciliation state
  private pendingReasons: string[] = [];
  private isScheduled = false;
  private isExecutingTick = false;
  private deferredReasons: string[] = [];

  constructor(compiler: FiberCompiler, options: ReconciliationSchedulerOptions = {}) {
    this.compiler = compiler;
    this.options = options;
  }

  /**
   * Schedule a reconciliation.
   *
   * Multiple calls in the same microtask are batched.
   * Calls during tick execution are deferred until the tick completes.
   */
  schedule(reason: string): void {
    // If we're in the middle of a tick, defer until after
    if (this.isExecutingTick) {
      this.deferredReasons.push(reason);
      return;
    }

    this.pendingReasons.push(reason);

    // Batch multiple calls in the same microtask
    if (!this.isScheduled) {
      this.isScheduled = true;
      queueMicrotask(() => this.flush());
    }
  }

  /**
   * Mark that a tick is starting.
   * Reconciliation requests during a tick will be deferred.
   */
  enterTick(): void {
    this.isExecutingTick = true;
  }

  /**
   * Mark that a tick has completed.
   * Flushes any deferred reconciliation requests.
   */
  exitTick(): void {
    this.isExecutingTick = false;

    // Flush any deferred reconciliation requests
    if (this.deferredReasons.length > 0) {
      const reasons = this.deferredReasons;
      this.deferredReasons = [];

      for (const reason of reasons) {
        this.schedule(reason);
      }
    }
  }

  /**
   * Flush pending reconciliation requests.
   */
  private flush(): void {
    this.isScheduled = false;

    if (this.pendingReasons.length === 0) {
      return;
    }

    const reasons = this.pendingReasons;
    this.pendingReasons = [];

    // Combine reasons for the event
    const combinedReason = reasons.join("; ");

    // Trigger reconciliation on the compiler
    // In v2, the compiler will update the React tree
    try {
      // The compiler's reconcile method will be called by the session
      // when the next tick starts. We just emit the event to notify listeners.

      // Emit reconcile event
      if (this.options.onReconcile) {
        this.options.onReconcile({
          reason: combinedReason,
          timestamp: Date.now(),
          deferred: false,
        });
      }
    } catch (error) {
      console.error("[ReconciliationScheduler] Error during reconciliation:", error);
    }
  }

  /**
   * Check if there are pending reconciliation requests.
   */
  hasPending(): boolean {
    return this.pendingReasons.length > 0 || this.deferredReasons.length > 0;
  }

  /**
   * Clear all pending reconciliation requests.
   */
  clear(): void {
    this.pendingReasons = [];
    this.deferredReasons = [];
    this.isScheduled = false;
  }

  /**
   * Dispose of the scheduler.
   */
  dispose(): void {
    this.clear();
  }

  /**
   * Get the current scheduler state.
   */
  getState(): SchedulerState {
    return {
      isExecutingTick: this.isExecutingTick,
      isScheduled: this.isScheduled,
      pendingReasons: [...this.pendingReasons],
      deferredReasons: [...this.deferredReasons],
    };
  }
}
