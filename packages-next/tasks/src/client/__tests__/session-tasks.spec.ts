/**
 * ADR 87 integration — importing `@agentick/tasks-next/client` makes
 * `client.session(id).tasks` self-assemble on the generic client's
 * `SessionHandle`, with NO wiring in client-core. The slot is a live
 * `taskStatusView` (folds `task-status` frames by taskId), built lazily and
 * cached. Proves the full path: register → makeSessionHandle → getter → view.
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
import { makeSessionHandle } from "@agentick/client-next";
import { waitFor } from "@agentick/utils-next/testing";

import { TASK_STATUS_CHANNEL } from "../../channel.js";
// Side-effect: registers the `tasks` sub-handle + types the slot.
import "../register.js";

/** A push-driven subscription stream a test emits task-status frames onto. */
function pushStream(): SubscriptionStream & { emit(info: TaskInfo): void } {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let n = 0;
  return {
    subscriptionId: "sub-test",
    emit(info: TaskInfo): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name: channelEventName(TASK_STATUS_CHANNEL),
          phase: "delta",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload: info,
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

/** Minimal InternalClient: id + a request stub + a real subscribe stream. */
function fakeInternalClient(stream: SubscriptionStream) {
  return {
    id: "c1",
    request: (async () => {
      throw new Error("request not used in this test");
    }) as never,
    transport: {
      subscribe(_scope: SubscriptionScope, _query?: EventQuery): SubscriptionStream {
        return stream;
      },
    } as never,
  };
}

function taskInfo(taskId: string, status: TaskStatus): TaskInfo {
  return { taskId, status, createdAt: 0, lastUpdatedAt: 0, ttl: null };
}

describe("session.tasks (ADR 87 registrant)", () => {
  it("self-assembles on the SessionHandle and folds task-status frames", async () => {
    const stream = pushStream();
    const session = makeSessionHandle(fakeInternalClient(stream), "s1");

    // The slot appears with NO client-core wiring — just importing the client
    // subpath registered it. Non-optional: `session.tasks`, not `session.tasks?`.
    expect(session.tasks).toBeDefined();
    expect(session.tasks.get()).toEqual({});

    stream.emit(taskInfo("t1", "working"));
    await waitFor(() => "t1" in session.tasks.get());
    expect(session.tasks.get().t1?.status).toBe("working");
  });

  it("is a stable, cached identity across accesses (lazy getter builds once)", () => {
    const session = makeSessionHandle(fakeInternalClient(pushStream()), "s1");
    expect(session.tasks).toBe(session.tasks);
  });
});
