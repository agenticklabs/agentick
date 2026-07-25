/**
 * Cross-harness inbox protocol for {@link TasksHarness}.
 *
 * Mirrors the pattern used by {@link ElicitationHarness} — typed
 * inbox messages another harness sends to drive task operations on
 * THIS harness without holding an in-process object reference. Same
 * protocol routes in-memory (LocalInbox) and across cluster nodes
 * (ClusterInbox); the address-based dispatch is the cluster-portable
 * seam.
 *
 * Three message types:
 *
 *   `tasks-cancel`  — fire-and-forget cancel by id. No reply needed.
 *   `tasks-get`     — async lookup; replies via `request-response`
 *                     with `TaskInfo | undefined` payload.
 *   `tasks-result`  — await terminal state; replies via
 *                     `request-response` with the work fn's return
 *                     value (on completed) or a `TaskRejection` (on
 *                     failed / cancelled / unknown id).
 *
 * The reply path reuses the framework's existing `request-response`
 * inbox-message type, so the sender's `BaseHarness.dispatchMessage`
 * auto-intercept routes the reply to a pending Deferred keyed by
 * `correlationId` — no new auto-intercept logic required.
 *
 * @see ./harness.ts TasksHarness.handleMessage
 */

import type { TaskRejection } from "@agentick/spec";

// ============================================================================
// Message type constants
// ============================================================================

export const TASKS_CANCEL_MESSAGE_TYPE = "tasks-cancel" as const;
export const TASKS_GET_MESSAGE_TYPE = "tasks-get" as const;
export const TASKS_RESULT_MESSAGE_TYPE = "tasks-result" as const;

export type TasksCancelMessageType = typeof TASKS_CANCEL_MESSAGE_TYPE;
export type TasksGetMessageType = typeof TASKS_GET_MESSAGE_TYPE;
export type TasksResultMessageType = typeof TASKS_RESULT_MESSAGE_TYPE;

// ============================================================================
// Payloads
// ============================================================================

/**
 * `tasks-cancel` — abort a task by id. No reply.
 *
 * Idempotent on the receiver — unknown ids and already-terminal
 * tasks are silent no-ops; the sender doesn't get an error back.
 * (If the sender needs confirmation, they use `tasks-get` after.)
 */
export interface TasksCancelInboxPayload {
  readonly taskId: string;
  readonly reason?: string;
}

/**
 * `tasks-get` — snapshot lookup. Replies via `request-response`.
 * Reply payload: `TaskInfo | undefined` (undefined for unknown ids).
 */
export interface TasksGetInboxPayload {
  readonly taskId: string;
  readonly replyTo: string;
  readonly correlationId: string;
}

/**
 * `tasks-result` — await terminal. Replies via `request-response`.
 * Reply payload (`TasksResultReply`):
 *   - `{ kind: "value", value }` — task completed.
 *   - `{ kind: "rejection", rejection: TaskRejection }` — failed /
 *     cancelled / unknown id.
 *
 * Unknown ids reply with rejection `{ status: "failed", failure: {
 * kind: "error", reason: "UnknownTaskError" } }` rather than throwing
 * across the wire — the wire surface stays uniform.
 */
export interface TasksResultInboxPayload {
  readonly taskId: string;
  readonly replyTo: string;
  readonly correlationId: string;
}

/**
 * Reply shape for `tasks-result`. Wrapped in a discriminated union
 * because `value` and `rejection` are mutually exclusive — a single
 * `{ value?, rejection? }` would invite caller bugs (which one do I
 * check first?).
 */
export type TasksResultReply<T = unknown> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "rejection"; readonly rejection: TaskRejection };
