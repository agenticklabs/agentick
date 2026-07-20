/**
 * `ReactiveView` — verified directly. The harness-side sync projection of a
 * `ReactiveStore`: sync reads, single-mutation write/delete (notify + typed
 * change), and the CHANGE-SILENT bulk paths (replace, hydrate). The seam is
 * load-bearing here on purpose — the view drives the store through
 * `query`/`mutate` (never `get`/`list`/`put`/`delete`), so a store that ONLY
 * implements `ReactiveStore` works.
 */

import { describe, expect, it, vi } from "vitest";

import type { ChangeEvent } from "@agentick/pubsub-next";
import type { CollectionMutation, ReactiveStore, StoreCtx } from "@agentick/spec-next";

import { MemoryCollection } from "../memory-collection.js";
import { ReactiveView } from "../reactive-view.js";
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
  v: ReactiveView<Cell, Record<string, never>, CollectionMutation<Cell>>;
  store: typeof s;
} {
  return { v: ReactiveView.collection(s, (c) => c.id), store: s };
}

describe("ReactiveView — sync reads reflect writes immediately", () => {
  it("getSync / hasSync / listSync see a write synchronously (no await)", () => {
    const { v } = view();
    expect(v.hasSync("a")).toBe(false);
    v.write({ id: "a", value: 1 }, stubStoreCtx());
    expect(v.hasSync("a")).toBe(true);
    expect(v.getSync("a")).toEqual({ id: "a", value: 1 });
    expect(v.listSync()).toEqual([{ id: "a", value: 1 }]);
  });
});

describe("ReactiveView — write fires notify + a typed change", () => {
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

describe("ReactiveView — delete is idempotent", () => {
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

describe("ReactiveView — undefined-value classification rides cache presence", () => {
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

describe("ReactiveView — hydrate merges + notifies (change-silent)", () => {
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
});

describe("ReactiveView — replace drops + adds (change-silent)", () => {
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

describe("ReactiveView — targets the pure seam (no profile methods)", () => {
  it("works over a store that ONLY implements ReactiveStore (query/mutate)", async () => {
    const backing = new Map<string, Cell>();
    const seamOnly: ReactiveStore<Cell, Record<string, never>, CollectionMutation<Cell>> = {
      backend: "seam-only",
      query: (_q: Record<string, never> | undefined, _ctx: StoreCtx) =>
        Promise.resolve([...backing.values()]),
      mutate: (m: CollectionMutation<Cell>, _ctx: StoreCtx) => {
        if ("put" in m) backing.set(m.put.id, m.put);
        else backing.delete(m.delete);
        return Promise.resolve();
      },
    };
    const v = ReactiveView.collection(seamOnly, (c) => c.id);

    v.write({ id: "a", value: 1 }, stubStoreCtx());
    await Promise.resolve();
    expect(backing.get("a")).toEqual({ id: "a", value: 1 });

    const v2 = ReactiveView.collection(seamOnly, (c) => c.id);
    const loaded = await v2.hydrate(undefined, stubStoreCtx());
    expect(loaded).toEqual(["a"]);
    expect(v2.getSync("a")).toEqual({ id: "a", value: 1 });
  });
});
