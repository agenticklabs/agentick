/**
 * `timelineHandle` — the window verbs (`seed`/`clear`), the `history()` page read
 * over the grant-gated `timeline/history` command, and the `loadOlder` scroll-back
 * sugar built on it, on top of the re-homed `timelineView` window. Focused unit
 * coverage complementing the conformance suite.
 */

import { describe, expect, it } from "vitest";
import type {
  EventQuery,
  SubscriptionScope,
  SubscriptionStream,
  TimelineEntry,
  WireMethod,
  WireParams,
} from "@agentick/spec";
import { spyClientTransport } from "@agentick/client-core/testing";

import type { TimelineHistoryPage } from "../../wire-augment.js";
import { timelineHandle } from "../timeline-handle.js";

const entry = (id: string): TimelineEntry => ({
  kind: "message",
  message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
});

const ids = (window: readonly TimelineEntry[]): string[] =>
  window.map((e) => (e.kind === "message" ? e.message.id : "boundary"));

/** A subscription stream that never yields (the window subscribes eagerly). */
function neverStream(): SubscriptionStream {
  return {
    subscriptionId: "sub-test",
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    async close(): Promise<void> {},
  };
}

/** Client with a canned `timeline/history` response + a request recorder. */
function fakeClient(
  page: TimelineHistoryPage | null,
  captured: { params?: unknown[]; methods?: string[] } = { params: [], methods: [] },
) {
  return {
    transport: {
      subscribe: (_s: SubscriptionScope, _q?: EventQuery): SubscriptionStream => neverStream(),
      async request<M extends WireMethod>(method: M, params: WireParams<M>): Promise<unknown> {
        captured.methods?.push(method);
        captured.params!.push(params);
        return page;
      },
    },
  };
}

describe("timelineHandle", () => {
  it("seed() replaces the window; clear() empties it", () => {
    const spy = spyClientTransport();
    const handle = timelineHandle(spy, "s1", { initial: [entry("old")] });

    handle.seed([entry("a"), entry("b")]);
    expect(ids(handle.list())).toEqual(["a", "b"]);

    handle.clear();
    expect(handle.list()).toEqual([]);
    spy.endStream();
  });

  it("get(id) finds a message entry by message.id", () => {
    const spy = spyClientTransport();
    const handle = timelineHandle(spy, "s1", { initial: [entry("a"), entry("b")] });
    expect(handle.get("b")).toMatchObject({ message: { id: "b" } });
    expect(handle.get("nope")).toBeUndefined();
    spy.endStream();
  });

  it("history() reads one seq-tagged page over timeline/history and mutates NO view", async () => {
    const captured: { params?: unknown[]; methods?: string[] } = { params: [], methods: [] };
    const handle = timelineHandle(
      fakeClient({ entries: [{ seq: 7, entry: entry("older") }], nextFromSeq: 8 }, captured),
      "s1",
      { initial: [entry("live")] },
    );

    const page = await handle.history({ fromSeq: 4, limit: 25 });
    // The rows keep their `seq` — the cursor identity the caller pages by — and
    // the reply carries its own next action.
    expect(page.entries.map((t) => t.seq)).toEqual([7]);
    expect(page.nextFromSeq).toBe(8);
    // The granted COMMAND, not a bespoke gateway method.
    expect(captured.methods).toEqual(["timeline/history"]);
    expect(captured.params![0]).toEqual({ sessionId: "s1", fromSeq: 4, limit: 25 });
    // Stateless + view-neutral: Posture B pages into its own store.
    expect(ids(handle.list())).toEqual(["live"]);
  });

  it("history() passes an upper bound through — the backward page", async () => {
    const captured: { params?: unknown[]; methods?: string[] } = { params: [], methods: [] };
    const handle = timelineHandle(
      fakeClient({ entries: [{ seq: 6, entry: entry("older") }], nextToSeq: 5 }, captured),
      "s1",
    );
    const page = await handle.history({ toSeq: 6, limit: 1 });
    expect(page.nextToSeq).toBe(5);
    expect(captured.params![0]).toEqual({ sessionId: "s1", toSeq: 6, limit: 1 });
  });

  it("loadOlder() opens on the TAIL — no lower bound, page prepended at the HEAD", async () => {
    const captured: { params?: unknown[]; methods?: string[] } = { params: [], methods: [] };
    const handle = timelineHandle(
      fakeClient({ entries: [{ seq: 9, entry: entry("newest") }], nextToSeq: 8 }, captured),
      "s1",
      { initial: [entry("live")] },
    );

    const first = await handle.loadOlder(10);
    expect(first.done).toBe(false);
    expect(ids(first.entries)).toEqual(["newest"]);
    // Prepended at the HEAD, before the live window.
    expect(ids(handle.list())).toEqual(["newest", "live"]);
    // The tail-anchored read: a `limit` and NO `fromSeq` (the anchor rule).
    expect(captured.methods).toEqual(["timeline/history"]);
    expect(captured.params![0]).toEqual({ sessionId: "s1", limit: 10 });
  });

  it("loadOlder() walks BACKWARD by toSeq — page 2 lands above page 1", async () => {
    const captured: { params?: unknown[] } = { params: [] };
    // Two pages of a 4-entry log, newest first: [c,d] then [a,b], then the head.
    const pages: TimelineHistoryPage[] = [
      {
        entries: [
          { seq: 2, entry: entry("c") },
          { seq: 3, entry: entry("d") },
        ],
        nextToSeq: 1,
      },
      {
        entries: [
          { seq: 0, entry: entry("a") },
          { seq: 1, entry: entry("b") },
        ],
      },
    ];
    let call = 0;
    const client = {
      transport: {
        subscribe: (_s: SubscriptionScope): SubscriptionStream => neverStream(),
        async request(_m: WireMethod, params: unknown): Promise<unknown> {
          captured.params!.push(params);
          return pages[call++];
        },
      },
    };
    const handle = timelineHandle(client as never, "s1", { initial: [entry("live")] });

    const a = await handle.loadOlder(2);
    expect(a.done).toBe(false);
    const b = await handle.loadOlder(2);
    expect(b.done).toBe(true);
    // The whole point: scroll-back accumulates in log order, oldest at the top.
    expect(ids(handle.list())).toEqual(["a", "b", "c", "d", "live"]);
    // The cursor walks DOWN: no bound, then `toSeq` = the page's first seq - 1.
    expect(captured.params![0]).toEqual({ sessionId: "s1", limit: 2 });
    expect(captured.params![1]).toEqual({ sessionId: "s1", toSeq: 1, limit: 2 });

    // Once done (no `nextToSeq`), further calls are no-ops (no new request).
    const c = await handle.loadOlder(2);
    expect(c).toEqual({ entries: [], done: true });
    expect(captured.params!.length).toBe(2);
  });

  it("live appends stay at the TAIL while scroll-back grows the head", async () => {
    // The contortion this removes: the consumer re-seeded the window from its own
    // mirrored copy, clobbering entries the live fold had appended meanwhile.
    const captured: { params?: unknown[] } = { params: [] };
    const handle = timelineHandle(
      fakeClient({ entries: [{ seq: 4, entry: entry("older") }], nextToSeq: 3 }, captured),
      "s1",
      { initial: [entry("live-1")] },
    );
    await handle.loadOlder(1);
    handle.append([entry("live-2")]); // the fold's next append
    expect(ids(handle.list())).toEqual(["older", "live-1", "live-2"]);
  });
});
