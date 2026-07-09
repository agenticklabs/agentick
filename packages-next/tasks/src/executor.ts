/**
 * `InProcessTaskExecutor` — the bundled default {@link TaskExecutor}
 * (ADR 68). The CURRENT `TasksHarness` fiber execution refactored to
 * drive the uniform `report` callback instead of mutating a private
 * record. Behavior is byte-identical to the pre-ADR-68 harness for the
 * caller — this is a mechanical lift of the runner internals onto the
 * record/report seam, not a semantics change.
 *
 * **Two work runners — Promise-flavor and Effect-flavor** (unchanged from
 * the prior `runPromiseWork` / `runEffectWork`):
 *
 *   - **Promise path.** Direct `workPromise.then().catch()`; cancellation
 *     is the harness-owned `AbortController` (observed by the work fn).
 *     `Fiber.interrupt` doesn't propagate into a wrapped Promise, so
 *     there is no fiber to interrupt — {@link cancel} is a no-op (the
 *     harness has already aborted the signal). `settled` is fire-and-
 *     forget: a Promise work that ignores the signal keeps running, same
 *     as before.
 *
 *   - **Effect path.** `Effect.runFork` + `Fiber` tracking; {@link
 *     cancel} calls `Fiber.interrupt` and RETURNS the interrupt Promise
 *     so the harness's `await cancel()` waits for finalizers (settled-
 *     cancel). Typed failure (`Effect.fail`) → `failed`; defect
 *     (`Effect.die`) → `failed`; interruption → `cancelled`.
 *
 * `reattach` returns `undefined` — a lost in-process fiber cannot be
 * re-attached, so on restart the harness marks its orphaned `working`
 * record `interrupted` (ADR 68 honest accounting).
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 */

import { Cause, Effect, Fiber } from "effect";
import { causeValue, reasonOf } from "@agentick/utils-next";
import type {
  TaskExecution,
  TaskExecutor,
  TaskExecutorHooks,
  TaskFailure,
  TaskRecord,
  TaskReport,
  TaskWork,
  TaskWorkContext,
} from "@agentick/spec-next";

import { assertInteractive, buildTaskElicit } from "./task-elicit.js";

/** In-process execution handle — carries the Effect `Fiber` when one exists. */
interface InProcessExecution extends TaskExecution {
  readonly kind: "in-process";
  /** Present only on the Effect path; `undefined` for Promise/sync work. */
  readonly fiber?: Fiber.RuntimeFiber<unknown, unknown>;
}

/** Build a structured {@link TaskFailure} from a raw thrown / rejected value. */
function toFailure(cause: unknown): TaskFailure {
  return { kind: "error", reason: reasonOf(cause), cause };
}

export class InProcessTaskExecutor implements TaskExecutor {
  readonly kind = "in-process";

  start(
    record: TaskRecord,
    work: TaskWork,
    report: TaskReport,
    signal: AbortSignal,
    hooks?: TaskExecutorHooks,
  ): TaskExecution {
    // Wrap an external-input pause: flip `working → input_required` for
    // the await, then restore `working` when it settles. The harness's
    // `applyTransition` ignores post-terminal reports, so a cancel while
    // paused drives the record terminal and the `finally`'s `working`
    // report is a safe no-op (it can't strand the task). A detached task
    // cannot pause on client input (`interactive ⊥ detached`, ADR 69) —
    // guard loud rather than hang against a dead ancestor inbox.
    const awaitingInput: TaskWorkContext["awaitingInput"] = (promise, opts) => {
      assertInteractive(record);
      report({
        status: "input_required",
        ...(opts?.message !== undefined ? { statusMessage: opts.message } : {}),
      });
      return Promise.resolve(promise).finally(() => report({ status: "working" }));
    };

    // Build the work ctx here — onProgress / setStatusMessage funnel into
    // the ONE report path. The signal is harness-owned (aborts on cancel
    // / close); the work fn observes it. `elicit` composes escalation
    // (ADR 69) over `awaitingInput` + the harness `hooks`.
    const ctx: TaskWorkContext = {
      signal,
      onProgress: (update) => report({ progress: update }),
      setStatusMessage: (message) => report({ statusMessage: message }),
      awaitingInput,
      elicit: buildTaskElicit({ record, awaitingInput, hooks }),
    };

    // Invoke work SYNCHRONOUSLY so its body runs (registering signal
    // listeners, etc.) before start() returns — a synchronous cancel()
    // right after submit relies on the listener being attached
    // (AbortSignal listeners do NOT fire when attached post-abort).
    let ret: ReturnType<TaskWork>;
    try {
      ret = work(ctx);
    } catch (syncThrow) {
      report({ status: "failed", failure: toFailure(syncThrow) });
      return { kind: this.kind } satisfies InProcessExecution;
    }

    if (Effect.isEffect(ret)) {
      return this.runEffect(ret as Effect.Effect<unknown, unknown, never>, report);
    }
    const workPromise: Promise<unknown> = ret instanceof Promise ? ret : Promise.resolve(ret);
    return this.runPromise(workPromise, report);
  }

  private runPromise(workPromise: Promise<unknown>, report: TaskReport): InProcessExecution {
    // Report completion / failure. Post-terminal reports (e.g. a
    // signal-honoring work rejecting AFTER a caller cancel already drove
    // the record terminal) are ignored by the harness's report handler —
    // preserving the "cancel wins the race" semantics of the prior impl.
    void workPromise.then(
      (value) => report({ status: "completed", result: value }),
      (cause) => report({ status: "failed", failure: toFailure(cause) }),
    );
    return { kind: this.kind };
  }

  private runEffect(
    effect: Effect.Effect<unknown, unknown, never>,
    report: TaskReport,
  ): InProcessExecution {
    // matchCauseEffect runs onSuccess / onFailure INSIDE the forked
    // program, so the imperative report calls live in `Effect.sync`
    // blocks. Interruption (external Fiber.interrupt from cancel OR an
    // internal Effect.interrupt) surfaces as an interrupt-only cause;
    // `Cause.isInterruptedOnly` distinguishes it from typed failures +
    // defects. The caller-cancel reason wins because the harness applies
    // the `cancelled` transition FIRST, making this interrupt report a
    // no-op post-terminal.
    const program = effect.pipe(
      Effect.matchCauseEffect({
        onSuccess: (value) => Effect.sync(() => report({ status: "completed", result: value })),
        onFailure: (cause) =>
          Effect.sync(() => {
            if (Cause.isInterruptedOnly(cause)) {
              report({ status: "cancelled", failure: { kind: "aborted", reason: "interrupted" } });
              return;
            }
            // Unwrap the originating value from the Cause so `failure.cause`
            // carries the typed E (Effect.fail) or the defect (Effect.die)
            // verbatim; fall back to the Cause itself for exotic shapes.
            report({ status: "failed", failure: toFailure(causeValue(cause) ?? cause) });
          }),
      }),
    );
    const fiber = Effect.runFork(program);
    return { kind: this.kind, fiber };
  }

  reattach(): TaskExecution | undefined {
    // A lost in-process fiber can't be re-attached — the harness marks
    // the orphaned `working` record `interrupted`.
    return undefined;
  }

  cancel(execution: TaskExecution, _reason?: string): void | Promise<void> {
    const fiber = (execution as InProcessExecution).fiber;
    if (fiber === undefined) return; // Promise/sync path — harness aborted the signal.
    // Effect path — Fiber.interrupt propagates through Effect.sleep,
    // Effect.async finalizers, Effect.gen yields, etc. Return the
    // interrupt Promise so the harness's `await cancel()` waits for
    // finalizers (settled-cancel). `.catch` is defensive — never let a
    // finalizer defect wedge the cancel call.
    return Effect.runPromise(Fiber.interrupt(fiber))
      .then(() => undefined)
      .catch(() => undefined);
  }
}
