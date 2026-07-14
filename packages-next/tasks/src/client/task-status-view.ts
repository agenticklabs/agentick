/**
 * `taskStatusView` — the client-side projection of the task-status channel.
 *
 * The far side of `session:channel:task-status`: a reactive view a frontend
 * subscribes to. Each frame is one task's current {@link TaskInfo} (published on
 * every FSM transition); the view folds them into a map keyed by `taskId`
 * (latest wins) so a UI renders a live task list.
 *
 * Mirrors {@link knobsStateView} — depends on `@agentick/client-next` (the
 * generic `channelView`), NOT on the tasks harness runtime, so it stays out of
 * the server bundle. The `/client` subpath convention (like `/react`): a harness
 * package may add a client surface over the generic client.
 *
 * NOTE: the task-status channel does not register an open-with-snapshot today, so
 * a subscriber sees tasks as they transition — not a backfill of the pre-existing
 * list. When the channel gains a snapshot, seed from it in a `kind: "snapshot"`
 * branch here (mirroring `knobsStateView`); the fold below is forward-compatible.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @see docs/proposals/v2/blueprint/85-ui-packages.md (the `useTasks` family)
 * @verifiedBy packages-next/tasks/src/client/__tests__/task-status-view.spec.ts
 */

import { channelView, type ChannelView } from "@agentick/client-next";
import type { ClientTransport, SubscriptionScope, TaskInfo } from "@agentick/spec-next";
import { TASK_STATUS_CHANNEL } from "../channel.js";

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
): ChannelView<TaskStatusMap> {
  const scope: SubscriptionScope = { kind: "session", id: sessionId };
  return channelView<TaskStatusMap, TaskInfo>(client, scope, TASK_STATUS_CHANNEL, {
    initial: {},
    // Each frame is one task's current TaskInfo; fold by taskId (latest wins).
    reduce: (state, info) => ({ ...state, [info.taskId]: info }),
  });
}
