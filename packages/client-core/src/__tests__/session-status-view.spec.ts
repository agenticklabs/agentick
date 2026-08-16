/**
 * `session.status` — the client half of the session-status projection.
 *
 * The consumer is a chat panel that RELOADED mid-turn: it holds a fresh handle
 * and no memory of the conversation's state. It must learn "still running" from
 * the handle itself, and it must not be able to miss the transition that
 * happens between learning and listening — which is why the seed is frame one
 * of the same subscription rather than a separate read.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProtocolEvent,
  SessionStatusFrame,
  SubscriptionScope,
  SubscriptionStream,
} from "@agentick/spec";
import { channelEventName } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { makeSessionHandle } from "../handles.js";
import { sessionStatusView } from "../session-status-view.js";

type InternalClientArg = Parameters<typeof makeSessionHandle>[0];

interface PushStream extends SubscriptionStream {
  emit(frame: SessionStatusFrame): void;
  readonly isClosed: boolean;
}

function pushStream(): PushStream {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let closed = false;
  let n = 0;

  const stream: PushStream = {
    subscriptionId: "sub-status",
    get isClosed() {
      return closed;
    },
    emit(payload: SessionStatusFrame): void {
      const frame: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name: channelEventName("status"),
          phase: "delta",
          timestamp: 0,
          scope: { sessionId: payload.sessionId },
          payload,
        } as ProtocolEvent,
      };
      const w = waiters.shift();
      if (w) w({ value: frame, done: false });
      else buffer.push(frame);
    },
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
      let w: ((r: IteratorResult<EventFrame>) => void) | undefined;
      while ((w = waiters.shift())) w({ value: undefined as never, done: true });
    },
  };
  return stream;
}

function fakeClient(stream: SubscriptionStream) {
  const opened: { scope?: SubscriptionScope; query?: EventQuery; count: number } = { count: 0 };
  const request = vi.fn(async () => null);
  const client = {
    id: "c1",
    request,
    transport: {
      subscribe(scope: SubscriptionScope, query?: EventQuery): SubscriptionStream {
        opened.scope = scope;
        opened.query = query;
        opened.count++;
        return stream;
      },
    },
  } as unknown as InternalClientArg;
  return { client, request, opened };
}

describe("sessionStatusView — the fold", () => {
  it("holds the status, and hands the whole frame to the change feed", async () => {
    const stream = pushStream();
    const { client, opened } = fakeClient(stream);
    const view = sessionStatusView(client as never, "s1");

    expect(opened.scope).toEqual({ kind: "session", id: "s1" });
    expect(opened.query).toEqual({ surface: "session", name: { exact: "session:channel:status" } });
    // Honest about not knowing yet, rather than guessing "idle".
    expect(view.get()).toBeUndefined();
    expect(view.status).toBe("loading");

    const frames: SessionStatusFrame[] = [];
    view.onChange((f) => frames.push(f));

    // Frame one is the server's snapshot — the seed a reloaded panel renders.
    stream.emit({ sessionId: "s1", status: "running", executionId: "exec:1" });
    await waitFor(() => view.get() !== undefined);
    expect(view.get()).toBe("running");
    expect(view.status).toBe("live");
    // The execution id a reattaching client correlates on rides the frame, not
    // the folded state — a badge wants the word, a correlator wants the id.
    expect(frames[0]).toEqual({ sessionId: "s1", status: "running", executionId: "exec:1" });

    // The ending rides the frame, not the state: the session is idle and
    // perfectly usable, and the run that just failed is still reportable.
    stream.emit({ sessionId: "s1", status: "idle", outcome: "failed" });
    await waitFor(() => view.get() === "idle");
    expect(frames[1]!.outcome).toBe("failed");
  });
});

describe("session.status on the handle", () => {
  it("opens nothing until read, memoizes, and is closed by session.close()", async () => {
    const stream = pushStream();
    const { client, opened } = fakeClient(stream);
    const session = makeSessionHandle(client, "s1");

    // `app.session(id)` is cheap addressing — it must not open a subscription.
    expect(opened.count).toBe(0);

    const view = session.status;
    expect(opened.count).toBe(1);
    expect(session.status).toBe(view); // one subscription per handle, not per read

    stream.emit({ sessionId: "s1", status: "running", executionId: "exec:1" });
    await waitFor(() => session.status.get() === "running");

    await session.close();
    expect(stream.isClosed).toBe(true);
  });

  it("close() does not open the subscription it is about to abandon", async () => {
    const stream = pushStream();
    const { client, opened } = fakeClient(stream);
    const session = makeSessionHandle(client, "s1");

    await session.close();
    expect(opened.count).toBe(0);
  });
});
