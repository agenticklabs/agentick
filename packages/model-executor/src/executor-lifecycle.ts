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

import type { Effect, Fiber } from "effect";

import type {
  AdapterDelta,
  ExecuteInput,
  ExecutorTerminal,
  LanguageModelExecutionResult,
  LanguageModelInput,
  Operation,
  TerminalEvent,
} from "@agentick/spec";

/**
 * Per-call context threaded into the nested `model:provider-request`
 * command body (ADR 52 amendment 2026-07-22) via a `FiberRef` — the
 * non-serializable half of the invocation the command's serializable
 * `input` (the native request) cannot carry.
 *
 * The `model:provider-request` command's `input` IS the provider-native
 * request (so `onBeforeModelProviderRequest` transforms exactly that), and
 * its own sink emits RAW provider chunks (so `onModelProviderRequestChunk`
 * observes them pre-`mapChunk`). Everything else the SDK-interaction body
 * needs — the caller's abort signal, the AdapterDelta sink the outer
 * `model:generate[_stream]` op drains, and the Operation delta events are
 * attributed to — rides HERE, set by `generateBody` with `FiberRef.locally`
 * immediately around the in-fiber `modelProviderRequest.fx(...)` call.
 */
export interface ProviderRequestCall {
  /** The originating execute input — carries `signal`, `target`, `scope`. */
  readonly execInput: ExecuteInput<LanguageModelInput>;
  /**
   * The AdapterDelta sink of the outer `model:generate_stream` op (the
   * loop's per-tick sink, or the iterator queue's) — `null` on the
   * non-streaming `model:generate` path (deltas still emit to the bus).
   */
  readonly deltaSink: ((delta: AdapterDelta) => Effect.Effect<void>) | null;
  /**
   * The outer `model:generate[_stream]` Operation — the identity every
   * in-flight AdapterDelta bus event is attributed to, so delta
   * observability is byte-identical to the pre-split pipeline.
   */
  readonly op: Operation<unknown, unknown>;
}

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
 * class MyExecutor extends BaseHarness<"model"> implements LanguageModelExecutor {
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

// ============================================================================
// Run-composition fold helpers (ADR 89 §1)
// ============================================================================

/**
 * A non-success executor terminal that the `run` body folds a
 * command-boundary failure into (a canceled/vetoed/failed short-circuit)
 * — as opposed to the raw provider output the happy path carries. The
 * discriminants (`canceled` / `vetoed` / `failed`) never collide with a
 * `LanguageModelExecutionResult` (which is keyed on `output` / `stopReason`)
 * or a provider `TRaw`, so this cleanly separates the two.
 *
 * @see LanguageModelExecutor.runBody — the non-streaming run composition
 *   (ADR 89 §1) routes the execute step through the `model:generate`
 *   command and folds its boundary failures via {@link operationOutcomeToTerminal}.
 */
export function isFoldedTerminal(
  value: unknown,
): value is ExecutorTerminal<LanguageModelExecutionResult> {
  if (typeof value !== "object" || value === null || !("outcome" in value)) return false;
  const outcome = (value as { outcome?: unknown }).outcome;
  return outcome === "canceled" || outcome === "vetoed" || outcome === "failed";
}

/**
 * Fold an `OperationOutcomeError` raised at the `model:generate` command
 * boundary into an {@link ExecutorTerminal}. A `guardGenerate` veto →
 * `vetoed`; a replayed `canceled` terminal → `canceled`. Anything else
 * (a `deferred` verdict, a replayed `failed` terminal) returns `undefined`
 * so the caller re-raises — `run` has no terminal shape for those and they
 * belong on the failure channel.
 *
 * Typed against the structural `OperationOutcomeError` shape (`{ terminal }`)
 * that `Effect.catchTag("OperationOutcomeError", …)` narrows to via the
 * `SubstrateError` union — no runtime import needed.
 */
export function operationOutcomeToTerminal(err: {
  readonly terminal: TerminalEvent;
}): ExecutorTerminal<LanguageModelExecutionResult> | undefined {
  const terminal = err.terminal;
  if (terminal.outcome === "vetoed") {
    return {
      outcome: "vetoed",
      ...(terminal.reason !== undefined ? { reason: terminal.reason } : {}),
    };
  }
  if (terminal.outcome === "canceled") {
    return {
      outcome: "canceled",
      ...(terminal.reason !== undefined ? { reason: terminal.reason } : {}),
    };
  }
  return undefined;
}
