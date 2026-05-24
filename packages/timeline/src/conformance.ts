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
 *   - importSnapshot mode "persisted-only" discards projection; "rehydrate"
 *     requires + invokes a strategy
 */

import { describe, expect, it } from "vitest";
import type { CompactStrategy, TimelineEntry, TimelineHarnessProtocol } from "@agentick/spec";

export interface TimelineHarnessFactoryDeps {
  /** Construct a fresh harness. Caller MUST await `harness.ready`. */
  readonly make: () => Promise<TimelineHarnessProtocol>;
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
      await h.append({ entry: e1 });
      expect(h.readPersisted()).toEqual([e1]);
      await h.close();
    });

    it("subscribe() fires on append", async () => {
      const h = await deps.make();
      let count = 0;
      h.subscribe(() => count++);
      await h.append({ entry: messageEntry("e1", "x") });
      await h.append({ entry: messageEntry("e2", "y") });
      expect(count).toBe(2);
      await h.close();
    });

    it("subscribe() unsubscribes cleanly", async () => {
      const h = await deps.make();
      let count = 0;
      const unsub = h.subscribe(() => count++);
      await h.append({ entry: messageEntry("e1", "x") });
      unsub();
      await h.append({ entry: messageEntry("e2", "y") });
      expect(count).toBe(1);
      await h.close();
    });

    it("read() returns a new snapshot reference after each mutation", async () => {
      const h = await deps.make();
      const before = h.read();
      await h.append({ entry: messageEntry("e1", "x") });
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
      await h.append({ entry: e1 });
      await h.append({ entry: e2 });
      expect(h.readPersisted()).toEqual([e1, e2]);
      expect(h.read().entries).toEqual([e1, e2]);
      await h.close();
    });

    it("append after compact lands at the tail of the compacted projection", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      const e2 = messageEntry("e2", "b");
      await h.append({ entry: e1 });
      await h.append({ entry: e2 });
      await h.compact(summarizeCompact());
      const projBefore = h.read().entries;
      expect(projBefore).toHaveLength(1);

      const e3 = messageEntry("e3", "c");
      await h.append({ entry: e3 });
      const projAfter = h.read().entries;
      expect(projAfter).toHaveLength(2);
      expect(projAfter[1]).toEqual(e3);
      // Log still has all three.
      expect(h.readPersisted()).toHaveLength(3);
      await h.close();
    });
  });

  describe("TimelineHarness — compact", () => {
    it("compact() rewrites the projection but leaves the log intact", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      const e2 = messageEntry("e2", "b");
      const e3 = messageEntry("e3", "c");
      await h.append({ entry: e1 });
      await h.append({ entry: e2 });
      await h.append({ entry: e3 });

      const result = await h.compact(summarizeCompact());
      expect(result.entriesBefore).toBe(3);
      expect(result.entriesAfter).toBe(1);
      expect(result.source).toBe("persisted");

      // Log preserved.
      expect(h.readPersisted()).toEqual([e1, e2, e3]);
      // Projection compacted.
      expect(h.read().entries).toHaveLength(1);
      await h.close();
    });

    it("compact() fires subscribers", async () => {
      const h = await deps.make();
      await h.append({ entry: messageEntry("e1", "a") });
      let count = 0;
      h.subscribe(() => count++);
      await h.compact(summarizeCompact());
      expect(count).toBe(1);
      await h.close();
    });

    it("compact() records lastCompaction on the snapshot", async () => {
      const h = await deps.make();
      await h.append({ entry: messageEntry("e1", "a") });
      await h.append({ entry: messageEntry("e2", "b") });
      await h.compact(summarizeCompact());
      const snap = h.exportSnapshot();
      expect(snap.lastCompaction).toBeDefined();
      expect(snap.lastCompaction!.source).toBe("persisted");
      expect(snap.lastCompaction!.entriesBefore).toBe(2);
      expect(snap.lastCompaction!.entriesAfter).toBe(1);
      expect(snap.lastCompaction!.strategyMetadata).toEqual({ strategy: "summarize" });
      await h.close();
    });

    it("compact() with source: 'projection' reads from current projection", async () => {
      const h = await deps.make();
      await h.append({ entry: messageEntry("e1", "a") });
      await h.append({ entry: messageEntry("e2", "b") });
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
      await h.append({ entry: messageEntry("e1", "a") });
      await h.append({ entry: messageEntry("e2", "b") });
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
      await h.append({ entry: e1 });
      await h.append({ entry: e2 });
      await h.compact(summarizeCompact());
      expect(h.read().entries).toHaveLength(1);
      await h.resetProjection();
      expect(h.read().entries).toEqual([e1, e2]);
      await h.close();
    });

    it("resetProjection() clears lastCompaction", async () => {
      const h = await deps.make();
      await h.append({ entry: messageEntry("e1", "a") });
      await h.compact(summarizeCompact());
      expect(h.exportSnapshot().lastCompaction).toBeDefined();
      await h.resetProjection();
      expect(h.exportSnapshot().lastCompaction).toBeUndefined();
      await h.close();
    });
  });

  describe("TimelineHarness — snapshot / restore", () => {
    it("exportSnapshot captures log + projection + versions + provenance", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      const e2 = messageEntry("e2", "b");
      await h.append({ entry: e1 });
      await h.append({ entry: e2 });
      await h.compact(summarizeCompact());

      const snap = h.exportSnapshot();
      expect(snap.persisted).toEqual([e1, e2]);
      expect(snap.projection).toHaveLength(1);
      expect(snap.persistedVersion).toBe(2);
      expect(snap.projectionVersion).toBeGreaterThanOrEqual(3);
      expect(snap.lastCompaction).toBeDefined();
      await h.close();
    });

    it("importSnapshot 'as-is' restores everything verbatim", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      await h.importSnapshot({
        persisted: [e1],
        projection: [messageEntry("custom-projection", "x")],
        persistedVersion: 1,
        projectionVersion: 5,
      });
      expect(h.readPersisted()).toEqual([e1]);
      expect(h.read().entries[0]?.kind).toBe("message");
      expect((h.read().entries[0] as { message: { id: string } }).message.id).toBe(
        "custom-projection",
      );
      await h.close();
    });

    it("importSnapshot 'persisted-only' discards the snapshot projection", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      await h.importSnapshot(
        {
          persisted: [e1],
          projection: [messageEntry("ignored", "x")],
          persistedVersion: 1,
          projectionVersion: 5,
          lastCompaction: {
            at: Date.now(),
            source: "persisted",
            entriesBefore: 1,
            entriesAfter: 1,
          },
        },
        { mode: "persisted-only" },
      );
      expect(h.read().entries).toEqual([e1]);
      expect(h.exportSnapshot().lastCompaction).toBeUndefined();
      await h.close();
    });

    it("importSnapshot 'rehydrate' requires a strategy + re-runs it", async () => {
      const h = await deps.make();
      const e1 = messageEntry("e1", "a");
      const e2 = messageEntry("e2", "b");
      const snapshot = {
        persisted: [e1, e2],
        projection: [messageEntry("stale", "x")],
        persistedVersion: 2,
        projectionVersion: 5,
        lastCompaction: {
          at: Date.now(),
          source: "persisted" as const,
          entriesBefore: 2,
          entriesAfter: 1,
          strategyMetadata: { strategy: "summarize" },
        },
      };
      await h.importSnapshot(snapshot, {
        mode: "rehydrate",
        rehydrateStrategy: summarizeCompact(),
      });
      // The summarize strategy collapses to 1 entry that mentions count.
      expect(h.read().entries).toHaveLength(1);
      const summary = h.read().entries[0] as unknown as {
        message: { content: readonly { type: string; text: string }[] };
      };
      expect(summary.message.content[0]!.text).toContain("2 entries");
      await h.close();
    });

    it("importSnapshot 'rehydrate' throws when strategy is missing", async () => {
      const h = await deps.make();
      await expect(
        h.importSnapshot(
          { persisted: [], projection: [], persistedVersion: 0, projectionVersion: 0 },
          { mode: "rehydrate" },
        ),
      ).rejects.toMatchObject({ _tag: "RehydrateStrategyMissing" });
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
