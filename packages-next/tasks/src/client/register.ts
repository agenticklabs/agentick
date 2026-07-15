/**
 * ADR 87 — contribute `session.tasks` to the client `SessionHandle`.
 *
 * Importing `@agentick/tasks-next/client` (which re-exports this) both TYPES the
 * slot (the `declare module` below) and REGISTERS the runtime factory, so
 * `client.session(id).tasks` self-assembles — the client twin of the server's
 * `bridges.tasks`. Client-core stays agnostic; this is the harness's contribution.
 */

import { registerSessionHandleExtension, type ChannelView } from "@agentick/client-core-next";
import { taskStatusView, type TaskStatusMap } from "./task-status-view.js";
import type { TaskStatusFrame } from "../channel.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /**
     * Live task-status view for this session — the folded map of tasks by
     * `taskId` (`== taskStatusView(client, id)`). Read-only today; task action
     * verbs (`cancel`, …) land when their client wire methods do (ADR 87 §3).
     */
    readonly tasks: ChannelView<TaskStatusMap, TaskStatusFrame>;
  }
}

registerSessionHandleExtension("tasks", (client, sessionId) => taskStatusView(client, sessionId));
