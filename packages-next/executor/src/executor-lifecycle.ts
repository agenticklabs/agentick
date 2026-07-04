/**
 * `ExecutorLifecycle` — shared in-flight + abort bookkeeping for
 * `LanguageModelExecutor` implementations.
 *
 * Shared by the two executors that remain after the ADR 52 collapse —
 * `LanguageModelExecutor` (the one real executor; `Base`/subclass/
 * `define*`/`Callback` tiers were deleted) and `FakeLanguageModelExecutor`.
 * Each instantiates one and delegates `abort()` + the pre-execute aborted
 * check to it.
 *
 * Holds two collections:
 *   - `inFlight: Map<executionId, ExecutorInFlightEntry>` — currently
 *     running executions, indexed for `abort()` lookups.
 *   - `aborted: Set<executionId>` — execution ids whose `abort()` was
 *     observed BEFORE `runOperation` started; the next call for that
 *     id short-circuits with `ProviderAborted`.
 *
 * The two-collection design covers both "abort while running" (find
 * the entry, fire the controller / interrupt the fiber) and "abort
 * before running" (add to the aborted set; the next execute sees it).
 */

import type { Fiber } from "effect";

/**
 * Per-execution lifecycle entry. Subclass-specific extensions
 * (e.g. a streaming `Fiber.RuntimeFiber`) attach via the optional
 * fields. `abort` is the `AbortController` whose signal feeds the
 * provider SDK; `fiber` is the streaming fiber that owns the
 * Effect.Stream pipeline (used by `executeStream`).
 */
export interface ExecutorInFlightEntry {
  readonly executionId: string;
  /**
   * External-abort bridge. The executor merges this controller's
   * signal with the caller's signal and the fiber's interruption
   * signal so all three converge to a single SDK abort.
   */
  abort?: AbortController;
  /**
   * Streaming fiber — set on the `executeStream` codepath so
   * `abort()` can interrupt it.
   */
  fiber?: Fiber.RuntimeFiber<unknown, unknown>;
  /**
   * The reason passed to `abort()`, retained on the entry so the
   * terminal envelope can surface it after the runtime cleanup.
   */
  abortReason?: string;
}

/**
 * Shared in-flight + aborted bookkeeping. One instance per executor.
 *
 * @example
 * class MyExecutor extends BaseHarness<"executor"> implements LanguageModelExecutor {
 *   private readonly lifecycle = new ExecutorLifecycle();
 *
 *   abort(input: AbortExecutorInput): Promise<void> {
 *     return runHarnessProtocol(
 *       Effect.sync(() => this.lifecycle.abortExecution(input.executionId, input.reason)),
 *     );
 *   }
 *
 *   private executeBody(input, executionId) {
 *     return Effect.gen(this, function* () {
 *       if (this.lifecycle.isAborted(executionId)) {
 *         return yield* Effect.fail(new ProviderAborted({ reason: "aborted prior to execute" }));
 *       }
 *       const controller = new AbortController();
 *       this.lifecycle.register(executionId, { executionId, abort: controller });
 *       try {
 *         // … execute …
 *       } finally {
 *         this.lifecycle.unregister(executionId);
 *       }
 *     });
 *   }
 * }
 */
export class ExecutorLifecycle {
  readonly inFlight = new Map<string, ExecutorInFlightEntry>();
  readonly aborted = new Set<string>();

  /** Register an execution as in-flight. */
  register(entry: ExecutorInFlightEntry): void {
    this.inFlight.set(entry.executionId, entry);
  }

  /** Remove the in-flight entry when the execution completes. */
  unregister(executionId: string): void {
    this.inFlight.delete(executionId);
  }

  /** Return the in-flight entry for an execution, if any. */
  get(executionId: string): ExecutorInFlightEntry | undefined {
    return this.inFlight.get(executionId);
  }

  /**
   * Whether `abort()` was observed for this execution. Set when
   * `abort()` is called; checked before each execute to short-circuit
   * pre-aborted runs with `ProviderAborted`.
   */
  isAborted(executionId: string): boolean {
    return this.aborted.has(executionId);
  }

  /**
   * Abort an execution by id. Updates `aborted` (so future executes
   * with this id short-circuit) AND fires the in-flight entry's
   * AbortController (so the currently-running SDK call gets the
   * abort). Both are needed for the "abort while running" + "abort
   * before run starts" cases.
   *
   * The fiber-interrupt path lives separately — `executeStream`
   * handlers store the fiber on the entry and call `Fiber.interrupt`
   * themselves; this helper sticks to the controller-based bridge to
   * keep the dependency surface tight.
   */
  abortExecution(executionId: string, reason?: string): void {
    const r = reason ?? "aborted";
    const entry = this.inFlight.get(executionId);
    if (entry) {
      entry.abortReason = r;
      entry.abort?.abort(r);
    }
    this.aborted.add(executionId);
  }

  /**
   * Read the abort reason previously recorded for an execution.
   * Useful for terminal envelopes after the in-flight entry is gone.
   */
  abortReasonFor(executionId: string): string | undefined {
    return this.inFlight.get(executionId)?.abortReason;
  }
}
