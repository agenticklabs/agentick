/**
 * `channelView` — the generic client-side reduced-channel primitive.
 *
 * Pins the fold contract: the subscription opens with a snapshot frame, then
 * streams deltas on the same ordered stream; `reduce` seeds on the snapshot and
 * folds the deltas; state is exposed via the useSyncExternalStore contract. No
 * baseline pull, no cursor — the snapshot is simply the first frame.
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
} from "@agentick/spec-next";
import { channelEventName } from "@agentick/spec-next";
import { waitFor } from "@agentick/utils-next/testing";

import { channelView } from "../channel-view.js";

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

/** A push-driven subscription stream a test can `emit` onto after open. */
interface PushStream extends SubscriptionStream {
  emit(payload: unknown): void;
  end(): void;
  readonly isClosed: boolean;
}

function pushStream(channel: string): PushStream {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let ended = false;
  let closed = false;
  let n = 0;

  const stream: PushStream = {
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
    end(): void {
      ended = true;
      let w: ((r: IteratorResult<EventFrame>) => void) | undefined;
      while ((w = waiters.shift())) w({ value: undefined as never, done: true });
    },
    [Symbol.asyncIterator](): AsyncIterator<EventFrame> {
      return {
        next(): Promise<IteratorResult<EventFrame>> {
          if (buffer.length) return Promise.resolve({ value: buffer.shift()!, done: false });
          if (ended || closed) return Promise.resolve({ value: undefined as never, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
    async close(): Promise<void> {
      closed = true;
      stream.end();
    },
  };
  return stream;
}

interface Captured {
  scope?: SubscriptionScope;
  query?: EventQuery;
}

function fakeClient(stream: SubscriptionStream, captured: Captured) {
  return {
    transport: {
      subscribe(scope: SubscriptionScope, query?: EventQuery): SubscriptionStream {
        captured.scope = scope;
        captured.query = query;
        return stream;
      },
    },
  };
}

type Doc = Record<string, number>;
// A realistic reducer that distinguishes the snapshot (seed) from deltas (fold).
type Frame = { kind: "snapshot"; values: Doc } | { kind: "delta"; set: Doc };
const reduce = (s: Doc, f: Frame): Doc =>
  f.kind === "snapshot" ? { ...f.values } : { ...s, ...f.set };

const scope: SubscriptionScope = { kind: "session", id: "s1" };

describe("channelView — fold over a channel subscription", () => {
  it("seeds from the opening snapshot frame, then folds deltas", async () => {
    const stream = pushStream("test");
    const captured: Captured = {};
    const view = channelView<Doc, Frame>(fakeClient(stream, captured), scope, "test", {
      initial: {},
      reduce,
    });

    // Subscribed to THIS channel; no separate baseline pull.
    expect(captured.scope).toEqual(scope);
    expect(captured.query).toEqual({ surface: "session", name: { exact: "session:channel:test" } });
    expect(view.get()).toEqual({}); // initial, before the first frame

    stream.emit({ kind: "snapshot", values: { a: 1 } }); // frame one = snapshot
    await waitFor(() => Object.keys(view.get()).length > 0);
    expect(view.get()).toEqual({ a: 1 });

    stream.emit({ kind: "delta", set: { b: 2 } }); // subsequent = delta
    await waitFor(() => "b" in view.get());
    expect(view.get()).toEqual({ a: 1, b: 2 });
  });

  it("subscribe() listeners fire on change and stop after Unsubscribe", async () => {
    const stream = pushStream("test");
    const view = channelView<Doc, Frame>(fakeClient(stream, {}), scope, "test", {
      initial: {},
      reduce,
    });

    let count = 0;
    const unsub = view.subscribe(() => count++);
    stream.emit({ kind: "snapshot", values: { a: 1 } });
    await waitFor(() => count === 1);

    unsub();
    stream.emit({ kind: "delta", set: { b: 2 } });
    await waitFor(() => "b" in view.get());
    expect(count).toBe(1); // no further notifications after Unsubscribe
    expect(view.get()).toEqual({ a: 1, b: 2 }); // state still folds; only the listener detached
  });

  it("close() stops folding and closes the underlying stream", async () => {
    const stream = pushStream("test");
    const view = channelView<Doc, Frame>(fakeClient(stream, {}), scope, "test", {
      initial: {},
      reduce,
    });

    stream.emit({ kind: "snapshot", values: { a: 1 } });
    await waitFor(() => view.get().a === 1);

    view.close();
    expect(view.closed).toBe(true);
    expect(stream.isClosed).toBe(true);

    stream.emit({ kind: "delta", set: { b: 2 } });
    await tick();
    expect(view.get()).toEqual({ a: 1 }); // no fold after close
  });

  it("isolates listener faults — a throwing listener can't starve the others", async () => {
    const stream = pushStream("test");
    const view = channelView<Doc, Frame>(fakeClient(stream, {}), scope, "test", {
      initial: {},
      reduce,
    });

    let good = 0;
    view.subscribe(() => {
      throw new Error("bad listener");
    });
    view.subscribe(() => good++);
    stream.emit({ kind: "snapshot", values: { a: 1 } });
    await waitFor(() => good === 1); // the second listener still ran
  });
});
