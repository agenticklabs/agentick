/**
 * `@agentick/tasks-next/client` — the client-side projection of task state.
 *
 * The far side of the task channels: a reactive view an app frontend subscribes
 * to. Depends on `@agentick/client-next` (the generic `channelView`) — NOT on the
 * tasks harness runtime. Mirrors the knobs `/client` + the `/react` subpath
 * convention: a harness package may add a `/client` surface that depends on the
 * generic client without pulling the server harness into a browser bundle.
 */

export { taskStatusView, type TaskStatusClient, type TaskStatusMap } from "./task-status-view.js";
