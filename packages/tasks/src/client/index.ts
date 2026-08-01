/**
 * `@agentick/tasks/client` — the client-side projection of task state.
 *
 * The far side of the task channels: a reactive view an app frontend subscribes
 * to. Depends on `@agentick/client-core` (the generic `channelView`) — NOT on the
 * tasks harness runtime. Mirrors the knobs `/client` + the `/react` subpath
 * convention: a harness package may add a `/client` surface that depends on the
 * generic client without pulling the server harness into a browser bundle.
 */

// Type-only side effect: makes `tasks/cancel` a valid `WireMethods` row for the
// handle's `transport.request("tasks/cancel", …)` — no server code.
import "../wire-augment.js";

export { taskStatusView, type TaskStatusClient, type TaskStatusMap } from "./task-status-view.js";
export { tasksHandle, type TasksHandle, type TasksCommandClient } from "./tasks-handle.js";

// The channel names + frame shapes, nameable from `/client` so a browser bundle
// that subscribes or folds frames itself does NOT have to import the ROOT barrel
// (which drags the tasks harness runtime in). `channel.ts` is type-only against
// spec, so this adds no runtime edge beyond the two constants the view already
// imports.
export {
  TASK_PROGRESS_CHANNEL,
  TASK_PROGRESS_CHANNEL_FQN,
  TASK_STATUS_CHANNEL,
  TASK_STATUS_CHANNEL_FQN,
  type TaskProgressChannelName,
  type TaskStatusChannelName,
  type TaskStatusFrame,
  type TaskStatusSnapshotFrame,
} from "../channel.js";

// Side-effect: contribute `session.tasks` to the client SessionHandle (ADR 87).
import "./register.js";
