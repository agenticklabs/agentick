/**
 * `MemoryCollection` generic — verified directly (its adoption by the task
 * store is verified end-to-end by `runTaskStoreConformance` in
 * `@agentick/tasks-next`). Also drives `runStoreConformance` against a tiny
 * throwaway record type to prove the shared skeleton is store-agnostic.
 */

import { describe, expect, it } from "vitest";

import { MemoryCollection } from "../memory-collection.js";
import { runStoreConformance } from "../store-conformance.js";

interface Row {
  readonly id: string;
  readonly group: string;
  readonly n: number;
}

interface RowQuery {
  readonly group?: string;
}

function rows(): MemoryCollection<Row, RowQuery, number> {
  return new MemoryCollection<Row, RowQuery, number>({
    backend: "memory",
    keyOf: (r) => r.id,
    matchQuery: (r, q) => q?.group === undefined || r.group === q.group,
    prunePredicate: (r, cutoff) => r.n < cutoff,
  });
}

describe("MemoryCollection", () => {
  it("put upserts in place and get round-trips", async () => {
    const c = rows();
    await c.put({ id: "a", group: "g1", n: 1 });
    await c.put({ id: "a", group: "g1", n: 2 });
    expect(await c.get("a")).toEqual({ id: "a", group: "g1", n: 2 });
    expect(await c.list()).toHaveLength(1);
  });

  it("get returns undefined for an unknown key", async () => {
    expect(await rows().get("nope")).toBeUndefined();
  });

  it("list() with no query returns every record; a query filters", async () => {
    const c = rows();
    await c.put({ id: "a", group: "g1", n: 1 });
    await c.put({ id: "b", group: "g2", n: 2 });
    expect((await c.list()).map((r) => r.id).sort()).toEqual(["a", "b"]);
    expect((await c.list({ group: "g1" })).map((r) => r.id)).toEqual(["a"]);
  });

  it("list() returns a fresh array — mutating it never mutates the store", async () => {
    const c = rows();
    await c.put({ id: "a", group: "g1", n: 1 });
    const first = await c.list();
    (first as Row[]).push({ id: "rogue", group: "g1", n: 9 });
    expect(await c.list()).toHaveLength(1);
  });

  it("delete removes and reports whether the key existed", async () => {
    const c = rows();
    await c.put({ id: "a", group: "g1", n: 1 });
    expect(await c.delete("a")).toBe(true);
    expect(await c.get("a")).toBeUndefined();
    expect(await c.delete("a")).toBe(false);
  });

  it("prune is present only when a prunePredicate is configured", () => {
    expect(typeof rows().prune).toBe("function");
    const noPrune = new MemoryCollection<Row, RowQuery>({
      backend: "memory",
      keyOf: (r) => r.id,
      matchQuery: () => true,
    });
    expect(noPrune.prune).toBeUndefined();
  });

  it("prune drops every record the predicate selects", async () => {
    const c = rows();
    await c.put({ id: "a", group: "g1", n: 1 });
    await c.put({ id: "b", group: "g1", n: 5 });
    await c.prune!(3);
    expect((await c.list()).map((r) => r.id)).toEqual(["b"]);
  });
});

// The shared skeleton, exercised against MemoryCollection directly.
runStoreConformance<MemoryCollection<Row, RowQuery, number>>({
  label: "MemoryCollection<Row>",
  factory: rows,
  emptyRead: { read: (store, key) => store.get(key), expected: undefined },
  idempotentDelete: (store, key) => store.delete(key),
  cases: ({ setup }) => {
    it("shared skeleton nests store-specific cases under its describe", async () => {
      const store = await setup();
      await store.put({ id: "a", group: "g1", n: 1 });
      expect((await store.list()).map((r) => r.id)).toEqual(["a"]);
    });
  },
});
