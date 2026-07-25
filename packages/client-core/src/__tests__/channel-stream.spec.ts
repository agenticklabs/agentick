/**
 * `channelStream` — the ground-floor read primitive: yields a channel's frame
 * payloads (snapshot-first then deltas), via async-iterator OR `onChange`.
 * Materializes nothing. `channelView` folds over it (tested separately).
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
import { channelEventName } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { channelStream } from "../channel-stream.js";

function pushStream(
  channel: string,
): SubscriptionStream & { emit(p: unknown): void; isClosed: boolean } {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let closed = false;
  let n = 0;
  return {
    subscriptionId: "sub-test",
    get isClosed() {
      return closed;
    },
    emit(payload: unknown): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "session",
          name: channelEventName(channel),
          phase: "delta",
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
          if (closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
    },
  };
}

const scope: SubscriptionScope = { kind: "session", id: "s1" };
function fakeClient(stream: SubscriptionStream, captured: { query?: EventQuery } = {}) {
  return {
    transport: {
      subscribe(_s: SubscriptionScope, query?: EventQuery): SubscriptionStream {
        captured.query = query;
        return stream;
      },
    },
  };
}

describe("channelStream", () => {
  it("onChange delivers each frame PAYLOAD; subscribes to the channel query", async () => {
    const stream = pushStream("test");
    const captured: { query?: EventQuery } = {};
    const cs = channelStream<{ v: number }>(fakeClient(stream, captured), scope, "test");
    expect(captured.query).toEqual({ surface: "session", name: { exact: "session:channel:test" } });

    const seen: Array<{ v: number }> = [];
    const unsub = cs.onChange((frame) => seen.push(frame));
    stream.emit({ v: 1 });
    stream.emit({ v: 2 });
    await waitFor(() => seen.length === 2);
    expect(seen).toEqual([{ v: 1 }, { v: 2 }]);

    unsub();
  });

  it("is async-iterable (for-await) and skips undefined payloads", async () => {
    const stream = pushStream("test");
    const cs = channelStream<{ v: number }>(fakeClient(stream), scope, "test");
    const got: Array<{ v: number }> = [];
    const consume = (async () => {
      for await (const frame of cs) {
        got.push(frame);
        if (got.length === 2) break;
      }
    })();
    stream.emit(undefined); // skipped
    stream.emit({ v: 1 });
    stream.emit({ v: 2 });
    await consume;
    expect(got).toEqual([{ v: 1 }, { v: 2 }]);
  });

  it("close() tears down the underlying subscription", () => {
    const stream = pushStream("test");
    const cs = channelStream(fakeClient(stream), scope, "test");
    cs.close();
    expect(stream.isClosed).toBe(true);
  });
});
