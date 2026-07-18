/**
 * `MemoryLog` generic — verified directly (its adoption by the timeline store is
 * verified end-to-end by `runTimelineStoreConformance` in
 * `@agentick/timeline-next`). Also drives `runStoreConformance` against a tiny
 * throwaway entry type to prove the shared skeleton is store-agnostic for the
 * **log** archetype — the first non-collection archetype the skeleton meets.
 */

import { describe, expect, it } from "vitest";

import { MemoryLog } from "../memory-log.js";
import { runStoreConformance } from "../store-conformance.js";

interface Row {
  readonly id: string;
}

const row = (id: string): Row => ({ id });
const ids = (entries: readonly Row[]): string[] => entries.map((e) => e.id);

describe("MemoryLog", () => {
  it("append then read round-trips entries in order", async () => {
    const log = new MemoryLog<Row>();
    await log.append("l1", [row("a"), row("b")]);
    await log.append("l1", [row("c")]);
    expect(ids(await log.read("l1"))).toEqual(["a", "b", "c"]);
  });

  it("read() returns [] for an unknown log key", async () => {
    expect(await new MemoryLog<Row>().read("never-seen")).toEqual([]);
  });

  it("append([]) is a no-op and returns no seqs", async () => {
    const log = new MemoryLog<Row>();
    expect(await log.append("l1", [])).toEqual([]);
    expect(await log.read("l1")).toEqual([]);
  });

  it("append assigns one seq per entry, strictly increasing and never reused", async () => {
    const log = new MemoryLog<Row>();
    const first = await log.append("l1", [row("a"), row("b")]);
    const second = await log.append("l1", [row("c")]);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    const all = [...first, ...second];
    for (let i = 1; i < all.length; i++) expect(all[i]).toBeGreaterThan(all[i - 1]!);
  });

  it("read() returns a defensive copy — mutating the result never mutates the log", async () => {
    const log = new MemoryLog<Row>();
    await log.append("l1", [row("a")]);
    const first = await log.read("l1");
    (first as Row[]).push(row("rogue"));
    expect(ids(await log.read("l1"))).toEqual(["a"]);
  });

  it("isolates entries across log keys (no bleed)", async () => {
    const log = new MemoryLog<Row>();
    await log.append("l1", [row("a")]);
    await log.append("l2", [row("x")]);
    expect(ids(await log.read("l1"))).toEqual(["a"]);
    expect(ids(await log.read("l2"))).toEqual(["x"]);
  });

  it("keys() enumerates only log keys that hold entries", async () => {
    const log = new MemoryLog<Row>();
    await log.append("l1", [row("a")]);
    await log.append("l2", [row("b")]);
    expect([...(await log.keys())].sort()).toEqual(["l1", "l2"]);
  });

  it("delete() removes a log and is idempotent", async () => {
    const log = new MemoryLog<Row>();
    await log.append("l1", [row("a")]);
    expect(await log.delete("l1")).toBe(true);
    expect(await log.read("l1")).toEqual([]);
    expect(await log.keys()).not.toContain("l1");
    expect(await log.delete("l1")).toBe(false);
  });

  it("configures its backend label (default 'memory')", () => {
    expect(new MemoryLog<Row>().backend).toBe("memory");
    expect(new MemoryLog<Row>({ backend: "custom" }).backend).toBe("custom");
  });

  describe("history()", () => {
    it("pages by seq: fromSeq (inclusive) + limit, seq-tagged, in order", async () => {
      const log = new MemoryLog<Row>();
      const seqs = await log.append("l1", [row("a"), row("b"), row("c"), row("d")]);
      const all = await log.history("l1");
      expect(all.map((t) => t.seq)).toEqual([...seqs]);
      expect(all.map((t) => t.entry.id)).toEqual(["a", "b", "c", "d"]);
      const fromSecond = await log.history("l1", { fromSeq: seqs[1]! });
      expect(fromSecond.map((t) => t.entry.id)).toEqual(["b", "c", "d"]);
      const page = await log.history("l1", { fromSeq: seqs[1]!, limit: 2 });
      expect(page.map((t) => t.entry.id)).toEqual(["b", "c"]);
    });

    it("returns [] for an unknown log key", async () => {
      expect(await new MemoryLog<Row>().history("nope")).toEqual([]);
    });
  });

  describe("prune()", () => {
    it("erases entries below an ABSOLUTE seq and returns the count", async () => {
      const log = new MemoryLog<Row>();
      const [, , sc] = await log.append("l1", [row("a"), row("b"), row("c"), row("d")]);
      expect(await log.prune("l1", { seq: sc! })).toBe(2);
      expect(ids(await log.read("l1"))).toEqual(["c", "d"]);
    });

    it("is by absolute seq — survivors keep their seq, appends never reuse", async () => {
      const log = new MemoryLog<Row>();
      const seqs = await log.append("l1", [row("a"), row("b"), row("c"), row("d")]);
      await log.prune("l1", { seq: seqs[2]! });
      const [se] = await log.append("l1", [row("e")]);
      expect(se).toBeGreaterThan(seqs[3]!);
      const survivors = await log.history("l1", { fromSeq: 0 });
      expect(survivors.map((t) => t.seq)).toEqual([seqs[2], seqs[3], se]);
    });

    it("prune-to-empty keeps the seq counter — a later append does not restart", async () => {
      const log = new MemoryLog<Row>();
      const seqs = await log.append("l1", [row("a"), row("b")]);
      await log.prune("l1", { seq: seqs[1]! + 1 });
      expect(await log.read("l1")).toEqual([]);
      const [sc] = await log.append("l1", [row("c")]);
      expect(sc).toBeGreaterThan(seqs[1]!);
    });

    it("on an unknown log key returns 0", async () => {
      expect(await new MemoryLog<Row>().prune("nope", { seq: 5 })).toBe(0);
    });
  });
});

// The shared skeleton, exercised against MemoryLog directly — proving the
// store-agnostic trio (backend-id, empty-read→[], idempotent-delete) works for
// the LOG archetype (empty value is `[]`, not `undefined`).
runStoreConformance<MemoryLog<Row>>({
  label: "MemoryLog<Row>",
  factory: () => new MemoryLog<Row>(),
  emptyRead: { read: (store, key) => store.read(key), expected: [] },
  idempotentDelete: (store, key) => store.delete(key),
  cases: ({ setup }) => {
    it("shared skeleton nests log-specific cases under its describe", async () => {
      const log = await setup();
      await log.append("l1", [row("a")]);
      expect(ids(await log.read("l1"))).toEqual(["a"]);
    });
  },
});
