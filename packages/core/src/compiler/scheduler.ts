/**
 * Reconciliation Scheduler
 *
 * Batches state changes into single reconciliation passes.
 * This is the foundation of the reactive model.
 *
 * State change → schedule() → microtask → flush() → reconcile()
 *
 * ## Observable State
 *
 * The scheduler exposes its internal state as a Signal for DevTools and
 * component observation:
 *
 * ```typescript
 * const scheduler = new ReconciliationScheduler(compiler);
 *
 * // Subscribe to state changes
 * effect(() => {
 *   const state = scheduler.state();
 *   console.log(`Status: ${state.status}, pending: ${state.pendingReasons.length}`);
 * });
 * ```
 *
 * This enables:
 * - DevTools visualization of reconciliation cycles
 * - Real-time fiber tree status
 * - Debugging reactive flow
 */

import type { FiberCompiler } from "./fiber-compiler";
import { signal, type Signal } from "../state/signal";

/**
 * Scheduler status representing the current phase.
 *
 * - `idle`: No pending work, waiting for state changes
 * - `pending`: Work scheduled, waiting for microtask flush
 * - `reconciling`: Currently reconciling fiber tree
 * - `in_tick`: Inside a tick (compile handles reconciliation)
 */
export type SchedulerStatus = "idle" | "pending" | "reconciling" | "in_tick";

/**
 * Observable scheduler state for DevTools and component observation.
 *
 * This state is exposed as a Signal, allowing reactive subscriptions
 * to scheduler lifecycle events.
 */
export interface SchedulerState {
  /** Current scheduler phase */
  status: SchedulerStatus;
  /** Reasons that triggered pending reconciliation */
  pendingReasons: readonly string[];
  /** Timestamp of last reconciliation completion (ms since epoch) */
  lastReconcileAt: number | null;
  /** Duration of last reconciliation (ms) */
  lastReconcileDuration: number | null;
  /** Total number of reconciliations performed */
  reconcileCount: number;
  /** Whether currently inside a tick */
  inTick: boolean;
}

/**
 * Reconciliation event for observability callbacks.
 */
export interface ReconcileEvent {
  /** Reasons that triggered this reconciliation */
  reasons: string[];
  /** Time taken to reconcile (ms) */
  duration: number;
  /** Whether this happened during a tick */
  duringTick: boolean;
}

/**
 * Scheduler configuration.
 */
export interface SchedulerConfig {
  /** Enable debug logging */
  debug?: boolean;
  /** Callback when reconciliation completes (in addition to signal updates) */
  onReconcile?: (event: ReconcileEvent) => void;
}

/**
 * Reconciliation Scheduler
 *
 * Batches multiple state changes into a single reconciliation pass.
 * Uses microtask queue for batching (like React's batching).
 *
 * Exposes observable `state` signal for DevTools and component observation.
 */
export class ReconciliationScheduler {
  private compiler: FiberCompiler;
  private pending = false;
  private _pendingReasons: string[] = [];
  private flushPromise: Promise<void> | null = null;
  private duringTick = false;
  private config: SchedulerConfig;
  private _reconcileCount = 0;

  /**
   * Observable scheduler state.
   *
   * DevTools and components can subscribe to this signal to observe
   * reconciliation lifecycle events in real-time.
   *
   * @example
   * ```typescript
   * // In DevTools
   * effect(() => {
   *   const state = scheduler.state();
   *   updateUI(state.status, state.reconcileCount);
   * });
   *
   * // In component (via useSchedulerState hook)
   * const { status, pendingReasons } = useSchedulerState();
   * ```
   */
  readonly state: Signal<SchedulerState>;

  constructor(compiler: FiberCompiler, config: SchedulerConfig = {}) {
    this.compiler = compiler;
    this.config = config;

    // Initialize observable state
    this.state = signal<SchedulerState>({
      status: "idle",
      pendingReasons: [],
      lastReconcileAt: null,
      lastReconcileDuration: null,
      reconcileCount: 0,
      inTick: false,
    });
  }

  /**
   * Update the observable state.
   * This is called internally whenever scheduler state changes.
   */
  private updateState(partial: Partial<SchedulerState>): void {
    const current = this.state();
    this.state.set({ ...current, ...partial });
  }

  /**
   * Mark that we're currently inside a tick.
   * During ticks, reconciliation is handled by compile().
   */
  enterTick(): void {
    this.duringTick = true;
    this.updateState({
      status: "in_tick",
      inTick: true,
    });
  }

  /**
   * Mark that we've exited the tick.
   * Any pending reconciliation will now run.
   */
  exitTick(): void {
    this.duringTick = false;
    this.updateState({
      status: this.pending ? "pending" : "idle",
      inTick: false,
    });
    // If there's pending work, flush it
    if (this.pending) {
      this.scheduleFlush();
    }
  }

  /**
   * Schedule a reconciliation.
   * Multiple calls are batched into a single reconciliation pass.
   *
   * @param reason - Optional reason for debugging/DevTools
   */
  schedule(reason?: string): void {
    if (reason) {
      this._pendingReasons.push(reason);
    }

    const wasAlreadyPending = this.pending;
    this.pending = true;

    // Update observable state with new reason
    if (!wasAlreadyPending || reason) {
      this.updateState({
        status: this.duringTick ? "in_tick" : "pending",
        pendingReasons: [...this._pendingReasons],
      });
    }

    if (wasAlreadyPending) {
      // Already scheduled, reasons will be collected
      return;
    }

    // During tick, compile() will handle reconciliation
    // We just mark that work is pending
    if (this.duringTick) {
      return;
    }

    this.scheduleFlush();
  }

  /**
   * Schedule a flush via microtask.
   */
  private scheduleFlush(): void {
    if (this.flushPromise) return;

    this.flushPromise = Promise.resolve().then(() => {
      this.flushPromise = null;
      return this.flush();
    });
  }

  /**
   * Flush pending reconciliation immediately.
   * Used by compile() to ensure fiber tree is up-to-date.
   */
  async flush(): Promise<void> {
    if (!this.pending) return;

    this.pending = false;
    const reasons = this._pendingReasons;
    this._pendingReasons = [];
    this._reconcileCount++;

    // Update state: entering reconciliation
    this.updateState({
      status: "reconciling",
      pendingReasons: [],
    });

    const start = performance.now();

    try {
      await this.compiler.reconcile();
    } finally {
      const duration = performance.now() - start;
      const now = Date.now();

      // Update state: reconciliation complete
      this.updateState({
        status: this.duringTick ? "in_tick" : "idle",
        lastReconcileAt: now,
        lastReconcileDuration: duration,
        reconcileCount: this._reconcileCount,
      });

      // Call legacy callback (for backward compatibility)
      if (this.config.onReconcile) {
        this.config.onReconcile({
          reasons,
          duration,
          duringTick: this.duringTick,
        });
      }

      if (this.config.debug && reasons.length > 0) {
        console.log(`[Scheduler] Reconciled in ${duration.toFixed(2)}ms`, reasons);
      }
    }
  }

  /**
   * Cancel pending reconciliation.
   * Used when session is being destroyed.
   */
  cancel(): void {
    this.pending = false;
    this._pendingReasons = [];
    this.flushPromise = null;

    // Update state: cancelled
    this.updateState({
      status: "idle",
      pendingReasons: [],
    });
  }

  /**
   * Dispose the scheduler and clean up resources.
   * Call this when the session is destroyed.
   */
  dispose(): void {
    this.cancel();
    this.state.dispose();
  }

  /**
   * Check if reconciliation is pending.
   */
  get isPending(): boolean {
    return this.pending;
  }

  /**
   * Get pending reasons (for debugging).
   */
  get reasons(): readonly string[] {
    return this._pendingReasons;
  }

  /**
   * Get current status.
   * Convenience accessor for state().status
   */
  get status(): SchedulerStatus {
    return this.state().status;
  }
}
