/**
 * `View` — verified directly. The harness-side sync projection of a
 * `Store`: sync reads, single-mutation write/delete (notify + typed
 * change), and the CHANGE-SILENT bulk paths (replace, hydrate). The seam is
 * load-bearing here on purpose — the view drives the store through
 * `query`/`mutate` (never `get`/`list`/`put`/`delete`), so a store that ONLY
 * implements `Store` works.
 */

import { describe, expect, it, vi } from "vitest";

import type { ChangeEvent } from "@agentick/pubsub";
import type { CollectionMutation, Store, StoreCtx } from "@agentick/spec";

import { MemoryCollection } from "../memory-collection.js";
import { View } from "../view.js";
import { stubStoreCtx } from "../stub-store-ctx.js";

interface Cell {
  readonly id: string;
  readonly value: unknown;
}

function store(): MemoryCollection<Cell, Record<string, never>> {
  return new MemoryCollection<Cell, Record<string, never>>({
    backend: "memory",
    keyOf: (c) => c.id,
    matchQuery: () => true,
  });
}

function view(s: MemoryCollection<Cell, Record<string, never>> = store()): {
  v: View<Cell, Cell, Record<string, never>, CollectionMutation<Cell>>;
  store: typeof s;
} {
  return { v: View.collection(s, (c) => c.id), store: s };
}

describe("View — sync reads reflect writes immediately", () => {
  it("getSync / hasSync / listSync see a write synchronously (no await)", () => {
    const { v } = view();
    expect(v.hasSync("a")).toBe(false);
    v.write({ id: "a", value: 1 }, stubStoreCtx());
    expect(v.hasSync("a")).toBe(true);
    expect(v.getSync("a")).toEqual({ id: "a", value: 1 });
    expect(v.listSync()).toEqual([{ id: "a", value: 1 }]);
  });
});

describe("View — write fires notify + a typed change", () => {
  it("pings the key (keyed + wildcard) and emits add-then-update by cache PRESENCE", () => {
    const { v } = view();
    const keyed = vi.fn();
    const all = vi.fn();
    const changes: ChangeEvent<Cell>[] = [];
    v.subscribe("a", keyed);
    v.subscribeAll(all);
    v.onChange((c) => changes.push(c));

    v.write({ id: "a", value: 1 }, stubStoreCtx());
    v.write({ id: "a", value: 2 }, stubStoreCtx());

    expect(keyed).toHaveBeenCalledTimes(2);
    expect(all).toHaveBeenCalledTimes(2);
    expect(changes).toEqual([
      { key: "a", value: { id: "a", value: 1 } }, // add — no prev
      { key: "a", value: { id: "a", value: 2 }, prev: { id: "a", value: 1 } }, // update — carries prev
    ]);
  });

  it("write-through drives the store via the seam (mutate), readable via query", async () => {
    const s = store();
    const putSpy = vi.spyOn(s, "put");
    const mutateSpy = vi.spyOn(s, "mutate");
    const { v } = view(s);

    v.write({ id: "x", value: "hello" }, stubStoreCtx());

    // The view calls the SEAM (mutate), not the profile method (put) directly.
    expect(mutateSpy).toHaveBeenCalledWith({ put: { id: "x", value: "hello" } }, expect.anything());
    expect(putSpy).toHaveBeenCalledTimes(1); // mutate delegates to put internally
    expect(await s.query(undefined, stubStoreCtx())).toEqual([{ id: "x", value: "hello" }]);
  });
});

describe("View — delete is idempotent", () => {
  it("returns true + emits a removal (prev carried, value omitted) on a real delete", () => {
    const { v } = view();
    v.write({ id: "a", value: 1 }, stubStoreCtx());
    const changes: ChangeEvent<Cell>[] = [];
    v.onChange((c) => changes.push(c));

    expect(v.deleteSync("a", stubStoreCtx())).toBe(true);
    expect(v.hasSync("a")).toBe(false);
    expect(changes).toEqual([{ key: "a", prev: { id: "a", value: 1 } }]);
  });

  it("returns false + fires nothing when the key was absent", () => {
    const { v } = view();
    const keyed = vi.fn();
    const changes: ChangeEvent<Cell>[] = [];
    v.subscribe("gone", keyed);
    v.onChange((c) => changes.push(c));

    expect(v.deleteSync("gone", stubStoreCtx())).toBe(false);
    expect(keyed).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });
});

describe("View — undefined-value classification rides cache presence", () => {
  it("set(undefined) on a NEW key is an add; a later set is an update (not misread by prev!==undefined)", () => {
    const { v } = view();
    const changes: ChangeEvent<Cell>[] = [];
    v.onChange((c) => changes.push(c));

    v.write({ id: "u", value: undefined }, stubStoreCtx()); // new key, value IS undefined
    v.write({ id: "u", value: 5 }, stubStoreCtx()); // key existed → update

    expect(changes).toHaveLength(2);
    expect("prev" in changes[0]!).toBe(false); // add — prev omitted
    expect("prev" in changes[1]!).toBe(true); // update — prev present
    expect(changes[1]!.prev).toEqual({ id: "u", value: undefined });
    // Presence is a key fact, independent of the stored `undefined`.
    expect(v.hasSync("u")).toBe(true);
  });
});

describe("View — hydrate merges + notifies (change-silent)", () => {
  it("merges a pre-seeded store into the cache and pings each loaded key", async () => {
    const s = store();
    await s.put({ id: "a", value: 1 }, stubStoreCtx());
    await s.put({ id: "b", value: 2 }, stubStoreCtx());
    const { v } = view(s);
    const changes: ChangeEvent<Cell>[] = [];
    const pings: string[] = [];
    v.onChange((c) => changes.push(c));
    v.subscribe("a", () => pings.push("a"));
    v.subscribe("b", () => pings.push("b"));

    const loaded = await v.hydrate(undefined, stubStoreCtx());

    expect(new Set(loaded)).toEqual(new Set(["a", "b"]));
    expect(v.getSync("a")).toEqual({ id: "a", value: 1 });
    expect(new Set(pings)).toEqual(new Set(["a", "b"]));
    expect(changes).toEqual([]); // bulk hydrate is change-silent
  });

  it("overlays the cache (does not clear a live record the store has not seen)", async () => {
    const s = store();
    await s.put({ id: "fromStore", value: "s" }, stubStoreCtx());
    const { v } = view(s);
    v.write({ id: "live", value: "l" }, stubStoreCtx());

    await v.hydrate(undefined, stubStoreCtx());

    expect(v.getSync("live")).toEqual({ id: "live", value: "l" });
    expect(v.getSync("fromStore")).toEqual({ id: "fromStore", value: "s" });
  });

  it("replace:true makes the store the authority — a cache-only record is dropped and pinged", async () => {
    const s = store();
    await s.put({ id: "fromStore", value: "s" }, stubStoreCtx());
    const { v } = view(s);
    v.seedSync({ id: "cacheOnly", value: "c" });
    const pings: string[] = [];
    const changes: ChangeEvent<Cell>[] = [];
    v.onChange((c) => changes.push(c));
    v.subscribe("cacheOnly", () => pings.push("cacheOnly"));
    const mutate = vi.spyOn(s, "mutate");

    await v.hydrate(undefined, stubStoreCtx(), { replace: true });

    expect(v.hasSync("cacheOnly")).toBe(false);
    expect(v.getSync("fromStore")).toEqual({ id: "fromStore", value: "s" });
    expect(pings).toEqual(["cacheOnly"]);
    // The drop is cache-only — nothing was deleted from the store.
    expect(mutate).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
  });
});

describe("View — replace drops + adds (change-silent)", () => {
  it("deletes keys absent from the new set, upserts present ones, pings the union", () => {
    const { v } = view();
    v.write({ id: "keep", value: 1 }, stubStoreCtx());
    v.write({ id: "drop", value: 2 }, stubStoreCtx());
    const pings = new Set<string>();
    const changes: ChangeEvent<Cell>[] = [];
    v.subscribeAll(() => {}); // wildcard presence
    for (const k of ["keep", "drop", "new"]) v.subscribe(k, () => pings.add(k));
    v.onChange((c) => changes.push(c));

    v.replace(
      [
        { id: "keep", value: 9 },
        { id: "new", value: 3 },
      ],
      stubStoreCtx(),
    );

    expect(v.hasSync("drop")).toBe(false);
    expect(v.getSync("keep")).toEqual({ id: "keep", value: 9 });
    expect(v.getSync("new")).toEqual({ id: "new", value: 3 });
    expect(pings).toEqual(new Set(["keep", "drop", "new"])); // union of dropped + upserted
    expect(changes).toEqual([]); // bulk replace is change-silent
  });

  it("mirrors the replace into the store through the seam", async () => {
    const s = store();
    const { v } = view(s);
    v.write({ id: "old", value: 1 }, stubStoreCtx());

    v.replace([{ id: "new", value: 2 }], stubStoreCtx());

    const rows = await s.query(undefined, stubStoreCtx());
    expect(rows).toEqual([{ id: "new", value: 2 }]);
  });
});

describe("View — cache value ≠ stored record (the fused case)", () => {
  interface Rec {
    readonly id: string;
    readonly n: number;
  }
  // The cache value carries the record PLUS a non-serializable live handle that
  // must never reach the store.
  interface Wrapper {
    readonly record: Rec;
    readonly handle: () => void;
  }

  function fusedStore(): MemoryCollection<Rec, Record<string, never>> {
    return new MemoryCollection<Rec, Record<string, never>>({
      backend: "memory",
      keyOf: (r) => r.id,
      matchQuery: () => true,
    });
  }

  function fused(
    s: MemoryCollection<Rec, Record<string, never>> = fusedStore(),
  ): View<Wrapper, Rec, Record<string, never>, CollectionMutation<Rec>> {
    return new View<Wrapper, Rec, Record<string, never>, CollectionMutation<Rec>>({
      store: s,
      keyOf: (w) => w.record.id,
      project: (w) => w.record, // strips the live handle
      toPut: (r) => ({ put: r }),
      toDelete: (k) => ({ delete: k }),
      reconstruct: (r) => ({ record: r, handle: () => {} }),
    });
  }

  it("write persists ONLY the projected record; getSync returns the wrapper", async () => {
    const s = fusedStore();
    const mutateSpy = vi.spyOn(s, "mutate");
    const v = fused(s);
    const w: Wrapper = { record: { id: "a", n: 1 }, handle: () => {} };

    v.write(w, stubStoreCtx());

    // Sync read returns the WRAPPER (handle intact).
    expect(v.getSync("a")).toBe(w);
    // The store only ever saw the RECORD — no handle crossed the seam.
    expect(mutateSpy).toHaveBeenCalledWith({ put: { id: "a", n: 1 } }, expect.anything());
    expect(await s.query(undefined, stubStoreCtx())).toEqual([{ id: "a", n: 1 }]);
  });

  it("seedSync inserts into the cache with NO store write and NO change emit", async () => {
    const s = fusedStore();
    const mutateSpy = vi.spyOn(s, "mutate");
    const v = fused(s);
    const changes: ChangeEvent<Wrapper>[] = [];
    v.onChange((c) => changes.push(c));
    const w: Wrapper = { record: { id: "seed", n: 7 }, handle: () => {} };

    v.seedSync(w);

    expect(v.getSync("seed")).toBe(w);
    expect(mutateSpy).not.toHaveBeenCalled();
    expect(changes).toEqual([]);
    expect(await s.query(undefined, stubStoreCtx())).toEqual([]); // never persisted
  });

  it("seedSync pings the key only when { ping: true }", () => {
    const v = fused();
    const pings: string[] = [];
    v.subscribe("p", () => pings.push("p"));

    v.seedSync({ record: { id: "p", n: 1 }, handle: () => {} });
    expect(pings).toEqual([]); // silent by default

    v.seedSync({ record: { id: "p", n: 2 }, handle: () => {} }, { ping: true });
    expect(pings).toEqual(["p"]);
  });

  it("hydrate reconstructs wrappers from stored records", async () => {
    const s = fusedStore();
    await s.put({ id: "a", n: 1 }, stubStoreCtx());
    await s.put({ id: "b", n: 2 }, stubStoreCtx());
    const v = fused(s);

    const loaded = await v.hydrate(undefined, stubStoreCtx());

    expect(new Set(loaded)).toEqual(new Set(["a", "b"]));
    const a = v.getSync("a");
    expect(a?.record).toEqual({ id: "a", n: 1 });
    expect(typeof a?.handle).toBe("function"); // reconstructed live handle
  });

  it("hydrate throws when the view has no reconstruct", async () => {
    const s = fusedStore();
    await s.put({ id: "a", n: 1 }, stubStoreCtx());
    // A fused view WITHOUT reconstruct — hydrate has no way to rebuild a wrapper.
    const v = new View<Wrapper, Rec, Record<string, never>, CollectionMutation<Rec>>({
      store: s,
      keyOf: (w) => w.record.id,
      project: (w) => w.record,
      toPut: (r) => ({ put: r }),
      toDelete: (k) => ({ delete: k }),
    });

    await expect(v.hydrate(undefined, stubStoreCtx())).rejects.toThrow(/reconstruct/);
  });
});

describe("View — flush() is the durability barrier", () => {
  it("awaits a deferred store write (the write is pending until flush resolves)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let landed = false;
    const backing = new Map<string, Cell>();
    const deferred: Store<Cell, Record<string, never>, CollectionMutation<Cell>> = {
      backend: "deferred",
      query: () => Promise.resolve([...backing.values()]),
      mutate: async (m) => {
        await gate;
        if ("put" in m) backing.set(m.put.id, m.put);
        else backing.delete(m.delete);
        landed = true;
      },
    };
    const v = View.collection(deferred, (c) => c.id);

    v.write({ id: "a", value: 1 }, stubStoreCtx());
    expect(v.getSync("a")).toEqual({ id: "a", value: 1 }); // read from cache — no await
    expect(landed).toBe(false); // durable write still pending

    release();
    await v.flush();
    expect(landed).toBe(true); // flush awaited the in-flight write
    expect(backing.get("a")).toEqual({ id: "a", value: 1 });
  });

  it("swallows a failing write on the hot path, surfaces it on flush, clears it after", async () => {
    let fail = true;
    const failing: Store<Cell, Record<string, never>, CollectionMutation<Cell>> = {
      backend: "failing",
      query: () => Promise.resolve([]),
      mutate: () => (fail ? Promise.reject(new Error("boom")) : Promise.resolve()),
    };
    const v = View.collection(failing, (c) => c.id);

    // The write does not throw on the hot path; the cache still reflects it.
    v.write({ id: "a", value: 1 }, stubStoreCtx());
    expect(v.getSync("a")).toEqual({ id: "a", value: 1 });

    // The latched failure surfaces on the next flush.
    await expect(v.flush()).rejects.toThrow(/boom/);

    // Cleared after — a second flush over a now-healthy store is clean.
    fail = false;
    v.write({ id: "b", value: 2 }, stubStoreCtx());
    await expect(v.flush()).resolves.toBeUndefined();
  });
});

describe("View — targets the pure seam (no profile methods)", () => {
  it("works over a store that ONLY implements Store (query/mutate)", async () => {
    const backing = new Map<string, Cell>();
    const seamOnly: Store<Cell, Record<string, never>, CollectionMutation<Cell>> = {
      backend: "seam-only",
      query: (_q: Record<string, never> | undefined, _ctx: StoreCtx) =>
        Promise.resolve([...backing.values()]),
      mutate: (m: CollectionMutation<Cell>, _ctx: StoreCtx) => {
        if ("put" in m) backing.set(m.put.id, m.put);
        else backing.delete(m.delete);
        return Promise.resolve();
      },
    };
    const v = View.collection(seamOnly, (c) => c.id);

    v.write({ id: "a", value: 1 }, stubStoreCtx());
    await Promise.resolve();
    expect(backing.get("a")).toEqual({ id: "a", value: 1 });

    const v2 = View.collection(seamOnly, (c) => c.id);
    const loaded = await v2.hydrate(undefined, stubStoreCtx());
    expect(loaded).toEqual(["a"]);
    expect(v2.getSync("a")).toEqual({ id: "a", value: 1 });
  });
});
