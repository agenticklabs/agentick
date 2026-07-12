/**
 * `channelView` — the generic client-side reduced-channel primitive.
 *
 * Pins the composition contract: PULL a baseline (whose cursor the stream
 * resumes from), then PUSH-fold deltas onto it, exposing the reduced state
 * via the useSyncExternalStore contract. No version bookkeeping — the
 * transport cursor ties snapshot→stream.
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

import { channelView, type ChannelBaseline } from "../channel-view.js";

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
  fromCursor?: Cursor;
}

function fakeClient(stream: SubscriptionStream, captured: Captured) {
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

type Doc = Record<string, number>;
const scope: SubscriptionScope = { kind: "session", id: "s1" };
const mergeReduce = (s: Doc, f: Doc): Doc => ({ ...s, ...f });

describe("channelView — pull baseline, push-fold deltas", () => {
  it("seeds from the baseline, subscribes from its cursor, then folds deltas", async () => {
    const stream = pushStream("test");
    const captured: Captured = {};
    const view = channelView<Doc, Doc>(fakeClient(stream, captured), scope, "test", {
      initial: {},
      baseline: async () => ({ state: { a: 1 }, cursor: { value: 7 } as Cursor }),
      reduce: mergeReduce,
    });

    expect(view.get()).toEqual({}); // initial, before baseline resolves
    await waitFor(() => Object.keys(view.get()).length > 0);
    expect(view.get()).toEqual({ a: 1 }); // baseline seeded

    // Composition contract: subscribed to THIS channel, resuming from the
    // baseline's cursor (versionless snapshot→stream tie).
    expect(captured.scope).toEqual(scope);
    expect(captured.query).toEqual({ surface: "session", name: { exact: "session:channel:test" } });
    expect(captured.fromCursor).toEqual({ value: 7 });

    let notified = 0;
    view.subscribe(() => notified++);
    stream.emit({ b: 2 });
    await waitFor(() => notified > 0);
    expect(view.get()).toEqual({ a: 1, b: 2 }); // delta folded onto the baseline
  });

  it("PULLS before it PUSHES — no subscription opens until the baseline resolves", async () => {
    const stream = pushStream("test");
    const captured: Captured = {};
    let resolveBaseline!: (b: ChannelBaseline<Doc>) => void;
    const view = channelView<Doc, Doc>(fakeClient(stream, captured), scope, "test", {
      initial: { n: 0 },
      baseline: () => new Promise<ChannelBaseline<Doc>>((r) => (resolveBaseline = r)),
      reduce: mergeReduce,
    });

    await tick();
    expect(view.get()).toEqual({ n: 0 }); // still initial
    expect(captured.scope).toBeUndefined(); // NOT subscribed yet — pull is first

    resolveBaseline({ state: { n: 5 } });
    await waitFor(() => view.get().n === 5);
    expect(captured.scope).toEqual(scope); // subscribed only after the baseline
  });

  it("subscribe() listeners fire on change and stop after Unsubscribe", async () => {
    const stream = pushStream("test");
    const view = channelView<Doc, Doc>(fakeClient(stream, {}), scope, "test", {
      initial: {},
      baseline: async () => ({ state: {} }),
      reduce: mergeReduce,
    });
    await tick();

    let count = 0;
    const unsub = view.subscribe(() => count++);
    stream.emit({ a: 1 });
    await waitFor(() => count === 1);

    unsub();
    stream.emit({ b: 2 });
    await tick();
    expect(count).toBe(1); // no further notifications after Unsubscribe
    expect(view.get()).toEqual({ a: 1, b: 2 }); // state still folds; only the listener detached
  });

  it("close() stops folding and closes the underlying stream", async () => {
    const stream = pushStream("test");
    const view = channelView<Doc, Doc>(fakeClient(stream, {}), scope, "test", {
      initial: {},
      baseline: async () => ({ state: { a: 1 } }),
      reduce: mergeReduce,
    });
    await waitFor(() => view.get().a === 1);

    view.close();
    expect(view.closed).toBe(true);
    expect(stream.isClosed).toBe(true);

    stream.emit({ b: 2 });
    await tick();
    expect(view.get()).toEqual({ a: 1 }); // no fold after close
  });

  it("isolates listener faults — a throwing listener can't starve the others", async () => {
    const stream = pushStream("test");
    const view = channelView<Doc, Doc>(fakeClient(stream, {}), scope, "test", {
      initial: {},
      baseline: async () => ({ state: {} }),
      reduce: mergeReduce,
    });
    await tick();

    let good = 0;
    view.subscribe(() => {
      throw new Error("bad listener");
    });
    view.subscribe(() => good++);
    stream.emit({ a: 1 });
    await waitFor(() => good === 1); // the second listener still ran
  });

  it("omitting the baseline cursor subscribes from the head (undefined fromCursor)", async () => {
    const stream = pushStream("test");
    const captured: Captured = {};
    const view = channelView<Doc, Doc>(fakeClient(stream, captured), scope, "test", {
      initial: {},
      baseline: async () => ({ state: { a: 1 } }), // no cursor
      reduce: mergeReduce,
    });
    await waitFor(() => view.get().a === 1);
    expect(captured.fromCursor).toBeUndefined();
  });
});
