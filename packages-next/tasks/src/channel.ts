/**
 * Canonical wire channels for the TasksHarness.
 *
 * Two channels because two event types live on the bus:
 *
 *   `session:channel:task-status`   — task FSM transitions
 *                                     (`working → completed`, etc.).
 *                                     Payload: `TaskInfo`.
 *   `session:channel:task-progress` — work-in-progress updates from
 *                                     the task's `onProgress` callback.
 *                                     Payload: `{ taskId, current,
 *                                     total?, message? }`.
 *
 * Two channels (not one with discriminator) so subscribers can filter
 * by phase — UIs typically want status transitions for the task list
 * AND progress events for the in-flight bar; a single channel would
 * force every subscriber to receive both.
 *
 * Mirrors `notifications/tasks/status` and `notifications/progress`
 * from the MCP wire — Phase B's codec maps these envelopes onto the
 * wire 1:1.
 */

import type { TaskInfo } from "@agentick/spec-next";

export const TASK_STATUS_CHANNEL = "task-status" as const;
export const TASK_PROGRESS_CHANNEL = "task-progress" as const;

/**
 * Opening frame of the `task-status` channel (ADR 87 / the K8s watch-list
 * model). A fresh subscriber receives this FIRST — the full set of current
 * tasks — before any live delta, so a late/reconnecting client renders the
 * existing task list instead of only tasks that transition after it joined.
 * Discriminated by `kind` so a consumer distinguishes it from a live delta
 * frame, whose payload is a bare {@link TaskInfo} (unchanged, MCP-mirrored).
 */
export interface TaskStatusSnapshotFrame {
  readonly kind: "snapshot";
  readonly tasks: readonly TaskInfo[];
}

/**
 * A `task-status` frame as seen on the bus: either the opening
 * {@link TaskStatusSnapshotFrame} (seed) or a live delta (one task's current
 * {@link TaskInfo}). The client `taskStatusView` folds both.
 */
export type TaskStatusFrame = TaskStatusSnapshotFrame | TaskInfo;

export type TaskStatusChannelName = typeof TASK_STATUS_CHANNEL;
export type TaskProgressChannelName = typeof TASK_PROGRESS_CHANNEL;

/** Fully-qualified channel names as they appear on the bus envelope. */
export const TASK_STATUS_CHANNEL_FQN = "session:channel:task-status" as const;
export const TASK_PROGRESS_CHANNEL_FQN = "session:channel:task-progress" as const;
