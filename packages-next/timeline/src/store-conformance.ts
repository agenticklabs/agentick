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

    it("append([]) is a no-op", async () => {
      const store = await setup();
      await store.append("s1", []);
      expect(await store.load("s1")).toEqual([]);
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
      "prune() erases leading entries below the given seq, returns the count",
      async () => {
        const store = await setup();
        if (!store.prune) return; // capability absent → nothing to assert
        await store.append("s1", [entry("a"), entry("b"), entry("c")]);
        const removed = await store.prune("s1", { seq: 2 });
        expect(removed).toBe(2);
        expect((await store.load("s1")).map(idOf)).toEqual(["c"]);
      },
    );

    it.skipIf(prune === false)("prune() on an unknown session returns 0", async () => {
      const store = await setup();
      if (!store.prune) return;
      expect(await store.prune("nope", { seq: 5 })).toBe(0);
    });
  });
}
