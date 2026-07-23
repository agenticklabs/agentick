/**
 * ADR 87 — contribute `session.tasks` to the client `SessionHandle`.
 *
 * Importing `@agentick/tasks-next/client` (which re-exports this) both TYPES the
 * slot (the `declare module` below) and REGISTERS the runtime factory, so
 * `client.session(id).tasks` self-assembles — the client twin of the server's
 * `bridges.tasks`. Client-core stays agnostic; this is the harness's contribution.
 */

import { registerSessionHandleExtension } from "@agentick/client-core-next";
import { tasksHandle, type TasksHandle } from "./tasks-handle.js";

declare module "@agentick/spec-next" {
  interface SessionHandleExtensions {
    /**
     * The tasks resource handle — the `ClientHandle` contract for this session:
     * `list()`/`get(taskId)` over the live task set (Enumerable — includes tasks
     * pending before you connected), the zero-arg `subscribe(cb)` store
     * contract, and `cancel(taskId, reason?)` over `tasks/cancel`
     * (`== tasksHandle(client, id)`).
     */
    readonly tasks: TasksHandle;
  }
}

registerSessionHandleExtension("tasks", (client, sessionId) => tasksHandle(client, sessionId));
