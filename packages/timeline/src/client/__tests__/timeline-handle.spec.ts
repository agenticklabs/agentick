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

  it("loadOlder() reads timeline/history, prepends the page, tracks the cursor", async () => {
    const captured: { params?: unknown[]; methods?: string[] } = { params: [], methods: [] };
    const handle = timelineHandle(
      fakeClient({ entries: [{ seq: 1, entry: entry("older") }], nextFromSeq: 2 }, captured),
      "s1",
      { initial: [entry("live")] },
    );

    const first = await handle.loadOlder(10);
    expect(first.done).toBe(false);
    expect(ids(first.entries)).toEqual(["older"]);
    // Prepended at the HEAD, before the live window.
    expect(ids(handle.list())).toEqual(["older", "live"]);
    // First page reads from the log start (no fromSeq), capped by limit.
    expect(captured.methods).toEqual(["timeline/history"]);
    expect(captured.params![0]).toEqual({ sessionId: "s1", limit: 10 });
  });

  it("loadOlder() advances fromSeq across calls and latches done at the log tail", async () => {
    const captured: { params?: unknown[] } = { params: [] };
    // First call returns a page with nextFromSeq; construct the handle so the
    // SAME client answers both calls — second answer signals the tail.
    let call = 0;
    const client = {
      transport: {
        subscribe: (_s: SubscriptionScope): SubscriptionStream => neverStream(),
        async request(_m: WireMethod, params: unknown): Promise<unknown> {
          captured.params!.push(params);
          call += 1;
          return call === 1
            ? ({
                entries: [{ seq: 5, entry: entry("p1") }],
                nextFromSeq: 6,
              } satisfies TimelineHistoryPage)
            : ({ entries: [{ seq: 6, entry: entry("p2") }] } satisfies TimelineHistoryPage);
        },
      },
    };
    const handle = timelineHandle(client as never, "s1");

    const a = await handle.loadOlder();
    expect(a.done).toBe(false);
    const b = await handle.loadOlder();
    expect(b.done).toBe(true);
    // Second call carried the advanced cursor.
    expect(captured.params![1]).toEqual({ sessionId: "s1", fromSeq: 6 });

    // Once done, further calls are no-ops (no new request).
    const c = await handle.loadOlder();
    expect(c).toEqual({ entries: [], done: true });
    expect(captured.params!.length).toBe(2);
  });
});
