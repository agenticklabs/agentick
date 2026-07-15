/**
 * `tasksHandle` — the client-side tasks resource handle (read + write).
 *
 * The CQRS shape shared by every sub-handle: the READ surface
 * ({@link taskStatusView} — the live `task-status` `ChannelView`) PLUS the
 * domain WRITE command `cancel(taskId)`. Mirror of `knobsHandle`
 * (`ChannelView & { set }`).
 *
 * `cancel` is fire-and-observe: it issues `tasks/cancel` and resolves once the
 * gateway accepts it; the cancellation lands on the view as a `cancelled`
 * `task-status` delta (CQRS — no local hand-patch, state flows through the
 * channel only).
 *
 * @verifiedBy packages-next/tasks/src/client/__tests__/tasks-handle.spec.ts
 */

import type { ChannelView, ClientTransport } from "@agentick/spec-next";

import { taskStatusView, type TaskStatusMap } from "./task-status-view.js";
import type { TaskStatusFrame } from "../channel.js";

/** Command client: the read (`subscribe`) surface PLUS `request` for the write. */
export interface TasksCommandClient {
  readonly transport: Pick<ClientTransport, "subscribe" | "request">;
}

/** The tasks resource handle: the read view plus the `cancel` command. */
export type TasksHandleView = ChannelView<TaskStatusMap, TaskStatusFrame> & {
  /**
   * Cancel a running task. Issues `tasks/cancel` and resolves once the gateway
   * accepts it; the `cancelled` transition returns on the view as a
   * `task-status` delta (CQRS — no local hand-patch).
   */
  cancel(taskId: string, reason?: string): Promise<void>;
};

/**
 * A live read+write handle over `session`'s tasks. Read half opens with the
 * current task snapshot and folds `task-status` deltas; write half issues
 * `tasks/cancel`.
 */
export function tasksHandle(client: TasksCommandClient, sessionId: string): TasksHandleView {
  const view = taskStatusView(client, sessionId);
  return {
    get: () => view.get(),
    subscribe: (listener) => view.subscribe(listener),
    onChange: (listener) => view.onChange(listener),
    get status() {
      return view.status;
    },
    close: () => view.close(),
    cancel: async (taskId, reason) => {
      await client.transport.request("tasks/cancel", {
        sessionId,
        taskId,
        ...(reason !== undefined ? { reason } : {}),
      });
    },
  };
}
