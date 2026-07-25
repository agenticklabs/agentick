/**
 * `taskStatusView` — the client-side projection of the task-status channel.
 *
 * The far side of `session:channel:task-status`: a reactive view a frontend
 * subscribes to. Each frame is one task's current {@link TaskInfo} (published on
 * every FSM transition); the view folds them into a map keyed by `taskId`
 * (latest wins) so a UI renders a live task list.
 *
 * Mirrors {@link knobsStateView} — depends on `@agentick/client-core` (the
 * generic `channelView`), NOT on the tasks harness runtime, so it stays out of
 * the server bundle. The `/client` subpath convention (like `/react`): a harness
 * package may add a client surface over the generic client.
 *
 * The subscription OPENS with a `kind: "snapshot"` frame (the harness's
 * {@link ChannelSnapshotProvider}) carrying the full current task set — so a
 * late/reconnecting subscriber renders the existing list, not just tasks that
 * transition after it joined (the K8s watch-list model, ADR 87). Live deltas
 * that follow are bare {@link TaskInfo} (one task's current state); the fold
 * discriminates structurally on `kind`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @see docs/proposals/v2/blueprint/85-ui-packages.md (the `useTasks` family)
 * @verifiedBy packages/tasks/src/client/__tests__/task-status-view.spec.ts
 */

import { channelView, type ChannelView } from "@agentick/client-core";
import type { ClientTransport, SubscriptionScope, TaskInfo } from "@agentick/spec";
import { TASK_STATUS_CHANNEL, type TaskStatusFrame } from "../channel.js";

/** Minimal client surface the view needs — a read (`subscribe`) client. */
export interface TaskStatusClient {
  readonly transport: Pick<ClientTransport, "subscribe">;
}

/** The folded task-status view: tasks keyed by `taskId`, each the latest `TaskInfo`. */
export type TaskStatusMap = Readonly<Record<string, TaskInfo>>;

/**
 * Open a live view of the session's task statuses. `get()` returns the folded
 * map; `subscribe()` fires on each transition (the `useSyncExternalStore`
 * contract). `close()` tears down the subscription.
 */
export function taskStatusView(
  client: TaskStatusClient,
  sessionId: string,
): ChannelView<TaskStatusMap, TaskStatusFrame> {
  const scope: SubscriptionScope = { kind: "session", id: sessionId };
  return channelView<TaskStatusMap, TaskStatusFrame>(client, scope, TASK_STATUS_CHANNEL, {
    initial: {},
    reduce: (state, frame) => {
      // Opening frame: the full current task set — seed the whole store. Only
      // the snapshot arm carries `kind`; a live delta is a bare TaskInfo.
      if ("kind" in frame) {
        return Object.fromEntries(frame.tasks.map((t) => [t.taskId, t]));
      }
      // Live delta: one task's current TaskInfo; fold by taskId (latest wins).
      return { ...state, [frame.taskId]: frame };
    },
  });
}
