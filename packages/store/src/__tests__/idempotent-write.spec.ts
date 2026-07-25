/**
 * `IdempotentCollectionStore` — dedup retried writes on `ctx.opId` (E16).
 *
 * Proves: the same `opId` applied twice ⇒ exactly one effect on the inner
 * store; distinct `opId`s pass through; an absent `opId` is never deduped;
 * reads are untouched.
 */

import { describe, expect, it } from "vitest";
import type { CollectionStore, StoreCtx } from "@agentick/spec";

import { idempotentWrite } from "../idempotent-write.js";
import { MemoryCollection } from "../memory-collection.js";
import { stubStoreCtx } from "../stub-store-ctx.js";

interface Cell {
  readonly id: string;
  readonly value: number;
}

/** A MemoryCollection that also counts how many times each verb reached it. */
function countingCollection(): {
  store: CollectionStore<Cell, undefined>;
  puts: () => number;
  deletes: () => number;
} {
  let puts = 0;
  let deletes = 0;
  const inner = new MemoryCollection<Cell, undefined>({
    backend: "memory",
    keyOf: (c) => c.id,
    matchQuery: () => true,
  });
  const store: CollectionStore<Cell, undefined> = {
    backend: inner.backend,
    put: (item, ctx) => {
      puts++;
      return inner.put(item, ctx);
    },
    delete: (key, ctx) => {
      deletes++;
      return inner.delete(key, ctx);
    },
    get: (key, ctx) => inner.get(key, ctx),
    list: (query, ctx) => inner.list(query, ctx),
    // Seam reads/writes delegate straight to the inner collection — the
    // decorator under test routes its own `mutate` through `put`/`delete`
    // (the counted wrappers above), so these are never the counted path.
    query: (query, ctx) => inner.query(query, ctx),
    mutate: (m, ctx) => inner.mutate(m, ctx),
  };
  return { store, puts: () => puts, deletes: () => deletes };
}

describe("IdempotentCollectionStore — E16 opId dedup", () => {
  it("same opId applied twice ⇒ one effect on the inner store", async () => {
    const counting = countingCollection();
    const store = idempotentWrite(counting.store);
    const ctx: StoreCtx = stubStoreCtx({ opId: "op-1" });

    await store.put({ id: "a", value: 1 }, ctx);
    await store.put({ id: "a", value: 1 }, ctx); // retry — same op

    expect(counting.puts()).toBe(1);
    expect(await store.get("a", ctx)).toEqual({ id: "a", value: 1 });
  });

  it("distinct opIds each pass through", async () => {
    const counting = countingCollection();
    const store = idempotentWrite(counting.store);

    await store.put({ id: "a", value: 1 }, stubStoreCtx({ opId: "op-1" }));
    await store.put({ id: "a", value: 2 }, stubStoreCtx({ opId: "op-2" }));

    expect(counting.puts()).toBe(2);
    expect(await store.get("a", stubStoreCtx())).toEqual({ id: "a", value: 2 });
  });

  it("an absent opId is never deduped (direct host writes)", async () => {
    const counting = countingCollection();
    const store = idempotentWrite(counting.store);

    await store.put({ id: "a", value: 1 }, stubStoreCtx());
    await store.put({ id: "a", value: 1 }, stubStoreCtx());

    expect(counting.puts()).toBe(2);
  });

  it("delete dedups on opId too", async () => {
    const counting = countingCollection();
    const store = idempotentWrite(counting.store);
    await store.put({ id: "a", value: 1 }, stubStoreCtx({ opId: "seed" }));

    const ctx = stubStoreCtx({ opId: "del-1" });
    await store.delete("a", ctx);
    await store.delete("a", ctx); // retry

    expect(counting.deletes()).toBe(1);
  });

  it("reads are never deduped and pass through unchanged", async () => {
    const counting = countingCollection();
    const store = idempotentWrite(counting.store);
    await store.put({ id: "a", value: 1 }, stubStoreCtx({ opId: "op-1" }));

    const ctx = stubStoreCtx({ opId: "op-1" }); // same op — reads still work
    expect(await store.get("a", ctx)).toEqual({ id: "a", value: 1 });
    expect(await store.list(undefined, ctx)).toEqual([{ id: "a", value: 1 }]);
  });

  it("carries the inner backend label", () => {
    const counting = countingCollection();
    const store = idempotentWrite(counting.store);
    expect(store.backend).toBe("memory+idempotent");
  });
});
