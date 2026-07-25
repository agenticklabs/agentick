/**
 * `eventView` — the generic fold over ANY session-event subscription (an
 * arbitrary `EventQuery` on a scope), the machine underneath both `channelView`
 * and the timeline fold. `channelView`'s own spec exercises the fold/fan-out
 * loop exhaustively (it IS `eventView` with a channel query); this spec pins the
 * two things `channelView` does NOT: an ARBITRARY query passes straight through
 * to `subscribe`, and `fromCursor` threads as the third `subscribe` arg.
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
} from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { eventView } from "../event-view.js";

function pushStream(): SubscriptionStream & { emit(payload: unknown): void } {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let n = 0;
  return {
    subscriptionId: "sub-test",
    emit(payload: unknown): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "timeline",
          name: "any:command:x",
          phase: "requested",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload,
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

interface Captured {
  scope?: SubscriptionScope;
  query?: EventQuery;
  fromCursor?: Cursor;
}

function fakeClient(stream: SubscriptionStream, captured: Captured = {}) {
  return {
    transport: {
      subscribe(
        scope: SubscriptionScope,
        query?: EventQuery,
        fromCursor?: Cursor,
      ): SubscriptionStream {
        captured.scope = scope;
        captured.query = query;
        captured.fromCursor = fromCursor;
        return stream;
      },
    },
  };
}

const scope: SubscriptionScope = { kind: "session", id: "s1" };

describe("eventView — fold over an arbitrary event query", () => {
  it("passes the arbitrary query + scope + fromCursor straight to subscribe", () => {
    const captured: Captured = {};
    const query: EventQuery = { surface: "timeline", phase: "requested" };
    const cursor = { value: 7 } as Cursor;
    eventView<number, { n: number }>(fakeClient(pushStream(), captured), scope, query, {
      initial: 0,
      fromCursor: cursor,
      reduce: (s, f) => s + f.n,
    });
    expect(captured.scope).toEqual(scope);
    expect(captured.query).toEqual(query);
    expect(captured.fromCursor).toBe(cursor);
  });

  it("folds frame payloads onto the accumulator seeded by `initial`", async () => {
    const stream = pushStream();
    const view = eventView<number, { n: number }>(
      fakeClient(stream),
      scope,
      { surface: "timeline" },
      { initial: 10, reduce: (s, f) => s + f.n },
    );
    expect(view.get()).toBe(10); // initial, before any frame

    stream.emit({ n: 5 });
    await waitFor(() => view.get() === 15);

    stream.emit({ n: 2 });
    await waitFor(() => view.get() === 17);
  });

  it("omits fromCursor when not provided (tail from now)", () => {
    const captured: Captured = {};
    eventView<number, { n: number }>(
      fakeClient(pushStream(), captured),
      scope,
      { surface: "timeline" },
      { initial: 0, reduce: (s, f) => s + f.n },
    );
    expect(captured.fromCursor).toBeUndefined();
  });
});
