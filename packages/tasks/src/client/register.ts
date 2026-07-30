/**
 * ADR 87 — contribute `session.tasks` to the client `SessionHandle`.
 *
 * Importing `@agentick/tasks/client` (which re-exports this) both TYPES the
 * slot (the `declare module` below) and REGISTERS the runtime factory, so
 * `client.session(id).tasks` self-assembles — the client twin of the server's
 * `bridges.tasks`. Client-core stays agnostic; this is the harness's contribution.
 */

import { registerSessionHandleExtension } from "@agentick/client-core";
import type { WireNamespaceMethods } from "@agentick/spec";
import { tasksHandle, type TasksHandle } from "./tasks-handle.js";

declare module "@agentick/spec" {
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

// The namespace's only wire row, which the handle already implements — so it
// stays SHADOWED by `tasks.cancel(taskId, reason)`. Declared anyway so a row
// added to `tasks/*` tomorrow is reachable through `session.tasks.<row>(…)` with
// no client change; the `satisfies` makes a removed row a compile error here.
registerSessionHandleExtension("tasks", (client, sessionId) => tasksHandle(client, sessionId), {
  wireMethods: ["cancel"] satisfies readonly (keyof WireNamespaceMethods<"tasks">)[],
});
