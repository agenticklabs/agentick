/**
 * `CollectionProjection` — verified directly. The primitive is the sync
 * read-model over an async `CollectionStore`: sync reads, write-through
 * dual-write, and merge-hydrate that returns the loaded keys (notification is
 * the caller's, not the primitive's).
 */

import { describe, expect, it, vi } from "vitest";

import { MemoryCollection } from "../memory-collection.js";
import { CollectionProjection } from "../collection-projection.js";

interface Cell {
  readonly id: string;
  readonly value: number;
}

function store(): MemoryCollection<Cell, Record<string, never>> {
  return new MemoryCollection<Cell, Record<string, never>>({
    backend: "memory",
    keyOf: (c) => c.id,
    matchQuery: () => true,
  });
}

function projection(s: MemoryCollection<Cell, Record<string, never>> = store()): {
  proj: CollectionProjection<Cell, Record<string, never>>;
  store: typeof s;
} {
  return { proj: new CollectionProjection(s, (c) => c.id), store: s };
}

describe("CollectionProjection — sync reads reflect writes immediately", () => {
  it("getSync / hasSync see a write synchronously (no await)", () => {
    const { proj } = projection();
    expect(proj.hasSync("a")).toBe(false);
    proj.write({ id: "a", value: 1 });
    // Synchronous — reads reflect the write with no microtask turn.
    expect(proj.hasSync("a")).toBe(true);
    expect(proj.getSync("a")).toEqual({ id: "a", value: 1 });
    expect(proj.getSync("missing")).toBeUndefined();
  });

  it("write upserts in place; listSync returns a fresh array each call", () => {
    const { proj } = projection();
    proj.write({ id: "a", value: 1 });
    proj.write({ id: "a", value: 2 });
    proj.write({ id: "b", value: 3 });

    const first = proj.listSync();
    expect(first).toHaveLength(2);
    expect(new Map(first.map((c) => [c.id, c.value]))).toEqual(
      new Map([
        ["a", 2],
        ["b", 3],
      ]),
    );
    // Fresh reference each call (stable identity between reads is the caller's
    // concern via its own list cache — the primitive always allocates).
    expect(proj.listSync()).not.toBe(first);
  });
});

describe("CollectionProjection — write-through to the store", () => {
  it("mirrors the cache into the durable store off the critical path", async () => {
    const { proj, store: s } = projection();
    proj.write({ id: "a", value: 1 });
    proj.write({ id: "b", value: 2 });

    // The store is written fire-and-forget; it has caught up by the next turn.
    expect(await s.get("a")).toEqual({ id: "a", value: 1 });
    expect(await s.get("b")).toEqual({ id: "b", value: 2 });
    expect(await s.list()).toHaveLength(2);
  });

  it("a store put rejection is swallowed — the sync write still stands", () => {
    const failing: MemoryCollection<Cell, Record<string, never>> = store();
    vi.spyOn(failing, "put").mockRejectedValue(new Error("boom"));
    const proj = new CollectionProjection(failing, (c) => c.id);

    // Does not throw despite the rejected put.
    expect(() => proj.write({ id: "a", value: 1 })).not.toThrow();
    // The sync cache reflects the write regardless of the store failure.
    expect(proj.getSync("a")).toEqual({ id: "a", value: 1 });
  });
});

describe("CollectionProjection — deleteSync", () => {
  it("drops from the cache synchronously and from the store", async () => {
    const { proj, store: s } = projection();
    proj.write({ id: "a", value: 1 });

    proj.deleteSync("a");

    expect(proj.hasSync("a")).toBe(false);
    expect(proj.getSync("a")).toBeUndefined();
    expect(await s.get("a")).toBeUndefined();
  });

  it("is idempotent — deleting an absent key is a no-op", () => {
    const { proj } = projection();
    expect(() => proj.deleteSync("nope")).not.toThrow();
  });
});

describe("CollectionProjection — hydrate", () => {
  it("loads the store into the cache and returns the loaded keys", async () => {
    const s = store();
    await s.put({ id: "x", value: 10 });
    await s.put({ id: "y", value: 20 });
    const { proj } = projection(s);

    expect(proj.getSync("x")).toBeUndefined(); // store is not the sync read path

    const keys = await proj.hydrate();

    expect(new Set(keys)).toEqual(new Set(["x", "y"]));
    expect(proj.getSync("x")).toEqual({ id: "x", value: 10 });
    expect(proj.getSync("y")).toEqual({ id: "y", value: 20 });
  });

  it("MERGES (overlays) — a live write the store has not seen survives", async () => {
    const s = store();
    await s.put({ id: "fromStore", value: 1 });
    const { proj } = projection(s);
    proj.write({ id: "live", value: 2 });

    await proj.hydrate();

    expect(proj.getSync("live")).toEqual({ id: "live", value: 2 });
    expect(proj.getSync("fromStore")).toEqual({ id: "fromStore", value: 1 });
  });

  it("a fresh store hydrates to a no-op returning []", async () => {
    const { proj } = projection();
    expect(await proj.hydrate()).toEqual([]);
  });

  it("does NOT notify — returning keys is how the caller drives its own seam", async () => {
    const s = store();
    await s.put({ id: "k", value: 1 });
    const { proj } = projection(s);
    // No listener API exists on the primitive at all — the contract is that
    // the caller iterates the returned keys and fires its harness-specific
    // notifications. This test pins that the surface stays notification-free.
    const keys = await proj.hydrate();
    expect(keys).toEqual(["k"]);
    expect("onChange" in proj).toBe(false);
    expect("subscribe" in proj).toBe(false);
  });
});
