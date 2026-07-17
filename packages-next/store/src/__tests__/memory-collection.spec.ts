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

describe("MemoryCollection.onChange", () => {
  it("fires on put (insert) with value and no prev", async () => {
    const c = rows();
    const events: Array<{ key: string; value?: Row; prev?: Row }> = [];
    c.onChange((ch) => events.push(ch));
    await c.put({ id: "a", group: "g1", n: 1 });
    expect(events).toEqual([{ key: "a", value: { id: "a", group: "g1", n: 1 } }]);
    expect("prev" in events[0]!).toBe(false);
  });

  it("fires on put (overwrite) carrying the previous value as prev", async () => {
    const c = rows();
    await c.put({ id: "a", group: "g1", n: 1 });
    const events: Array<{ key: string; value?: Row; prev?: Row }> = [];
    c.onChange((ch) => events.push(ch));
    await c.put({ id: "a", group: "g1", n: 2 });
    expect(events).toEqual([
      { key: "a", value: { id: "a", group: "g1", n: 2 }, prev: { id: "a", group: "g1", n: 1 } },
    ]);
  });

  it("fires on delete of an existing key with prev and no value", async () => {
    const c = rows();
    await c.put({ id: "a", group: "g1", n: 1 });
    const events: Array<{ key: string; value?: Row; prev?: Row }> = [];
    c.onChange((ch) => events.push(ch));
    await c.delete("a");
    expect(events).toEqual([{ key: "a", prev: { id: "a", group: "g1", n: 1 } }]);
    expect("value" in events[0]!).toBe(false);
  });

  it("does NOT fire on a no-op delete (key was absent)", async () => {
    const c = rows();
    const events: unknown[] = [];
    c.onChange((ch) => events.push(ch));
    expect(await c.delete("nope")).toBe(false);
    expect(events).toEqual([]);
  });

  it("does NOT fire on prune (no shared-store consumer needs bulk-eviction observation yet)", async () => {
    const c = rows();
    await c.put({ id: "a", group: "g1", n: 1 });
    const events: unknown[] = [];
    c.onChange((ch) => events.push(ch));
    await c.prune!(3);
    expect(events).toEqual([]);
  });

  it("returns an unsubscribe that stops future events", async () => {
    const c = rows();
    const events: unknown[] = [];
    const off = c.onChange((ch) => events.push(ch));
    await c.put({ id: "a", group: "g1", n: 1 });
    off();
    await c.put({ id: "b", group: "g1", n: 2 });
    expect(events).toHaveLength(1);
  });

  it("isolates listener errors — one throwing listener does not break the write or siblings", async () => {
    const c = rows();
    const good: string[] = [];
    c.onChange(() => {
      throw new Error("intentional");
    });
    c.onChange((ch) => good.push(ch.key));
    // The write itself must still succeed despite the throwing listener.
    await c.put({ id: "a", group: "g1", n: 1 });
    expect(await c.get("a")).toEqual({ id: "a", group: "g1", n: 1 });
    expect(good).toEqual(["a"]);
  });

  it("fans out to multiple listeners in registration order", async () => {
    const c = rows();
    const order: string[] = [];
    c.onChange(() => order.push("first"));
    c.onChange(() => order.push("second"));
    await c.put({ id: "a", group: "g1", n: 1 });
    expect(order).toEqual(["first", "second"]);
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
