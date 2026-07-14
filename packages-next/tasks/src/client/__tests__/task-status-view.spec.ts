/**
 * `taskStatusView` client-side reduction against the REAL frame type: each
 * `task-status` frame is one task's current {@link TaskInfo}; the view folds them
 * into a map keyed by `taskId` (latest wins). Pins the fold + the channel query.
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
  TaskInfo,
  TaskStatus,
} from "@agentick/spec-next";
import { channelEventName } from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";

import { taskStatusView } from "../task-status-view.js";
import { TASK_STATUS_CHANNEL, type TaskStatusFrame } from "../../channel.js";

/** A push-driven subscription stream a test emits task-status frames onto. */
function pushStream(): SubscriptionStream & { emit(frame: TaskStatusFrame): void } {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let n = 0;
  return {
    subscriptionId: "sub-test",
    emit(frame: TaskStatusFrame): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name: channelEventName(TASK_STATUS_CHANNEL),
          phase: "delta",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload: frame,
        } as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: f, done: false });
      else buffer.push(f);
    },
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {},
  };
}

function fakeClient(stream: SubscriptionStream, captured: { query?: EventQuery } = {}) {
  return {
    transport: {
      subscribe(_scope: SubscriptionScope, query?: EventQuery): SubscriptionStream {
        captured.query = query;
        return stream;
      },
    },
  };
}

function taskInfo(taskId: string, status: TaskStatus, over: Partial<TaskInfo> = {}): TaskInfo {
  return { taskId, status, createdAt: 0, lastUpdatedAt: 0, ttl: null, ...over };
}

describe("taskStatusView", () => {
  it("folds TaskInfo frames into a map by taskId; latest status wins", async () => {
    const stream = pushStream();
    const view = taskStatusView(fakeClient(stream), "s1");

    stream.emit(taskInfo("t1", "working"));
    await waitFor(() => "t1" in view.get());
    expect(view.get().t1?.status).toBe("working");

    stream.emit(taskInfo("t2", "input_required"));
    await waitFor(() => "t2" in view.get());

    // Same taskId re-emits with a new status → the entry is replaced.
    stream.emit(taskInfo("t1", "completed", { lastUpdatedAt: 5 }));
    await waitFor(() => view.get().t1?.status === "completed");

    expect(view.get()).toEqual({
      t1: taskInfo("t1", "completed", { lastUpdatedAt: 5 }),
      t2: taskInfo("t2", "input_required"),
    });
  });

  it("seeds the whole store from the opening snapshot frame, then folds deltas on top", async () => {
    const stream = pushStream();
    const view = taskStatusView(fakeClient(stream), "s1");

    // Opening frame: the full current task set (K8s watch-list / ADR 87).
    stream.emit({
      kind: "snapshot",
      tasks: [taskInfo("t1", "working"), taskInfo("t2", "completed")],
    });
    await waitFor(() => Object.keys(view.get()).length === 2);
    expect(view.get().t1?.status).toBe("working");
    expect(view.get().t2?.status).toBe("completed");

    // A live delta after the snapshot folds onto the seeded store.
    stream.emit(taskInfo("t3", "input_required"));
    await waitFor(() => "t3" in view.get());
    expect(Object.keys(view.get())).toEqual(["t1", "t2", "t3"]);
  });

  it("subscribes to the task-status channel (façade builds the session scope + query)", () => {
    const captured: { query?: EventQuery } = {};
    taskStatusView(fakeClient(pushStream(), captured), "s1");
    expect(captured.query).toEqual({
      surface: "session",
      name: { exact: "session:channel:task-status" },
    });
  });
});
