/**
 * ADR 93 — `defineTimeline` + `defineTimelineStore`.
 *
 * Pins the laws the definition surface makes:
 *   - `defineTimeline` is IDENTITY + brand (not a constructor, not a copy);
 *   - definitions are INERT until install — no store opened, no hydrator run;
 *   - the definition IS the options (one shape reaches the harness);
 *   - `defineTimelineStore` derives the `Store` seam from the log verbs and
 *     passes the same conformance suite a published adapter does.
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { stubStoreCtx } from "@agentick/store";
import type { SeqTagged, StoreCtx, TimelineEntry } from "@agentick/spec";

import {
  defineTimeline,
  defineTimelineStore,
  isTimelineDefinition,
  isTimelineHarnessInstance,
} from "../definition.js";
import { TimelineHarness } from "../harness.js";
import { MemoryTimelineStore } from "../store.js";
import { runTimelineStoreConformance } from "../store-conformance.js";
import { messageEntry } from "../conformance.js";

describe("defineTimeline — identity + brand", () => {
  it("returns the SAME object, stamped (identity, not a copy)", () => {
    const options = { writePolicy: "through" as const };
    const definition = defineTimeline(options);
    expect(definition).toBe(options);
    expect(isTimelineDefinition(definition)).toBe(true);
  });

  it("the brand is non-enumerable — the definition stays plain data", () => {
    const definition = defineTimeline({ writePolicy: "through" });
    expect(Object.keys(definition)).toEqual(["writePolicy"]);
    expect(JSON.parse(JSON.stringify(definition))).toEqual({ writePolicy: "through" });
    // Spreading a definition (the "import prod, override a slot" test pattern)
    // yields a usable — if unbranded — definition: the brand is for slots to
    // introspect, never a precondition for use.
    const overridden = { ...definition, writePolicy: "behind" as const };
    expect(isTimelineDefinition(overridden)).toBe(false);
    expect(overridden.writePolicy).toBe("behind");
  });

  it("an INLINE bag is a valid definition (defineTimeline is optional sugar)", () => {
    expect(isTimelineDefinition({ writePolicy: "behind" })).toBe(false);
    // …and both reach the harness identically: the brand carries no behavior.
    const fromInline = new TimelineHarness(
      "t-inline",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      { writePolicy: "through" },
    );
    const fromDefinition = new TimelineHarness(
      "t-defined",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
      defineTimeline({ writePolicy: "through" }),
    );
    expect(fromInline.backend).toBe(fromDefinition.backend);
  });

  it("is INERT: no store is touched and no hydrator runs at define time", () => {
    let reads = 0;
    let hydrated = 0;
    const store = defineTimelineStore({
      backend: "spy",
      append: () => Promise.resolve([]),
      read: () => {
        reads += 1;
        return Promise.resolve([]);
      },
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
    });
    defineTimeline({
      store,
      hydrate: async () => {
        hydrated += 1;
        return [];
      },
    });
    expect(reads).toBe(0);
    expect(hydrated).toBe(0);
  });
});

describe("isTimelineHarnessInstance — the ADR 42 dichotomy discriminator", () => {
  it("separates a live harness from a definition", async () => {
    const harness = new TimelineHarness(
      "t-disc",
      new MemoryJournal(),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;
    expect(isTimelineHarnessInstance(harness)).toBe(true);
    expect(isTimelineHarnessInstance(defineTimeline({ store: new MemoryTimelineStore() }))).toBe(
      false,
    );
    expect(isTimelineHarnessInstance(undefined)).toBe(false);
    expect(isTimelineHarnessInstance({})).toBe(false);
    await harness.close();
  });
});

describe("defineTimelineStore — the port's inline constructor", () => {
  /** An in-memory log built ONLY from the four required verbs + history. */
  function inlineStore(): { store: ReturnType<typeof defineTimelineStore>; calls: string[] } {
    const logs = new Map<string, TimelineEntry[]>();
    const calls: string[] = [];
    const store = defineTimelineStore({
      backend: "inline-test",
      append: (key, entries) => {
        calls.push("append");
        const list = logs.get(key) ?? [];
        const start = list.length;
        list.push(...entries);
        logs.set(key, list);
        return Promise.resolve(entries.map((_, i) => start + i));
      },
      read: (key) => {
        calls.push("read");
        return Promise.resolve([...(logs.get(key) ?? [])]);
      },
      keys: () => {
        calls.push("keys");
        return Promise.resolve([...logs.keys()].filter((k) => (logs.get(k) ?? []).length > 0));
      },
      delete: (key) => {
        calls.push("delete");
        return Promise.resolve(logs.delete(key));
      },
      history: (key, options) => {
        calls.push("history");
        const list = logs.get(key) ?? [];
        const from = options?.fromSeq ?? 0;
        const end = options?.limit !== undefined ? from + options.limit : list.length;
        const out: SeqTagged<TimelineEntry>[] = [];
        for (let i = from; i < Math.min(end, list.length); i++) {
          out.push({ seq: i, entry: list[i]! });
        }
        return Promise.resolve(out);
      },
    });
    return { store, calls };
  }

  it("derives the Store seam (query/mutate) from the log verbs", async () => {
    const { store, calls } = inlineStore();
    const ctx: StoreCtx = stubStoreCtx();
    await store.mutate({ append: { logKey: "L", entries: [messageEntry("a", "1")] } }, ctx);
    expect(calls).toContain("append");
    const projected = await store.query({ logKey: "L" }, ctx);
    expect(projected).toHaveLength(1);
    // An undefined query identifies no log, so it projects nothing.
    expect(await store.query(undefined, ctx)).toEqual([]);
  });

  it("query delegates a cursored window to history and drops the seq tags", async () => {
    const { store, calls } = inlineStore();
    const ctx = stubStoreCtx();
    await store.append("L", [messageEntry("a", "1"), messageEntry("b", "2")], ctx);
    calls.length = 0;
    const window = await store.query({ logKey: "L", fromSeq: 1, limit: 1 }, ctx);
    expect(calls).toEqual(["history"]);
    expect(window).toHaveLength(1);
    expect((window[0] as { message: { id: string } }).message.id).toBe("b");
  });

  it("omitted optional verbs are ABSENT (feature detection, never undefined-valued)", () => {
    const minimal = defineTimelineStore({
      append: () => Promise.resolve([]),
      read: () => Promise.resolve([]),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
    });
    expect("history" in minimal).toBe(false);
    expect("prune" in minimal).toBe(false);
    expect(minimal.backend).toBe("inline");
  });

  it("a fromSeq query against a history-less store FAILS LOUDLY (position ≠ seq)", async () => {
    const minimal = defineTimelineStore({
      append: () => Promise.resolve([]),
      read: () => Promise.resolve([messageEntry("a", "1")]),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
    });
    const ctx = stubStoreCtx();
    // Whole-log and head-limited windows are answerable from `read`…
    expect(await minimal.query({ logKey: "L" }, ctx)).toHaveLength(1);
    expect(await minimal.query({ logKey: "L", limit: 0 }, ctx)).toHaveLength(0);
    // …but a SEQ cursor is not: substituting array position would silently
    // return the wrong window once anything is pruned.
    await expect(minimal.query({ logKey: "L", fromSeq: 3 }, ctx)).rejects.toThrow(/history/);
  });
});

// The whole point of an inline constructor is that it is not a second-class
// store: the same suite that certifies `MemoryTimelineStore` and every published
// adapter certifies this one, including the frozen `seq` contract that types
// cannot check.
runTimelineStoreConformance({
  label: "defineTimelineStore (inline)",
  factory: () => {
    const logs = new Map<string, { entries: TimelineEntry[]; baseSeq: number }>();
    const rec = (key: string): { entries: TimelineEntry[]; baseSeq: number } => {
      const found = logs.get(key);
      if (found !== undefined) return found;
      const fresh = { entries: [] as TimelineEntry[], baseSeq: 0 };
      logs.set(key, fresh);
      return fresh;
    };
    return defineTimelineStore({
      backend: "inline-conformance",
      append: (key, entries) => {
        if (entries.length === 0) return Promise.resolve([]);
        const r = rec(key);
        const start = r.baseSeq + r.entries.length;
        r.entries.push(...entries);
        return Promise.resolve(entries.map((_, i) => start + i));
      },
      read: (key) => Promise.resolve([...(logs.get(key)?.entries ?? [])]),
      keys: () =>
        Promise.resolve(
          [...logs.entries()].filter(([, r]) => r.entries.length > 0).map(([k]) => k),
        ),
      delete: (key) => Promise.resolve(logs.delete(key)),
      history: (key, options) => {
        const r = logs.get(key);
        if (r === undefined) return Promise.resolve([]);
        const start = Math.max((options?.fromSeq ?? 0) - r.baseSeq, 0);
        const end =
          options?.limit !== undefined
            ? Math.min(start + options.limit, r.entries.length)
            : r.entries.length;
        const out: SeqTagged<TimelineEntry>[] = [];
        for (let i = start; i < end; i++) out.push({ seq: r.baseSeq + i, entry: r.entries[i]! });
        return Promise.resolve(out);
      },
      prune: (key, before) => {
        const r = logs.get(key);
        if (r === undefined) return Promise.resolve(0);
        const cut = Math.max(0, Math.min(before.seq - r.baseSeq, r.entries.length));
        if (cut === 0) return Promise.resolve(0);
        r.entries.splice(0, cut);
        r.baseSeq += cut;
        return Promise.resolve(cut);
      },
    });
  },
});
