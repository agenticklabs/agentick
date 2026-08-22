/**
 * Conformance suite for {@link TimelineHarnessProtocol} implementations.
 *
 * Validates the two-tier (log + projection) contract every TimelineHarness
 * implementation must satisfy:
 *
 *   - Sync surface: read / subscribe / readPersisted
 *   - Async surface: append / compact / replaceProjection / resetProjection
 *   - append writes to BOTH log and projection
 *   - compact writes to projection ONLY; log untouched; lastCompaction recorded
 *   - replaceProjection writes to projection ONLY
 *   - resetProjection rebuilds projection as a mirror of log
 *   - snapshot round-trip preserves log + projection + provenance
 *   - GENESIS (ADR 93, optional section): the hydrator seeds and is never
 *     re-appended; a throwing hydrator surfaces typed
 */

import { describe, expect, it } from "vitest";
import type {
  CompactStrategy,
  TimelineEntry,
  TimelineHarnessProtocol,
  TurnBoundaryEntry,
  TimelineStore,
} from "@agentick/spec";
import { isCheckpointCapable, TimelineHydrateFailed, TimelineWriteFailed } from "@agentick/spec";
import type { TimelineDefinition } from "./definition.js";
import { MemoryTimelineStore } from "./store.js";

export interface TimelineHarnessFactoryDeps {
  /** Construct a fresh harness. Caller MUST await `harness.ready`. */
  readonly make: () => Promise<TimelineHarnessProtocol>;
  /**
   * OPTIONAL — construct a harness from an ADR-93 {@link TimelineDefinition},
   * lighting up the GENESIS and CHECKPOINT conformance sections. Implementations
   * that accept a definition should supply this; the harness's `hydrate()` and
   * `persist()` must be callable by the caller (the session drives both, so the
   * suite drives them here too).
   *
   * The same `store` AND the same `scopeId` across two calls is how the suite
   * models one durable log outliving the harness that wrote it — the
   * evict→resume shape. The store is keyed by scope, so identity is half the
   * round-trip and cannot be left to the factory.
   */
  readonly makeFromDefinition?: (
    definition: TimelineDefinition,
    scopeId?: string,
  ) => Promise<TimelineHarnessProtocol & { hydrate(): Promise<void>; persist(): Promise<void> }>;
}

function messageEntry(id: string, text: string): TimelineEntry {
  return {
    kind: "message",
    message: {
      id,
      role: "user",
      content: [{ type: "text", text }],
      ts: Date.now(),
    },
  };
}

function entryId(entry: TimelineEntry): string {
  return entry.kind === "message" ? entry.message.id : entry.kind;
}

function identityCompact(metadata?: Record<string, unknown>): CompactStrategy {
  return {
    source: "persisted",
    run: async ({ entries }) => entries,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

function summarizeCompact(): CompactStrategy {
  return {
    source: "persisted",
    run: async ({ entries }) => [messageEntry("summary", `[${entries.length} entries summarized]`)],
    metadata: { strategy: "summarize" },
  };
}

export function runTimelineHarnessConformance(deps: TimelineHarnessFactoryDeps): void {
  describe("TimelineHarness — sync surface", () => {
    it("read() returns empty + version 0 on a fresh harness", async () => {
      const h = await deps.make();
      const snap = h.read();
      expect(snap.entries).toEqual([]);
      expect(snap.version).toBe(0);
      await h.close();
    });

    it("readPersisted() returns the durable log", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "hello");
      await h.append(e1);
      expect(h.readPersisted()).toEqual([e1]);
      await h.close();
    });

    it("subscribe() fires on append", async () => {
      const h = await deps.make();
      let count = 0;
      h.subscribe(() => count++);
      await h.append(messageEntry("e1", "x"));
      await h.append(messageEntry("e2", "y"));
      expect(count).toBe(2);
      await h.close();
    });

    it("subscribe() unsubscribes cleanly", async () => {
      const h = await deps.make();
      let count = 0;
      const unsub = h.subscribe(() => count++);
      await h.append(messageEntry("e1", "x"));
      unsub();
      await h.append(messageEntry("e2", "y"));
      expect(count).toBe(1);
      await h.close();
    });

    it("read() returns a new snapshot reference after each mutation", async () => {
      const h = await deps.make();
      const before = h.read();
      await h.append(messageEntry("e1", "x"));
      const after = h.read();
      expect(after).not.toBe(before);
      expect(after.entries).not.toBe(before.entries);
      expect(after.version).toBe(before.version + 1);
      await h.close();
    });
  });

  describe("TimelineHarness — append", () => {
    it("append() writes to BOTH log and projection in order", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      const e2 = messageEntry("e2", "b");
      await h.append(e1);
      await h.append(e2);
      expect(h.readPersisted()).toEqual([e1, e2]);
      expect(h.read().entries).toEqual([e1, e2]);
      await h.close();
    });

    it("append after compact lands at the tail of the compacted projection", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      const e2 = messageEntry("e2", "b");
      await h.append(e1);
      await h.append(e2);
      await h.compact(summarizeCompact());
      const projBefore = h.read().entries;
      expect(projBefore).toHaveLength(1);

      const e3 = messageEntry("e3", "c");
      await h.append(e3);
      const projAfter = h.read().entries;
      expect(projAfter).toHaveLength(2);
      expect(projAfter[1]).toEqual(e3);
      // Log has the three appends plus the summary the compaction produced.
      expect(h.readPersisted()).toHaveLength(4);
      await h.close();
    });
  });

  describe("TimelineHarness — compact", () => {
    it("compact() rewrites the projection and appends what it produced", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      const e2 = messageEntry("e2", "b");
      const e3 = messageEntry("e3", "c");
      await h.append(e1);
      await h.append(e2);
      await h.append(e3);

      const result = await h.compact(summarizeCompact());
      expect(result.entriesBefore).toBe(3);
      expect(result.entriesAfter).toBe(1);
      expect(result.source).toBe("persisted");

      // Nothing that was in the log was rewritten or removed…
      expect(h.readPersisted().slice(0, 3)).toEqual([e1, e2, e3]);
      // …and the summary is now durable rather than a projection-only artifact.
      expect(h.readPersisted()).toHaveLength(4);
      expect(h.read().entries).toHaveLength(1);
      await h.close();
    });

    it("compact() fires subscribers", async () => {
      const h = await deps.make();
      await h.append(messageEntry("e1", "a"));
      let count = 0;
      h.subscribe(() => count++);
      await h.compact(summarizeCompact());
      expect(count).toBe(1);
      await h.close();
    });

    it("compact() records lastCompaction as projection provenance", async () => {
      const h = await deps.make();
      await h.append(messageEntry("e1", "a"));
      await h.append(messageEntry("e2", "b"));
      await h.compact(summarizeCompact());
      const meta = h.lastCompaction();
      expect(meta).toBeDefined();
      expect(meta!.source).toBe("persisted");
      expect(meta!.entriesBefore).toBe(2);
      expect(meta!.entriesAfter).toBe(1);
      expect(meta!.strategyMetadata).toEqual({ strategy: "summarize" });
      await h.close();
    });

    it("compact() with source: 'projection' reads from current projection", async () => {
      const h = await deps.make();
      await h.append(messageEntry("e1", "a"));
      await h.append(messageEntry("e2", "b"));
      // First compaction: 2 -> 1
      await h.compact(summarizeCompact());
      // Second compaction sourcing from projection: 1 -> 1 (summary of summary)
      const r = await h.compact({
        source: "projection",
        run: async ({ entries }) => entries,
      });
      expect(r.entriesBefore).toBe(1);
      expect(r.source).toBe("projection");
      await h.close();
    });
  });

  describe("TimelineHarness — replaceProjection / resetProjection", () => {
    it("replaceProjection() overwrites projection; log untouched", async () => {
      const h = await deps.make();
      await h.append(messageEntry("e1", "a"));
      await h.append(messageEntry("e2", "b"));
      const replacement = [messageEntry("r1", "replaced")];
      await h.replaceProjection({ entries: replacement });
      expect(h.read().entries).toEqual(replacement);
      expect(h.readPersisted()).toHaveLength(2);
      await h.close();
    });

    it("resetProjection() rebuilds projection as a mirror of log", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      const e2 = messageEntry("e2", "b");
      await h.append(e1);
      await h.append(e2);
      await h.compact(summarizeCompact());
      expect(h.read().entries).toHaveLength(1);
      await h.resetProjection();
      // Back to a mirror of the log — which now records that a compaction
      // happened, alongside the turns it covered.
      expect(h.read().entries.slice(0, 2)).toEqual([e1, e2]);
      expect(h.read().entries).toHaveLength(3);
      await h.close();
    });

    it("resetProjection() clears lastCompaction", async () => {
      const h = await deps.make();
      await h.append(messageEntry("e1", "a"));
      await h.compact(summarizeCompact());
      expect(h.lastCompaction()).toBeDefined();
      await h.resetProjection();
      expect(h.lastCompaction()).toBeUndefined();
      await h.close();
    });
  });

  // ── GENESIS (ADR 93) — optional section, lit by `makeFromDefinition` ──
  //
  // Registered via `describe.skipIf` (the same discipline `it.skipIf` gives the
  // store suite's capability gates) so an implementation that cannot build from
  // a definition reports the section as SKIPPED rather than silently omitting it.
  const makeFromDefinition =
    deps.makeFromDefinition ??
    ((): never => {
      throw new Error("unreachable: the genesis section is skipped without a factory");
    });
  describe.skipIf(deps.makeFromDefinition === undefined)(
    "TimelineHarness — genesis seam (ADR 93)",
    () => {
      it("hydrate() seeds both tiers from the hydrator's return", async () => {
        const seed = [messageEntry("g1", "a"), messageEntry("g2", "b")];
        const h = await makeFromDefinition({ hydrate: async () => seed });
        expect(h.readPersisted()).toEqual([]);
        await h.hydrate();
        expect(h.readPersisted()).toEqual(seed);
        expect(h.read().entries).toEqual(seed);
        await h.close();
      });

      it("THE SEED LAW: genesis entries never reach the store's append", async () => {
        // The #1 adopter footgun (a hydrator whose output is written back
        // duplicates the log on every resume). The store is spied end-to-end:
        // after genesis + a flush barrier, `append` must not have been called.
        const store = new MemoryTimelineStore();
        const appended: TimelineEntry[][] = [];
        const spy: TimelineStore = Object.assign(Object.create(store) as TimelineStore, {
          append: (key: string, entries: readonly TimelineEntry[], ctx: never) => {
            appended.push([...entries]);
            return store.append(key, entries, ctx);
          },
        });
        const h = await makeFromDefinition({
          store: spy,
          hydrate: async () => [messageEntry("g1", "a"), messageEntry("g2", "b")],
        });
        await h.hydrate();
        await h.flush();
        expect(appended).toEqual([]);
        expect(h.readPersisted()).toHaveLength(2);
        // A subsequent real append DOES reach the store — genesis is the only
        // thing exempt.
        await h.append(messageEntry("live", "c"));
        await h.flush();
        expect(appended.flat().map((e) => (e.kind === "message" ? e.message.id : ""))).toEqual([
          "live",
        ]);
        await h.close();
      });

      it("a throwing hydrator surfaces TimelineHydrateFailed (no half-genesis)", async () => {
        const boom = new Error("catalog unreachable");
        const h = await makeFromDefinition({
          hydrate: () => Promise.reject(boom),
        });
        await expect(h.hydrate()).rejects.toBeInstanceOf(TimelineHydrateFailed);
        // Nothing was installed — the harness is empty, not partially seeded.
        expect(h.readPersisted()).toEqual([]);
        await h.close();
      });

      it("no store and no hydrator ⇒ genesis is a no-op", async () => {
        const h = await makeFromDefinition({});
        await h.hydrate();
        expect(h.readPersisted()).toEqual([]);
        await h.close();
      });
    },
  );

  // ── CHECKPOINT (checkpointing §3.2) — optional section, same factory ──
  describe.skipIf(deps.makeFromDefinition === undefined)(
    "TimelineHarness — checkpoint seam (checkpointing §3.2)",
    () => {
      it("is CheckpointCapable — how the session fold finds it", async () => {
        const h = await makeFromDefinition({ store: new MemoryTimelineStore() });
        expect(isCheckpointCapable(h)).toBe(true);
        await h.close();
      });

      it("THE STORE OUTLIVES THE HARNESS: persist → hydrate on a fresh instance", async () => {
        // The evict→resume shape. Durability across instances exists ONLY
        // because the injected store survives the harness that wrote to it —
        // nothing is retained by, or carried out of, harness A.
        const store = new MemoryTimelineStore();
        const scopeId = "checkpoint-round-trip";
        const a = await makeFromDefinition({ store }, scopeId);
        await a.append(messageEntry("c1", "one"), messageEntry("c2", "two"));
        await a.persist();
        await a.close();

        const b = await makeFromDefinition({ store }, scopeId);
        expect(b.readPersisted()).toEqual([]);
        await b.hydrate();
        expect(b.readPersisted().map(entryId)).toEqual(["c1", "c2"]);
        expect(b.read().entries.map(entryId)).toEqual(["c1", "c2"]);
        await b.close();
      });

      it("hydrate REPLACES the projection with the store's contents for the scope", async () => {
        // Not a merge and not an append: a diverged projection (a compaction)
        // rebuilds from the resumed log, and re-hydrating twice is idempotent.
        const store = new MemoryTimelineStore();
        const h = await makeFromDefinition({ store });
        await h.append(messageEntry("r1", "one"));
        await h.persist();
        await h.replaceProjection({ entries: [messageEntry("folded", "summary")] });
        expect(h.read().entries.map(entryId)).toEqual(["folded"]);

        await h.hydrate();
        expect(h.read().entries.map(entryId)).toEqual(["r1"]);
        await h.hydrate();
        expect(h.readPersisted().map(entryId)).toEqual(["r1"]);
        await h.close();
      });

      it("a store-less harness persists and hydrates without effect", async () => {
        const h = await makeFromDefinition({});
        await h.append(messageEntry("m1", "one"));
        await h.persist();
        await h.hydrate();
        expect(h.readPersisted().map(entryId)).toEqual(["m1"]);
        await h.close();
      });

      it("a rejected persist propagates — the caller must not unmount behind it", async () => {
        const store = new MemoryTimelineStore();
        const failing: TimelineStore = Object.assign(Object.create(store) as TimelineStore, {
          append: () => Promise.reject(new Error("store append boom")),
        });
        const h = await makeFromDefinition({ store: failing });
        await h.append(messageEntry("lost", "one"));
        await expect(h.persist()).rejects.toBeInstanceOf(TimelineWriteFailed);
        await h.close().catch(() => undefined);
      });
    },
  );

  describe("TimelineHarness — turn boundaries + trailing-input fold (ADR 53)", () => {
    const userEntry = (id: string): TimelineEntry => ({
      kind: "message",
      message: { id, role: "user", content: [{ type: "text", text: id }], ts: 0 },
    });
    const assistantEntry = (id: string): TimelineEntry => ({
      kind: "message",
      message: { id, role: "assistant", content: [{ type: "text", text: id }], ts: 0 },
    });
    /** The boundary `endTurn` just appended — narrowed, so a claim can read it. */
    const lastBoundary = (h: TimelineHarnessProtocol): TurnBoundaryEntry["boundary"] => {
      const persisted = h.readPersisted();
      const entry = persisted[persisted.length - 1]!;
      if (entry.kind !== "boundary") throw new Error("expected a boundary entry");
      return entry.boundary;
    };

    it("trailingInput() is the input-after-last-assistant fold", async () => {
      const h = await deps.make();
      expect(h.trailingInput()).toEqual([]);
      await h.append(userEntry("u1"));
      expect(h.trailingInput().map((e) => e.message.id)).toEqual(["u1"]);
      await h.append(assistantEntry("a1"));
      expect(h.trailingInput()).toEqual([]);
      await h.append(userEntry("u2"), userEntry("u3"));
      expect(h.trailingInput().map((e) => e.message.id)).toEqual(["u2", "u3"]);
      expect(h.inputEntryCount()).toBe(3);
      await h.close();
    });

    it("endTurn() appends a boundary RECORD; load-bearing nowhere", async () => {
      const h = await deps.make();
      await h.append(userEntry("u1"));
      await h.endTurn({ executionId: "e1", outcome: "succeeded" });
      const persisted = h.readPersisted();
      const boundary = persisted[persisted.length - 1]!;
      expect(boundary.kind).toBe("boundary");
      if (boundary.kind !== "boundary") throw new Error("unreachable");
      expect(boundary.boundary.outcome).toBe("succeeded");
      expect(boundary.visibility).toBe("log");
      // The fold ignores boundaries — u1 still trails (no
      // assistant entry): the record commits nothing.
      expect(h.trailingInput().map((e) => e.message.id)).toEqual(["u1"]);
      await h.close();
    });

    it("failed and aborted turns are recorded as facts", async () => {
      const h = await deps.make();
      await h.endTurn({
        executionId: "e2",
        outcome: "failed",
        usage: { inputTokens: 5, outputTokens: 0, totalTokens: 5 },
      });
      const persisted = h.readPersisted();
      const boundary = persisted[persisted.length - 1]!;
      if (boundary.kind !== "boundary") throw new Error("expected boundary");
      expect(boundary.boundary.outcome).toBe("failed");
      expect(boundary.boundary.usage?.totalTokens).toBe(5);
      await h.close();
    });

    it("a failed turn records WHY, not just that it failed", async () => {
      // A turn that dies before its first tick appends no assistant entry, so
      // this boundary is the only durable evidence the turn happened at all. An
      // outcome with no cause tells a reloaded client that something failed and
      // nothing more — which is what shipped first, and what left a failed turn
      // unexplainable from the client side.
      const h = await deps.make();
      await h.endTurn({
        executionId: "e3",
        outcome: "failed",
        stopCause: { kind: "failed", error: { _tag: "ProviderRejected", message: "no key" } },
      });
      const boundary = lastBoundary(h);
      expect(boundary.stopCause?.kind).toBe("failed");
      if (boundary.stopCause?.kind !== "failed") throw new Error("expected a failure cause");
      expect(boundary.stopCause.error.message).toBe("no key");
      expect(boundary.stopCause.error._tag).toBe("ProviderRejected");
      await h.close();
    });

    it("a VETOED turn is its own outcome, carrying the guard's reason", async () => {
      // Not folded into `failed`, and emphatically not recorded as `succeeded`
      // (which is what happened before the outcome had this member): a turn a
      // guard refused is not a turn that broke and not a turn that answered. The
      // cause is a reason string, never an error — a veto is the policy WORKING,
      // and typing it as a failure would make every error-rate metric count it.
      const h = await deps.make();
      await h.endTurn({
        executionId: "e5",
        outcome: "vetoed",
        stopCause: { kind: "vetoed", reason: "monthly budget exhausted" },
      });
      const boundary = lastBoundary(h);
      expect(boundary.outcome).toBe("vetoed");
      if (boundary.stopCause?.kind !== "vetoed") throw new Error("expected a veto cause");
      expect(boundary.stopCause.reason).toBe("monthly budget exhausted");
      await h.close();
    });

    it("a succeeded turn carries no cause at all", async () => {
      const h = await deps.make();
      await h.endTurn({ executionId: "e4", outcome: "succeeded" });
      expect("stopCause" in lastBoundary(h)).toBe(false);
      await h.close();
    });
  });

  describe("TimelineHarness — identity stability", () => {
    it("read() returns same snapshot reference between mutations", async () => {
      const h = await deps.make();
      const a = h.read();
      const b = h.read();
      expect(a).toBe(b);
      await h.close();
    });
  });
}

// Re-export the factory helper so unit-test files (not just adopters)
// can reuse it.
export { messageEntry, summarizeCompact, identityCompact };
