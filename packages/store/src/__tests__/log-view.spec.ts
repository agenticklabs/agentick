/**
 * `LogView` — verified directly. The harness-side SYNCHRONOUS projection of a
 * `LogStore`: two tiers (durable persisted + materialized projection), monotonic
 * versions, an identity-stable render snapshot, the write-behind pump + `flush`
 * barrier, the compaction-target `replaceProjection`, hydrate, and
 * export/import round-trip. The store seam is load-bearing — `LogView` drives a
 * real `MemoryLog` through `append`/`read`.
 */

import { describe, expect, it, vi } from "vitest";

import { MemoryLog } from "../memory-log.js";
import { LogView } from "../log-view.js";
import { stubStoreCtx } from "../stub-store-ctx.js";

interface Row {
  readonly id: string;
}

const row = (id: string): Row => ({ id });
const ids = (rows: readonly Row[]): string[] => rows.map((r) => r.id);

function log(
  store: MemoryLog<Row> = new MemoryLog<Row>(),
  policy: "behind" | "through" = "behind",
): { v: LogView<Row>; store: MemoryLog<Row> } {
  return {
    v: new LogView<Row>({ store, logKey: "L", writePolicy: policy }),
    store,
  };
}

describe("LogView — append updates the projection + version (§2.7: no mirror)", () => {
  it("the projection reflects the append synchronously; the version bumps", async () => {
    const { v } = log();
    await v.append([row("a"), row("b")], stubStoreCtx());
    expect(ids(v.read())).toEqual(["a", "b"]);
    expect(v.snapshot().version).toBe(1);
    await v.append([row("c")], stubStoreCtx());
    expect(ids(v.read())).toEqual(["a", "b", "c"]);
    expect(v.snapshot().version).toBe(2);
  });

  it("pings subscribers on each mutation", async () => {
    const { v } = log();
    const fn = vi.fn();
    v.subscribe(fn);
    await v.append([row("a")], stubStoreCtx());
    await v.append([row("b")], stubStoreCtx());
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe("LogView — snapshot identity stability", () => {
  it("the same snapshot reference is returned until the projection mutates", async () => {
    const { v } = log();
    const s0 = v.snapshot();
    expect(v.snapshot()).toBe(s0); // stable — no mutation
    await v.append([row("a")], stubStoreCtx());
    const s1 = v.snapshot();
    expect(s1).not.toBe(s0); // re-allocated on mutation
    expect(v.snapshot()).toBe(s1); // stable again
  });
});

describe("LogView — write-behind buffers then flush drains", () => {
  it("memory is authoritative immediately; the store lands at the flush barrier", async () => {
    const { v, store } = log();
    await v.append([row("a"), row("b")], stubStoreCtx());
    await v.append([row("c")], stubStoreCtx());
    // Memory (the projection) is authoritative before flush.
    expect(ids(v.read())).toEqual(["a", "b", "c"]);
    await v.flush();
    expect(ids(await store.read("L", stubStoreCtx()))).toEqual(["a", "b", "c"]);
  });

  it("flush() is idempotent and a no-op when nothing is buffered", async () => {
    const { v, store } = log();
    await v.flush(); // nothing appended
    await v.append([row("a")], stubStoreCtx());
    await v.flush();
    await v.flush(); // already drained
    expect(ids(await store.read("L", stubStoreCtx()))).toEqual(["a"]);
  });

  it("a failing buffered write surfaces the wrapped error at flush(), left latched", async () => {
    class Boom extends Error {}
    const store = new MemoryLog<Row>();
    store.append = () => Promise.reject(new Error("store boom"));
    const v = new LogView<Row>({
      store,
      logKey: "L",
      writePolicy: "behind",
      wrapWriteError: (cause) => new Boom(String((cause as Error).message)),
    });
    await v.append([row("a")], stubStoreCtx());
    await expect(v.flush()).rejects.toBeInstanceOf(Boom);
    // Left latched — a re-flush surfaces it again.
    await expect(v.flush()).rejects.toBeInstanceOf(Boom);
  });
});

describe("LogView — through-policy awaits the store", () => {
  it("each append is durable without an explicit flush", async () => {
    const { v, store } = log(new MemoryLog<Row>(), "through");
    await v.append([row("a")], stubStoreCtx());
    expect(ids(await store.read("L", stubStoreCtx()))).toEqual(["a"]);
    await v.append([row("b")], stubStoreCtx());
    expect(ids(await store.read("L", stubStoreCtx()))).toEqual(["a", "b"]);
  });

  it("a failing write rejects append() with the wrapped error", async () => {
    class Boom extends Error {}
    const store = new MemoryLog<Row>();
    store.append = () => Promise.reject(new Error("store boom"));
    const v = new LogView<Row>({
      store,
      logKey: "L",
      writePolicy: "through",
      wrapWriteError: (cause) => new Boom(String((cause as Error).message)),
    });
    await expect(v.append([row("a")], stubStoreCtx())).rejects.toBeInstanceOf(Boom);
    // Memory stayed authoritative (append updates the projection before the store).
    expect(ids(v.read())).toEqual(["a"]);
  });
});

describe("LogView — replaceProjection diverges the projection from the log", () => {
  it("rewrites only the projection; the durable log is untouched", async () => {
    const store = new MemoryLog<Row>();
    const { v } = log(store);
    await v.append([row("a"), row("b"), row("c")], stubStoreCtx());
    await v.flush();
    v.replaceProjection([row("summary")], {
      at: 1,
      source: "projection",
      entriesBefore: 3,
      entriesAfter: 1,
    });
    expect(ids(v.read())).toEqual(["summary"]);
    // The log's only home is the STORE (§2.7) — and it is untouched.
    expect(ids(await store.read("L", stubStoreCtx()))).toEqual(["a", "b", "c"]);
    expect(v.lastCompaction()?.entriesBefore).toBe(3);
  });

  it("resetProjection re-mirrors the STORE and clears provenance", async () => {
    const { v } = log();
    await v.append([row("a"), row("b")], stubStoreCtx());
    v.replaceProjection([], { at: 1, source: "persisted", entriesBefore: 2, entriesAfter: 0 });
    expect(ids(v.read())).toEqual([]);
    // Async now: the reset READS the log's only home. It also flushes the
    // write-behind first, so it can never travel back in time behind appends
    // the projection already showed.
    await v.resetProjection(stubStoreCtx());
    expect(ids(v.read())).toEqual(["a", "b"]);
    expect(v.lastCompaction()).toBeUndefined();
  });
});

describe("LogView — seed installs the projection (ADR 93 genesis)", () => {
  it("installs the supplied entries into the projection", async () => {
    const store = new MemoryLog<Row>();
    await store.append("L", [row("x"), row("y")], stubStoreCtx());
    const { v } = log(store);
    expect(ids(v.read())).toEqual([]); // nothing seeded yet
    // Genesis authority is the CALLER's: it reads the store (or folds a
    // journal, or synthesizes) and hands the result to `seed`.
    v.seed(await store.read("L", stubStoreCtx()));
    expect(ids(v.read())).toEqual(["x", "y"]);
  });

  it("does NOT write the seed back to the store (the seed law)", async () => {
    const store = new MemoryLog<Row>();
    const appends: Row[][] = [];
    const spy: typeof store.append = (key, entries, ctx) => {
      appends.push([...entries]);
      return store.append.call(store, key, entries, ctx);
    };
    const spied = Object.assign(Object.create(store) as MemoryLog<Row>, { append: spy });
    const { v } = log(spied);
    v.seed([row("g1"), row("g2")]);
    await v.flush();
    expect(appends).toEqual([]);
    expect(ids(v.read())).toEqual(["g1", "g2"]);
  });
});
