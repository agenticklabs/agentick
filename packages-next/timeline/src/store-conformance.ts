/**
 * Conformance suite for {@link TimelineStore} implementations (ADR 49).
 *
 * Every adapter — the bundled {@link MemoryTimelineStore}, the reference
 * `@agentick/timeline-fs-next` / `-sqlite-next` / `-postgres-next`, and
 * any adopter-written store — MUST pass this suite. The behaviors pinned
 * here are the substrate contract the {@link TimelineHarness} depends on:
 * append-only ordering, per-session isolation, `load`-returns-the-fold,
 * enumeration, and idempotent delete. An adapter that diverges breaks the
 * harness's durability + hydration guarantees in subtle ways.
 *
 * Usage from an adapter package's test file:
 *
 * ```ts
 * import { runTimelineStoreConformance } from "@agentick/timeline-next";
 * import { myTimelineStore } from "../src/index.js";
 *
 * runTimelineStoreConformance({
 *   label: "my-store",
 *   factory: () => myTimelineStore({ ... }),
 * });
 * ```
 */

import { describe, expect, it } from "vitest";

import type { TimelineEntry } from "@agentick/spec-next";

import type { TimelineStore } from "./store.js";

export interface TimelineStoreConformanceOptions {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /** Fresh, isolated store per test. */
  readonly factory: () => TimelineStore | Promise<TimelineStore>;
  /** Capabilities the suite skips if unsupported. */
  readonly capabilities?: {
    /** `prune` (destructive erasure) supported — defaults to `typeof store.prune === "function"`. */
    readonly prune?: boolean;
  };
}

/** Minimal well-formed entry — the store treats entries as opaque blobs. */
function entry(id: string): TimelineEntry {
  return {
    kind: "message",
    message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
  } as unknown as TimelineEntry;
}

/** Stable identity of an entry (the store preserves it opaquely). */
const idOf = (e: TimelineEntry): string => (e as { message: { id: string } }).message.id;

export function runTimelineStoreConformance(opts: TimelineStoreConformanceOptions): void {
  const setup = async (): Promise<TimelineStore> => opts.factory();

  describe(`TimelineStore conformance — ${opts.label}`, () => {
    it("reports a stable, non-empty backend identifier", async () => {
      const store = await setup();
      expect(typeof store.backend).toBe("string");
      expect(store.backend.length).toBeGreaterThan(0);
    });

    it("load() returns [] for an unknown session", async () => {
      const store = await setup();
      expect(await store.load("never-seen")).toEqual([]);
    });

    it("append then load round-trips entries in order", async () => {
      const store = await setup();
      await store.append("s1", [entry("a"), entry("b")]);
      await store.append("s1", [entry("c")]);
      const loaded = await store.load("s1");
      expect(loaded.map(idOf)).toEqual(["a", "b", "c"]);
    });

    it("append([]) is a no-op and returns no seqs", async () => {
      const store = await setup();
      expect(await store.append("s1", [])).toEqual([]);
      expect(await store.load("s1")).toEqual([]);
    });

    it("append returns one seq per entry, strictly increasing and never reused", async () => {
      const store = await setup();
      const first = await store.append("s1", [entry("a"), entry("b")]);
      const second = await store.append("s1", [entry("c")]);
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(1);
      const all = [...first, ...second];
      // Strictly increasing across the whole session.
      for (let i = 1; i < all.length; i++) expect(all[i]).toBeGreaterThan(all[i - 1]!);
    });

    it("history() (when implemented) pages by seq: fromSeq + limit, seq-tagged, prune-stable", async (ctx) => {
      const store = await setup();
      if (store.history === undefined) return ctx.skip();
      const sid = "conf-history";
      const seqs = await store.append(sid, [entry("a"), entry("b"), entry("c"), entry("d")]);
      // Full read is seq-tagged and ordered.
      const all = await store.history(sid);
      expect(all.map((t) => t.seq)).toEqual([...seqs]);
      expect(all.map((t) => idOf(t.entry))).toEqual(["a", "b", "c", "d"]);
      // Cursor: inclusive-from semantics (seq >= fromSeq).
      const fromSecond = await store.history(sid, { fromSeq: seqs[1]! });
      expect(fromSecond.map((t) => idOf(t.entry))).toEqual(["b", "c", "d"]);
      // Paging.
      const page = await store.history(sid, { fromSeq: seqs[1]!, limit: 2 });
      expect(page.map((t) => idOf(t.entry))).toEqual(["b", "c"]);
      // Prune-stability: survivors keep their seq; cursor still lands right.
      if (store.prune) {
        await store.prune(sid, { seq: seqs[2]! });
        const after = await store.history(sid, { fromSeq: 0 });
        expect(after.map((t) => t.seq)).toEqual([seqs[2], seqs[3]]);
      }
    });

    it("isolates entries across sessions (no bleed)", async () => {
      const store = await setup();
      await store.append("s1", [entry("a")]);
      await store.append("s2", [entry("x")]);
      expect((await store.load("s1")).map(idOf)).toEqual(["a"]);
      expect((await store.load("s2")).map(idOf)).toEqual(["x"]);
    });

    it("load() returns a defensive copy — mutating the result never mutates the store", async () => {
      const store = await setup();
      await store.append("s1", [entry("a")]);
      const first = await store.load("s1");
      (first as TimelineEntry[]).push(entry("rogue"));
      expect((await store.load("s1")).map(idOf)).toEqual(["a"]);
    });

    it("enumerates sessions that hold entries", async () => {
      const store = await setup();
      await store.append("s1", [entry("a")]);
      await store.append("s2", [entry("b")]);
      expect([...(await store.sessions())].sort()).toEqual(["s1", "s2"]);
    });

    it("delete() removes a session and is idempotent", async () => {
      const store = await setup();
      await store.append("s1", [entry("a")]);
      expect(await store.delete("s1")).toBe(true);
      expect(await store.load("s1")).toEqual([]);
      expect(await store.sessions()).not.toContain("s1");
      // Second delete: absent → false, no throw.
      expect(await store.delete("s1")).toBe(false);
    });

    const prune = opts.capabilities?.prune;
    it.skipIf(prune === false)(
      "prune() erases entries below an ABSOLUTE seq and returns the count",
      async () => {
        const store = await setup();
        if (!store.prune) return; // capability absent → nothing to assert
        const [, , sc] = await store.append("s1", [entry("a"), entry("b"), entry("c"), entry("d")]);
        // Erase everything strictly below c's seq → a, b.
        const removed = await store.prune("s1", { seq: sc! });
        expect(removed).toBe(2);
        expect((await store.load("s1")).map(idOf)).toEqual(["c", "d"]);
      },
    );

    it.skipIf(prune === false)(
      "prune() is by absolute seq, not position — survivors keep their seq, appends never reuse",
      async () => {
        const store = await setup();
        if (!store.prune) return;
        const seqs = await store.append("s1", [entry("a"), entry("b"), entry("c"), entry("d")]);
        await store.prune("s1", { seq: seqs[2]! }); // erase a, b (seq < c)
        // A fresh append continues PAST d — never reuses a retired seq.
        const [se] = await store.append("s1", [entry("e")]);
        expect(se).toBeGreaterThan(seqs[3]!);
        // A second prune uses the SAME absolute seq space (positional would
        // over-erase): erase everything below d → drops c only.
        const removed2 = await store.prune("s1", { seq: seqs[3]! });
        expect(removed2).toBe(1);
        expect((await store.load("s1")).map(idOf)).toEqual(["d", "e"]);
      },
    );

    it.skipIf(prune === false)(
      "prune-to-empty keeps the seq counter — a later append does not restart",
      async () => {
        const store = await setup();
        if (!store.prune) return;
        const seqs = await store.append("s1", [entry("a"), entry("b")]);
        await store.prune("s1", { seq: seqs[1]! + 1 }); // erase all
        expect(await store.load("s1")).toEqual([]);
        const [sc] = await store.append("s1", [entry("c")]);
        expect(sc).toBeGreaterThan(seqs[1]!); // continues, no reuse
      },
    );

    it.skipIf(prune === false)("prune() on an unknown session returns 0", async () => {
      const store = await setup();
      if (!store.prune) return;
      expect(await store.prune("nope", { seq: 5 })).toBe(0);
    });
  });
}
