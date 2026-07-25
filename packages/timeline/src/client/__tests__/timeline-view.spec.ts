/**
 * `timelineView` — the timeline client façade over `eventView`.
 *
 * Pins the timeline fold against the REAL append-envelope shape: a
 * `timeline:command:append` requested-phase envelope carries
 * `{ entries }` (the {@link TimelineAppendInput}) on `envelope.payload`. The
 * adopter sees a live `readonly TimelineEntry[]` and never touches the query,
 * phases, or envelopes. Verifies `initial` seeding, `fromCursor` threading (no
 * double-count), visibility filtering, and copy-on-write refs.
 */

import { describe, expect, it } from "vitest";
import type {
  Cursor,
  EventFrame,
  EventQuery,
  ProtocolEvent,
  SubscriptionScope,
  SubscriptionStream,
  TimelineAppendInput,
  TimelineEntry,
} from "@agentick/spec";
import { TIMELINE_APPEND_EVENT_NAME } from "@agentick/spec";
import { waitFor } from "@agentick/utils/testing";

import { timelineView } from "../timeline-view.js";

function entry(id: string, text: string, visibility?: TimelineEntry["visibility"]): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text }], ts: 0 },
    ...(visibility ? { visibility } : {}),
  };
}

/** A push-driven subscription stream a test emits append envelopes onto. */
function pushStream(): SubscriptionStream & { emit(input: TimelineAppendInput): void } {
  const buffer: EventFrame[] = [];
  const waiters: Array<(r: IteratorResult<EventFrame>) => void> = [];
  let n = 0;
  return {
    subscriptionId: "sub-test",
    emit(input: TimelineAppendInput): void {
      const f: EventFrame = {
        cursor: { value: ++n } as Cursor,
        envelope: {
          id: `e${n}`,
          surface: "timeline",
          name: TIMELINE_APPEND_EVENT_NAME,
          phase: "requested",
          timestamp: 0,
          scope: { sessionId: "s1" },
          payload: input,
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

describe("timelineView", () => {
  it("subscribes with the session scope + the timeline append query", () => {
    const captured: Captured = {};
    timelineView(fakeClient(pushStream(), captured), "s1");
    expect(captured.scope).toEqual({ kind: "session", id: "s1" });
    expect(captured.query).toEqual({
      surface: "timeline",
      name: { exact: "timeline:command:append" },
      phase: "requested",
    });
  });

  it("seeds from `initial`, then folds append envelopes onto the growing array", async () => {
    const stream = pushStream();
    const view = timelineView(fakeClient(stream), "s1", { initial: [entry("seed", "hi")] });

    // The seed is visible synchronously, before any live frame.
    expect(view.get().map((e) => (e as any).message.id)).toEqual(["seed"]);

    stream.emit({ entries: [entry("a", "one")] });
    await waitFor(() => view.get().length === 2);
    expect(view.get().map((e) => (e as any).message.id)).toEqual(["seed", "a"]);

    stream.emit({ entries: [entry("b", "two"), entry("c", "three")] });
    await waitFor(() => view.get().length === 4);
    expect(view.get().map((e) => (e as any).message.id)).toEqual(["seed", "a", "b", "c"]);
  });

  it("threads `fromCursor` into subscribe so the tail resumes after the seed (no double-count)", () => {
    const captured: Captured = {};
    const cursor = { value: 42 } as Cursor;
    timelineView(fakeClient(pushStream(), captured), "s1", {
      initial: [entry("seed", "hi")],
      fromCursor: cursor,
    });
    expect(captured.fromCursor).toBe(cursor);
  });

  it("visibility filter drops filtered entries", async () => {
    const stream = pushStream();
    const view = timelineView(fakeClient(stream), "s1", {
      visibility: (e) => e.visibility !== "log",
    });

    stream.emit({
      entries: [entry("keep", "v", "model"), entry("drop", "x", "log"), entry("keep2", "w")],
    });
    await waitFor(() => view.get().length === 2);
    expect(view.get().map((e) => (e as any).message.id)).toEqual(["keep", "keep2"]);

    // An all-filtered batch keeps the SAME array reference (copy-on-write only
    // when the fold grows).
    const before = view.get();
    stream.emit({ entries: [entry("dropped", "y", "log")] });
    await new Promise((r) => setTimeout(r, 10));
    expect(view.get()).toBe(before);
  });

  it("copy-on-write — each growing fold yields a NEW array reference", async () => {
    const stream = pushStream();
    const view = timelineView(fakeClient(stream), "s1");

    const refs: ReadonlyArray<readonly TimelineEntry[]> = [];
    (refs as Array<readonly TimelineEntry[]>).push(view.get());

    stream.emit({ entries: [entry("a", "one")] });
    await waitFor(() => view.get().length === 1);
    const r1 = view.get();

    stream.emit({ entries: [entry("b", "two")] });
    await waitFor(() => view.get().length === 2);
    const r2 = view.get();

    expect(r1).not.toBe(refs[0]);
    expect(r2).not.toBe(r1);
  });

  it("prepend splices OLDER entries at the HEAD and notifies the STATE feed", async () => {
    const view = timelineView(fakeClient(pushStream()), "s1", { initial: [entry("live", "now")] });

    let notified = 0;
    view.subscribe(() => notified++);

    const before = view.get();
    view.prepend([entry("old1", "a"), entry("old2", "b")]);

    expect(view.get().map((e) => (e as any).message.id)).toEqual(["old1", "old2", "live"]);
    expect(view.get()).not.toBe(before); // copy-on-write
    expect(notified).toBe(1);
  });

  it("append splices entries at the TAIL (optimistic overlay) and notifies", () => {
    const view = timelineView(fakeClient(pushStream()), "s1", { initial: [entry("live", "now")] });

    let notified = 0;
    view.subscribe(() => notified++);

    view.append([entry("pending", "optimistic")]);

    expect(view.get().map((e) => (e as any).message.id)).toEqual(["live", "pending"]);
    expect(notified).toBe(1);
  });

  it("the live fold still tails + interleaves AFTER a prior prepend/append", async () => {
    const stream = pushStream();
    const view = timelineView(fakeClient(stream), "s1", { initial: [entry("seed", "s")] });

    view.prepend([entry("old", "o")]); // HEAD
    view.append([entry("pending", "p")]); // TAIL (optimistic)
    expect(view.get().map((e) => (e as any).message.id)).toEqual(["old", "seed", "pending"]);

    // A real server append still folds onto the TAIL, after the optimistic one.
    stream.emit({ entries: [entry("server", "x")] });
    await waitFor(() => view.get().length === 4);
    expect(view.get().map((e) => (e as any).message.id)).toEqual([
      "old",
      "seed",
      "pending",
      "server",
    ]);
  });

  it("empty / all-filtered prepend + append are no-ops (same ref, no notify)", () => {
    const view = timelineView(fakeClient(pushStream()), "s1", {
      initial: [entry("seed", "s")],
      visibility: (e) => e.visibility !== "log",
    });

    let notified = 0;
    view.subscribe(() => notified++);
    const before = view.get();

    view.prepend([]); // empty
    view.append([]); // empty
    view.prepend([entry("hidden", "h", "log")]); // all-filtered
    view.append([entry("hidden2", "h", "log")]); // all-filtered

    expect(view.get()).toBe(before); // same reference throughout
    expect(notified).toBe(0); // no spurious re-render
  });

  it("get + subscribe satisfy the useSyncExternalStore contract", () => {
    const view = timelineView(fakeClient(pushStream()), "s1", { initial: [entry("seed", "s")] });

    // React passes a `() => void`; subscribe returns an unsubscribe; get is the
    // synchronous snapshot. This is the exact shape useSyncExternalStore drives.
    const snapshot: () => readonly TimelineEntry[] = view.get;
    const subscribe: (onStoreChange: () => void) => () => void = view.subscribe;

    let rerenders = 0;
    const unsub = subscribe(() => rerenders++);
    view.append([entry("x", "x")]);
    expect(rerenders).toBe(1);
    expect(snapshot().length).toBe(2);
    unsub();
    view.append([entry("y", "y")]);
    expect(rerenders).toBe(1); // no delivery after unsubscribe
  });
});
