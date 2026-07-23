/**
 * `tasksHandle` — the client-side tasks resource handle, on the unified
 * `ClientHandle` contract (B2 slice 3, `docs/proposals/v2/client-handles.md`).
 *
 * Nouns + verbs over one session's tasks:
 *   - CORE — `subscribe(cb)` (the zero-arg store contract) + `close()`.
 *   - {@link Enumerable} — `list()` returns the current {@link TaskInfo}s
 *     (reflecting the opening `task-status` snapshot, so a client that connects
 *     mid-run sees the existing tasks — the live-only fix), `get(taskId)` looks
 *     one up by id.
 *   - WRITE — `cancel(taskId, reason?)` over `tasks/cancel`.
 *
 * Read is a keyed latest-wins fold over the `task-status` channel: the opening
 * snapshot seeds the whole set; each live delta is one task's current
 * {@link TaskInfo}. `list()` materializes the current set on every folded frame,
 * so its reference is stable between changes (the `useSyncExternalStore`
 * contract). Per north-star Q3 (RESOLVED), tasks completes as core + Enumerable
 * + `cancel` — no Streamable profile (a handle is nouns+verbs, not a stream you
 * drink from).
 *
 * `cancel` is fire-and-observe: it issues `tasks/cancel` and resolves once the
 * gateway accepts it; the cancellation lands on the view as a `cancelled`
 * `task-status` delta (CQRS — no local hand-patch, state flows through the
 * channel only). `subscribe(cb)` wraps the internal fold's state feed and
 * invokes `cb` with NO arguments (the frame-tap survives only inside the fold).
 *
 * @verifiedBy packages-next/tasks/src/client/__tests__/tasks-handle.spec.ts
 * @verifiedBy packages-next/tasks/src/client/__tests__/tasks-handle.conformance.spec.ts
 */

import { channelView, type ClientHandle, type Enumerable } from "@agentick/client-core-next";
import type {
  ClientTransport,
  SubscriptionScope,
  TaskInfo,
  Unsubscribe,
} from "@agentick/spec-next";

import { TASK_STATUS_CHANNEL, type TaskStatusFrame } from "../channel.js";

/** Command client: the read (`subscribe`) surface PLUS `request` for the write. */
export interface TasksCommandClient {
  readonly transport: Pick<ClientTransport, "subscribe" | "request">;
}

/**
 * The tasks resource handle: the {@link Enumerable} task view (`list` / `get`) +
 * the store-contract `subscribe` + the `cancel` write command. A plain
 * structural shape (floors, not ceilings) — it MAY carry more.
 */
export interface TasksHandle extends ClientHandle, Enumerable<TaskInfo> {
  /** The current tasks as a bounded snapshot — includes pre-connection tasks. */
  list(): readonly TaskInfo[];
  /** Look one task up by `taskId`; `undefined` when absent. */
  get(taskId: string): TaskInfo | undefined;
  /**
   * Cancel a running task. Issues `tasks/cancel` and resolves once the gateway
   * accepts it; the `cancelled` transition returns on the view as a
   * `task-status` delta (CQRS — no local hand-patch).
   */
  cancel(taskId: string, reason?: string): Promise<void>;
  /** Tear down the underlying `task-status` subscription. */
  close(): void;
}

/** Materialized fold state: the current tasks keyed by id, plus the derived
 * `list()`/`get()` snapshot (ref-stable per frame). */
interface TasksFold {
  readonly byId: ReadonlyMap<string, TaskInfo>;
  readonly list: readonly TaskInfo[];
}

function materialize(byId: ReadonlyMap<string, TaskInfo>): TasksFold {
  return { byId, list: [...byId.values()] };
}

const EMPTY: TasksFold = materialize(new Map());

/**
 * A live read+write handle over `session`'s tasks. The read half opens with the
 * current task snapshot and folds `task-status` deltas; the write half issues
 * `tasks/cancel`.
 */
export function tasksHandle(client: TasksCommandClient, sessionId: string): TasksHandle {
  const scope: SubscriptionScope = { kind: "session", id: sessionId };
  const view = channelView<TasksFold, TaskStatusFrame>(client, scope, TASK_STATUS_CHANNEL, {
    initial: EMPTY,
    reduce: (state, frame) => {
      // Opening frame: the full current task set — seed the whole store. Only
      // the snapshot arm carries `kind`; a live delta is a bare TaskInfo.
      if ("kind" in frame) {
        return materialize(new Map(frame.tasks.map((t) => [t.taskId, t])));
      }
      // Live delta: one task's current TaskInfo; fold by taskId (latest wins).
      const byId = new Map(state.byId);
      byId.set(frame.taskId, frame);
      return materialize(byId);
    },
  });

  return {
    list: () => view.get().list,
    get: (taskId) => view.get().byId.get(taskId),
    // The store contract: fire on change, hand the callback NO arguments — the
    // caller re-reads via list()/get(). The fold's state value is dropped here.
    subscribe: (cb: () => void): Unsubscribe => view.subscribe(() => cb()),
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
