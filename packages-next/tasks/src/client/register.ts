/**
 * ADR 87 — contribute `session.tasks` to the client `SessionHandle`.
 *
 * Importing `@agentick/tasks-next/client` (which re-exports this) both TYPES the
 * slot (the `declare module` below) and REGISTERS the runtime factory, so
 * `client.session(id).tasks` self-assembles — the client twin of the server's
 * `bridges.tasks`. Client-core stays agnostic; this is the harness's contribution.
 */

import { registerSessionHandleExtension } from "@agentick/client-core-next";
import { tasksHandle, type TasksHandleView } from "./tasks-handle.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /**
     * The tasks resource handle for this session — the CQRS shape shared by
     * `session.knobs` (view + `set`): the live `task-status` `ChannelView`
     * (read: `get`/`subscribe`/`onChange`) PLUS the `cancel(taskId)` write
     * command (`== tasksHandle(client, id)`).
     */
    readonly tasks: TasksHandleView;
  }
}

registerSessionHandleExtension("tasks", (client, sessionId) => tasksHandle(client, sessionId));
