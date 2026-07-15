/**
 * `tasksHandle` — the client-side tasks resource handle (read + write).
 *
 * Read half: reuses the `pushStream` fake (mirrors `task-status-view.spec.ts`)
 * to seed a snapshot and fold deltas, proving `get`/`subscribe`/`onChange`
 * still work through the handle. Write half: `cancel(taskId, reason)` issues
 * `transport.request("tasks/cancel", ...)` with the wire-shaped params. And the
 * CQRS round-trip: after `cancel`, emitting a matching `cancelled` `task-status`
 * delta re-folds the view — the handle never hand-patches its own read state.
 *
 * Mirror of `knobs/src/client/__tests__/knobs-handle.spec.ts`.
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
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec-next";
import { channelEventName } from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";

import { tasksHandle } from "../tasks-handle.js";
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

/** Fake command client: real subscribe stream + a `request` recorder. */
function fakeCommandClient(
  stream: SubscriptionStream,
  captured: { method?: WireMethod; params?: unknown } = {},
) {
  return {
    transport: {
      subscribe(_scope: SubscriptionScope, _query?: EventQuery): SubscriptionStream {
        return stream;
      },
      async request<M extends WireMethod>(
        method: M,
        params: WireParams<M>,
      ): Promise<WireResult<M>> {
        captured.method = method;
        captured.params = params;
        // `tasks/cancel` resolves to `null`; typed against the precise
        // `WireResult<M>` (not the `unknown`-absorbing knobs shortcut).
        return null as unknown as WireResult<M>;
      },
    },
  };
}

function taskInfo(taskId: string, status: TaskStatus, over: Partial<TaskInfo> = {}): TaskInfo {
  return { taskId, status, createdAt: 0, lastUpdatedAt: 0, ttl: null, ...over };
}

describe("tasksHandle", () => {
  it("cancel() issues transport.request('tasks/cancel', { sessionId, taskId, reason })", async () => {
    const captured: { method?: WireMethod; params?: unknown } = {};
    const handle = tasksHandle(fakeCommandClient(pushStream(), captured), "s1");

    await handle.cancel("t7", "superseded");

    expect(captured.method).toBe("tasks/cancel");
    expect(captured.params).toEqual({ sessionId: "s1", taskId: "t7", reason: "superseded" });
  });

  it("cancel() omits reason from the params when not given", async () => {
    const captured: { method?: WireMethod; params?: unknown } = {};
    const handle = tasksHandle(fakeCommandClient(pushStream(), captured), "s1");

    await handle.cancel("t7");

    expect(captured.params).toEqual({ sessionId: "s1", taskId: "t7" });
    expect(captured.params).not.toHaveProperty("reason");
  });

  it("read half: snapshot seeds get(), then a cancel delta re-folds the view (CQRS round-trip)", async () => {
    const captured: { method?: WireMethod; params?: unknown } = {};
    const stream = pushStream();
    const handle = tasksHandle(fakeCommandClient(stream, captured), "s1");

    // Snapshot seeds the read half.
    stream.emit({ kind: "snapshot", tasks: [taskInfo("t7", "working")] });
    await waitFor(() => "t7" in handle.get());
    expect(handle.get().t7?.status).toBe("working");

    // Write command — no local hand-patch, so the view is still "working" here.
    await handle.cancel("t7");
    expect(handle.get().t7?.status).toBe("working");

    // The cancel's effect returns as a channel delta and re-folds the view.
    stream.emit(taskInfo("t7", "cancelled", { lastUpdatedAt: 5 }));
    await waitFor(() => handle.get().t7?.status === "cancelled");
    expect(handle.get().t7?.status).toBe("cancelled");
  });

  it("onChange() fires with each folded frame", async () => {
    const stream = pushStream();
    const handle = tasksHandle(fakeCommandClient(stream), "s1");

    const frames: TaskStatusFrame[] = [];
    handle.onChange((frame) => {
      frames.push(frame);
    });

    stream.emit(taskInfo("t7", "working"));
    await waitFor(() => frames.length > 0);
    expect(frames[0]).toEqual(taskInfo("t7", "working"));
  });
});
