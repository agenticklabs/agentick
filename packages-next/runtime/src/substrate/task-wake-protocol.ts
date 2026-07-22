/**
 * Substrate wire constants for the TASK-WAKE seam.
 *
 * "A backgrounded task that finishes while nothing is observing it wakes its
 * owning session" is a thin one-way `inbox.send` over the inbox's existing
 * addressed messaging — exactly the shape as the escalation protocol, but
 * fire-and-forget (tell, not ask): the {@link TasksHarness} `send`s a
 * {@link SessionTaskWakePayload} to `session:{sessionId}`; the session's
 * `handleMessage` turns it into a real `session.send(...)` execution.
 *
 * **This module owns the wire constants only** — the addressing convention
 * (`session:{sessionId}` message type) and the provenance marker. The wake
 * CONTRACT types themselves — {@link TaskWakeOutcome}, {@link TaskWakePolicy},
 * {@link SendInput} — live in `@agentick/spec-next`; the payload composes
 * them here. `runtime-next` depends on `spec-next`, so composing spec types in
 * a substrate wire payload is fine (the reverse — a runtime constant a spec
 * protocol referenced — would be the cycle the escalation module documents).
 *
 * Unlike escalation, NO spec protocol method references the wake payload, so
 * the payload type is defined here (not re-exported from spec).
 *
 * @see docs/proposals/v2/blueprint/68-persistent-tasks.md
 * @see packages-next/tasks/src/harness.ts — the fire side (settle → wake)
 * @see packages-next/session/src/harness.ts — the receive side (handleMessage)
 */

import type { SendInput, TaskWakeOutcome } from "@agentick/spec-next";

/**
 * Inbox message type for a task-completion wake addressed to a session
 * (`session:{sessionId}`). Handled by the session's `handleMessage`: stamp
 * provenance ({@link TASK_WAKE_SOURCE} + `taskId`) and run one real
 * `session.send(...)` execution (steering-safe — it joins an in-flight
 * execution rather than colliding).
 */
export const SESSION_TASK_WAKE_MESSAGE_TYPE = "session:task-wake";
export type SessionTaskWakeMessageType = typeof SESSION_TASK_WAKE_MESSAGE_TYPE;

/**
 * Provenance marker stamped on the wake send's `metadata` (execution-level)
 * and on each wake message's `metadata` (`{ source: TASK_WAKE_SOURCE, taskId }`)
 * so timelines / clients attribute the synthesized turn to a task completion
 * rather than to a real user turn. The session stamps this authoritatively —
 * regardless of whether a callable wake policy set it.
 */
export const TASK_WAKE_SOURCE = "task-wake";
export type TaskWakeSource = typeof TASK_WAKE_SOURCE;

/**
 * Fire-and-forget wake envelope. The tasks harness resolves the per-task
 * {@link TaskWakePolicy} at the terminal transition into a concrete
 * {@link SendInput} (the default bounded-metadata message for `wake: true`, or
 * the callback's shaped result) and sends it here; a `null` from a callable
 * policy suppresses the wake, so no message is sent at all.
 */
export interface SessionTaskWakePayload {
  /** The completed task's id — the wake's provenance key. */
  readonly taskId: string;
  /** Bounded terminal metadata (NO raw output). */
  readonly outcome: TaskWakeOutcome;
  /**
   * The send to run. `P` is erased to `unknown` on the wire — the default
   * wake carries only `messages` + `metadata` (serializable); a callable
   * policy MAY add non-serializable per-call overrides, which — like
   * `session:send` itself — restrict the wake to the in-process inbox until a
   * serializable wire subset is designed.
   */
  readonly send: SendInput;
}
