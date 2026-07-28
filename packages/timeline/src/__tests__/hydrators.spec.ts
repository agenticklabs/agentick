/**
 * ADR 93 — the named hydrators, and the BOUNDED-MEMORY proof.
 *
 * The proof (ADR 93 D1 gate): with an N-entry store and `hydrateTail(k)`, the
 * genesis read goes through the store's cursored `history` with a `limit` and
 * `read` is NEVER called. Every store verb is spied, so "bounded" is asserted
 * against the store's actual call log rather than inferred from the result.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import type { SeqTagged, StoreCtx, TimelineEntry, TimelineStore } from "@agentick/spec";

import { hydrateFromStore, hydrateTail } from "../hydrators.js";
import { TimelineHarness } from "../harness.js";
import { MemoryTimelineStore } from "../store.js";
import { defineTimelineStore } from "../definition.js";
import { messageEntry } from "../conformance.js";

interface StoreSpy {
  readonly store: TimelineStore;
  /** Every verb call, in order: `"read"` / `"history"` / `"append"` / … */
  readonly calls: string[];
  /** The `limit` each `history` call requested (`undefined` = unbounded). */
  readonly historyLimits: (number | undefined)[];
  /** Peak entries handed across the boundary by any single call. */
  readonly peakTransfer: () => number;
}

/** A spied {@link MemoryTimelineStore} — real behavior, observable calls. */
function spyStore(withHistory = true): StoreSpy {
  const inner = new MemoryTimelineStore();
  const calls: string[] = [];
  const historyLimits: (number | undefined)[] = [];
  let peak = 0;
  const base = {
    backend: "spy",
    append: (key: string, entries: readonly TimelineEntry[], ctx: StoreCtx) => {
      calls.push("append");
      return inner.append(key, entries, ctx);
    },
    read: (key: string, ctx: StoreCtx) => {
      calls.push("read");
      return inner.read(key, ctx).then((r) => {
        peak = Math.max(peak, r.length);
        return r;
      });
    },
    keys: (ctx: StoreCtx) => {
      calls.push("keys");
      return inner.keys(ctx);
    },
    delete: (key: string, ctx: StoreCtx) => {
      calls.push("delete");
      return inner.delete(key, ctx);
    },
  };
  const store = withHistory
    ? defineTimelineStore({
        ...base,
        history: (
          key: string,
          options: { readonly fromSeq?: number; readonly limit?: number } | undefined,
          ctx: StoreCtx,
        ): Promise<readonly SeqTagged<TimelineEntry>[]> => {
          calls.push("history");
          historyLimits.push(options?.limit);
          return inner.history(key, options, ctx).then((r) => {
            peak = Math.max(peak, r.length);
            return r;
          });
        },
      })
    : defineTimelineStore(base);
  return { store, calls, historyLimits, peakTransfer: () => peak };
}

function entries(n: number, prefix = "e"): TimelineEntry[] {
  return Array.from({ length: n }, (_, i) => messageEntry(`${prefix}${i}`, `t${i}`));
}

const ctxFor = (
  store: TimelineStore,
  sessionId: string,
): Parameters<ReturnType<typeof hydrateTail>>[0] =>
  ({
    sessionId,
    store,
    log: Object.assign(() => {}, {
      debug: () => {},
      info: () => {},
      notice: () => {},
      warning: () => {},
      warn: () => {},
      error: () => {},
      critical: () => {},
      alert: () => {},
      emergency: () => {},
      with: () => ctxFor(store, sessionId).log,
    }),
  }) as unknown as Parameters<ReturnType<typeof hydrateTail>>[0];

describe("hydrateFromStore — the ADR 49 default", () => {
  it("reads the whole log for the ctx's sessionId", async () => {
    const spy = spyStore();
    await spy.store.append("s1", entries(3), {} as StoreCtx);
    spy.calls.length = 0;
    const got = await hydrateFromStore()(ctxFor(spy.store, "s1"));
    expect(got).toHaveLength(3);
    expect(spy.calls).toEqual(["read"]);
  });

  it("is the harness's implicit default whenever a store is configured", async () => {
    // ADR 49 open-or-rehydrate, preserved EXACTLY: no `hydrate` slot, a store ⇒
    // a full log read at genesis.
    const spy = spyStore();
    await spy.store.append("t-default:timeline", entries(2, "p"), {} as StoreCtx);
    const h = new TimelineHarness(
      "t-default:timeline",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { store: spy.store },
    );
    await h.ready;
    spy.calls.length = 0;
    await h.hydrate();
    expect(spy.calls).toEqual(["read"]);
    expect(h.readPersisted()).toHaveLength(2);
    await h.close();
  });
});

describe("hydrateTail — the BOUNDED-MEMORY proof (ADR 93 D1 gate)", () => {
  it("an N-entry store + tail(k) reads via history-with-limit and NEVER calls read", async () => {
    const N = 1000;
    const k = 5;
    const spy = spyStore();
    await spy.store.append("s-big", entries(N), {} as StoreCtx);
    spy.calls.length = 0;

    const got = await hydrateTail(k)(ctxFor(spy.store, "s-big"));

    // 1. The result is the TAIL, exactly k entries.
    expect(got).toHaveLength(k);
    expect(got.map((e) => (e.kind === "message" ? e.message.id : ""))).toEqual([
      "e995",
      "e996",
      "e997",
      "e998",
      "e999",
    ]);
    // 2. `read` — the unbounded verb — was never called. This is the bound.
    expect(spy.calls).not.toContain("read");
    // 3. Every store touch was a cursored `history`, and every one carried a
    //    finite `limit`: no call could ever transfer the whole log.
    expect(new Set(spy.calls)).toEqual(new Set(["history"]));
    // …and it took exactly ONE: "the last k" is expressible at the port, so
    // there is no forward seek to pay for.
    expect(spy.calls).toEqual(["history"]);
    expect(spy.historyLimits).toEqual([k]);
    // 4. Peak transfer is the paging window, NOT N — the memory claim, measured.
    const window = Math.max(...(spy.historyLimits as number[]));
    expect(spy.peakTransfer()).toBeLessThanOrEqual(window);
    expect(spy.peakTransfer()).toBeLessThan(N);
  });

  it("holds the bound end-to-end through the harness's genesis", async () => {
    const N = 700;
    const k = 3;
    const spy = spyStore();
    await spy.store.append("t-tail:timeline", entries(N), {} as StoreCtx);
    const h = new TimelineHarness(
      "t-tail:timeline",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { store: spy.store, hydrate: hydrateTail(k) },
    );
    await h.ready;
    spy.calls.length = 0;
    await h.hydrate();
    // The harness holds k, not N — the whole point of the seam.
    expect(h.readPersisted()).toHaveLength(k);
    expect(h.read().entries).toHaveLength(k);
    expect(spy.calls).not.toContain("read");
    await h.close();
  });

  it("returns the whole log when it is shorter than the tail", async () => {
    const spy = spyStore();
    await spy.store.append("s-short", entries(2), {} as StoreCtx);
    const got = await hydrateTail(10)(ctxFor(spy.store, "s-short"));
    expect(got).toHaveLength(2);
    expect(spy.calls).not.toContain("read");
  });

  it("opens empty for an empty log and for n <= 0", async () => {
    const spy = spyStore();
    expect(await hydrateTail(5)(ctxFor(spy.store, "s-empty"))).toEqual([]);
    await spy.store.append("s-zero", entries(3), {} as StoreCtx);
    spy.calls.length = 0;
    expect(await hydrateTail(0)(ctxFor(spy.store, "s-zero"))).toEqual([]);
    // n <= 0 short-circuits: the store is not touched at all.
    expect(spy.calls).toEqual([]);
  });

  it("DEGRADES to a full read when the store implements no history — same result, no bound", async () => {
    const spy = spyStore(false);
    await spy.store.append("s-nohist", entries(20), {} as StoreCtx);
    spy.calls.length = 0;
    const got = await hydrateTail(4)(ctxFor(spy.store, "s-nohist"));
    // The RESULT is identical…
    expect(got).toHaveLength(4);
    expect(got.map((e) => (e.kind === "message" ? e.message.id : ""))).toEqual([
      "e16",
      "e17",
      "e18",
      "e19",
    ]);
    // …but the memory PROPERTY is gone, and the call log says so plainly.
    expect(spy.calls).toEqual(["read"]);
  });
});
