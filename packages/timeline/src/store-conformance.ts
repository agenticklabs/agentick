/**
 * Conformance suite for {@link TimelineStore} implementations (ADR 49).
 *
 * Every adapter — the bundled {@link import("./store.js").MemoryTimelineStore},
 * the reference `@agentick/timeline-fs` / `-sqlite` / `-postgres`,
 * and any adopter-written store — MUST pass this suite. The behaviors pinned
 * here are the substrate contract the {@link
 * import("./harness.js").TimelineHarness} depends on: append-only ordering,
 * per-session isolation, `read`-returns-the-fold, enumeration, and idempotent
 * delete. An adapter that diverges breaks the harness's durability + hydration
 * guarantees in subtle ways.
 *
 * The store-agnostic cases (backend-id stable + non-empty; unknown-key →
 * `[]`; delete-of-absent idempotent) are delegated to the shared {@link
 * runStoreConformance} skeleton (`@agentick/store`) via its `emptyRead` /
 * `idempotentDelete` probes — the LOG archetype's empty value is `[]` (not the
 * collection's `undefined`), passed through the closure. The log-specific cases
 * (append ordering, seq monotonicity, `history` paging, prune-by-absolute-seq,
 * per-session isolation, defensive copy) are registered through its `cases`
 * hook. Mirrors `runTaskStoreConformance` (`@agentick/tasks`).
 *
 * Usage from an adapter package's test file:
 *
 * ```ts
 * import { runTimelineStoreConformance } from "@agentick/timeline/testing";
 * import { myTimelineStore } from "../src/index.js";
 *
 * runTimelineStoreConformance({
 *   label: "my-store",
 *   factory: () => myTimelineStore({ ... }),
 * });
 * ```
 */

import { expect, it } from "vitest";

import type { TimelineEntry, TimelineStore } from "@agentick/spec";
import { stubStoreCtx } from "@agentick/store";
import { runStoreConformance } from "@agentick/store/testing";

export interface TimelineStoreConformanceOptions {
  /** Display label for the suite (`describe` block heading). */
  readonly label: string;
  /** Fresh, isolated store per test. */
  readonly factory: () => TimelineStore | Promise<TimelineStore>;
  /**
   * Skip the whole suite (registers it as skipped, never constructs a
   * store). For adapters whose backend may be absent in the test env —
   * e.g. `@agentick/timeline-postgres` gating on a `TIMELINE_PG_URL`
   * probe — compute the availability boolean at the call site and pass
   * `skip: !available`. Threading it as an option (rather than wrapping the
   * call in an `if`) keeps the gate out of the test-body conditionals the
   * linter forbids.
   */
  readonly skip?: boolean;
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
  runStoreConformance<TimelineStore>({
    label: opts.label,
    factory: opts.factory,
    skip: opts.skip,
    capabilities: opts.capabilities,
    // Store-agnostic: the LOG archetype's empty read is `[]`; delete of an
    // absent key settles.
    emptyRead: { read: (store, key) => store.read(key, stubStoreCtx()), expected: [] },
    idempotentDelete: (store, key) => store.delete(key, stubStoreCtx()),
    cases: ({ setup, capabilities }) => {
      it("append then read round-trips entries in order", async () => {
        const store = await setup();
        await store.append("s1", [entry("a"), entry("b")], stubStoreCtx());
        await store.append("s1", [entry("c")], stubStoreCtx());
        const loaded = await store.read("s1", stubStoreCtx());
        expect(loaded.map(idOf)).toEqual(["a", "b", "c"]);
      });

      it("append([]) is a no-op and returns no seqs", async () => {
        const store = await setup();
        expect(await store.append("s1", [], stubStoreCtx())).toEqual([]);
        expect(await store.read("s1", stubStoreCtx())).toEqual([]);
      });

      it("append returns one seq per entry, strictly increasing and never reused", async () => {
        const store = await setup();
        const first = await store.append("s1", [entry("a"), entry("b")], stubStoreCtx());
        const second = await store.append("s1", [entry("c")], stubStoreCtx());
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
        const seqs = await store.append(
          sid,
          [entry("a"), entry("b"), entry("c"), entry("d")],
          stubStoreCtx(),
        );
        // Full read is seq-tagged and ordered.
        const all = await store.history(sid, undefined, stubStoreCtx());
        expect(all.map((t) => t.seq)).toEqual([...seqs]);
        expect(all.map((t) => idOf(t.entry))).toEqual(["a", "b", "c", "d"]);
        // Cursor: inclusive-from semantics (seq >= fromSeq).
        const fromSecond = await store.history(sid, { fromSeq: seqs[1]! }, stubStoreCtx());
        expect(fromSecond.map((t) => idOf(t.entry))).toEqual(["b", "c", "d"]);
        // Paging.
        const page = await store.history(sid, { fromSeq: seqs[1]!, limit: 2 }, stubStoreCtx());
        expect(page.map((t) => idOf(t.entry))).toEqual(["b", "c"]);
        // Prune-stability: survivors keep their seq; cursor still lands right.
        if (store.prune) {
          await store.prune(sid, { seq: seqs[2]! }, stubStoreCtx());
          const after = await store.history(sid, { fromSeq: 0 }, stubStoreCtx());
          expect(after.map((t) => t.seq)).toEqual([seqs[2], seqs[3]]);
        }
      });

      it("history() bounds above with toSeq and anchors `limit` at the TAIL", async (ctx) => {
        const store = await setup();
        if (store.history === undefined) return ctx.skip();
        const sid = "conf-tail";
        const seqs = await store.append(
          sid,
          [entry("a"), entry("b"), entry("c"), entry("d")],
          stubStoreCtx(),
        );
        // Inclusive upper bound.
        const through = await store.history(sid, { toSeq: seqs[2]! }, stubStoreCtx());
        expect(through.map((t) => idOf(t.entry))).toEqual(["a", "b", "c"]);
        // Both bounds compose.
        const window = await store.history(
          sid,
          { fromSeq: seqs[1]!, toSeq: seqs[2]! },
          stubStoreCtx(),
        );
        expect(window.map((t) => idOf(t.entry))).toEqual(["b", "c"]);
        // The anchor rule: no `fromSeq` ⇒ `limit` takes the LAST n, ASCENDING.
        const tail = await store.history(sid, { limit: 2 }, stubStoreCtx());
        expect(tail.map((t) => idOf(t.entry))).toEqual(["c", "d"]);
        expect(tail.map((t) => t.seq)).toEqual([seqs[2], seqs[3]]);
        // Backward paging: the n ending at an upper bound.
        const older = await store.history(sid, { toSeq: seqs[2]! - 1, limit: 2 }, stubStoreCtx());
        expect(older.map((t) => idOf(t.entry))).toEqual(["a", "b"]);
        // A limit wider than the window is not padded; forward anchor unchanged.
        expect((await store.history(sid, { limit: 99 }, stubStoreCtx())).length).toBe(4);
        const head = await store.history(sid, { fromSeq: 0, limit: 2 }, stubStoreCtx());
        expect(head.map((t) => idOf(t.entry))).toEqual(["a", "b"]);
      });

      it("isolates entries across sessions (no bleed)", async () => {
        const store = await setup();
        await store.append("s1", [entry("a")], stubStoreCtx());
        await store.append("s2", [entry("x")], stubStoreCtx());
        expect((await store.read("s1", stubStoreCtx())).map(idOf)).toEqual(["a"]);
        expect((await store.read("s2", stubStoreCtx())).map(idOf)).toEqual(["x"]);
      });

      it("read() returns a defensive copy — mutating the result never mutates the store", async () => {
        const store = await setup();
        await store.append("s1", [entry("a")], stubStoreCtx());
        const first = await store.read("s1", stubStoreCtx());
        (first as TimelineEntry[]).push(entry("rogue"));
        expect((await store.read("s1", stubStoreCtx())).map(idOf)).toEqual(["a"]);
      });

      it("enumerates sessions that hold entries", async () => {
        const store = await setup();
        await store.append("s1", [entry("a")], stubStoreCtx());
        await store.append("s2", [entry("b")], stubStoreCtx());
        expect([...(await store.keys(stubStoreCtx()))].sort()).toEqual(["s1", "s2"]);
      });

      it("delete() removes a session and is idempotent", async () => {
        const store = await setup();
        await store.append("s1", [entry("a")], stubStoreCtx());
        expect(await store.delete("s1", stubStoreCtx())).toBe(true);
        expect(await store.read("s1", stubStoreCtx())).toEqual([]);
        expect(await store.keys(stubStoreCtx())).not.toContain("s1");
        // Second delete: absent → false, no throw.
        expect(await store.delete("s1", stubStoreCtx())).toBe(false);
      });

      const prune = capabilities?.prune;
      it.skipIf(prune === false)(
        "prune() erases entries below an ABSOLUTE seq and returns the count",
        async () => {
          const store = await setup();
          if (!store.prune) return; // capability absent → nothing to assert
          const [, , sc] = await store.append(
            "s1",
            [entry("a"), entry("b"), entry("c"), entry("d")],
            stubStoreCtx(),
          );
          // Erase everything strictly below c's seq → a, b.
          const removed = await store.prune("s1", { seq: sc! }, stubStoreCtx());
          expect(removed).toBe(2);
          expect((await store.read("s1", stubStoreCtx())).map(idOf)).toEqual(["c", "d"]);
        },
      );

      it.skipIf(prune === false)(
        "prune() is by absolute seq, not position — survivors keep their seq, appends never reuse",
        async () => {
          const store = await setup();
          if (!store.prune) return;
          const seqs = await store.append(
            "s1",
            [entry("a"), entry("b"), entry("c"), entry("d")],
            stubStoreCtx(),
          );
          await store.prune("s1", { seq: seqs[2]! }, stubStoreCtx()); // erase a, b (seq < c)
          // A fresh append continues PAST d — never reuses a retired seq.
          const [se] = await store.append("s1", [entry("e")], stubStoreCtx());
          expect(se).toBeGreaterThan(seqs[3]!);
          // A second prune uses the SAME absolute seq space (positional would
          // over-erase): erase everything below d → drops c only.
          const removed2 = await store.prune("s1", { seq: seqs[3]! }, stubStoreCtx());
          expect(removed2).toBe(1);
          expect((await store.read("s1", stubStoreCtx())).map(idOf)).toEqual(["d", "e"]);
        },
      );

      it.skipIf(prune === false)(
        "prune-to-empty keeps the seq counter — a later append does not restart",
        async () => {
          const store = await setup();
          if (!store.prune) return;
          const seqs = await store.append("s1", [entry("a"), entry("b")], stubStoreCtx());
          await store.prune("s1", { seq: seqs[1]! + 1 }, stubStoreCtx()); // erase all
          expect(await store.read("s1", stubStoreCtx())).toEqual([]);
          const [sc] = await store.append("s1", [entry("c")], stubStoreCtx());
          expect(sc).toBeGreaterThan(seqs[1]!); // continues, no reuse
        },
      );

      it.skipIf(prune === false)("prune() on an unknown session returns 0", async () => {
        const store = await setup();
        if (!store.prune) return;
        expect(await store.prune("nope", { seq: 5 }, stubStoreCtx())).toBe(0);
      });
    },
  });
}
