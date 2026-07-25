/**
 * `ctx.elicit` composition for a task work fn (ADR 69).
 *
 * A task can request input from the connected client mid-run. The
 * mechanism is **escalation as nested `inbox.ask`**: each `ctx.elicit.*`
 * call flips the task `working → input_required` (via `awaitingInput`),
 * `ask`s the owning session up the ownership chain, and resolves with the
 * client's response. This module composes the three collaborators the
 * executor holds — `record` (for the `interactive ⊥ detached` guard), the
 * per-task `awaitingInput`, and the harness-supplied {@link
 * TaskExecutorHooks} (`escalate` = the raw up-chain `inbox.ask`;
 * `buildElicit` = the injected {@link Elicit} sugar factory) — into the
 * `Elicit` surface the work fn sees.
 *
 * **tasks stays elicitation-free.** The sugar (schema construction,
 * throw-on-decline, `try*` variants) lives in `@agentick/elicitation`
 * and is INJECTED as `hooks.buildElicit` (its `buildElicitSugar`). This
 * package never imports it — escalation is payload-agnostic substrate
 * (ADR 69), and `ctx.elicit` is just the first consumer wired on top.
 *
 * @see docs/proposals/v2/blueprint/69-request-escalation.md
 */

import type {
  Elicit,
  ElicitFn,
  ElicitationResult,
  TaskExecutorHooks,
  TaskRecord,
  TaskWorkContext,
} from "@agentick/spec";
import { DetachedTaskCannotElicitError } from "@agentick/spec";

/**
 * Per-task `awaitingInput` (the `working → input_required → working`
 * flip). Aliased to the spec surface so the Promise/Effect overloads stay
 * in one place; `ctx.elicit` composition only ever uses the Promise form
 * (escalate returns a Promise).
 */
export type AwaitingInput = TaskWorkContext["awaitingInput"];

/**
 * `interactive ⊥ detached` (ADR 69). A detached task has no guaranteed
 * live ancestor chain to reach the client — requesting input would hang
 * against a dead inbox, so it fails loud instead. Called before any
 * escalation is issued (so no orphaned `inbox.ask` is left in flight).
 */
export function assertInteractive(record: TaskRecord): void {
  if (record.detached === true) {
    throw new DetachedTaskCannotElicitError({ taskId: record.taskId });
  }
}

/**
 * Compose the task's `ctx.elicit`. When escalation is fully wired
 * (`escalate` + `buildElicit` both present), each form/url call becomes
 * `awaitingInput(escalate(request))` under the injected sugar. When it is
 * not (a bare harness with no session), returns a stub that throws a clear
 * "not configured" error on use — never a silent hang.
 */
export function buildTaskElicit(deps: {
  readonly record: TaskRecord;
  readonly awaitingInput: AwaitingInput;
  readonly hooks: TaskExecutorHooks | undefined;
}): Elicit {
  const { record, awaitingInput, hooks } = deps;
  const escalate = hooks?.escalate;
  const buildElicit = hooks?.buildElicit;
  if (escalate === undefined || buildElicit === undefined) {
    return throwingTaskElicit(
      () =>
        new Error(
          `task ${record.taskId}: ctx.elicit is not configured — this TasksHarness has no escalation wiring (ADR 69). A session-owned harness (buildSessionBridges) supplies it; a bare harness cannot reach a client.`,
        ),
    );
  }
  const composed: ElicitFn = (request, opts) => {
    // Guard BEFORE escalating so a detached task never fires an orphan ask.
    assertInteractive(record);
    return awaitingInput(escalate(request, opts), {
      message: request.message,
    }) as Promise<ElicitationResult<unknown>>;
  };
  return buildElicit(composed);
}

/**
 * An {@link Elicit} whose every method throws `makeError()`. Used where a
 * task cannot elicit — a bare in-process harness with no escalation
 * configured (`buildTaskElicit` with absent `hooks`). The cross-process
 * worker no longer uses this: its `ctx.elicit` is a live IPC bridge (ADR
 * 69 T2b). `canDoForm` / `canDoUrl` report `false` (honest capability
 * probe) rather than throw; everything else fails loud.
 */
export function throwingTaskElicit(makeError: () => Error): Elicit {
  return new Proxy({} as Elicit, {
    get(_target, prop): unknown {
      if (prop === "canDoForm" || prop === "canDoUrl") return () => false;
      return () => {
        throw makeError();
      };
    },
  });
}
