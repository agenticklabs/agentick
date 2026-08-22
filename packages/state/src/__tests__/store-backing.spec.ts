/**
 * StateHarness — store-backing (data-layer plan §3.5, Phase 3 storification).
 *
 * The store holds state VALUES as durable backing; a synchronous
 * {@link View} stays the render read cache. These tests pin the
 * additive contract: every value mutation writes through (view + store),
 * `hydrate()` rebuilds the view from a pre-seeded store, and
 * `importSnapshot`/`exportSnapshot` coexist with the store (import
 * write-through; export round-trips). State is the knobs twin, plus one wrinkle
 * of its own: `unknown` values, so a `set(key, undefined)` must round-trip as a
 * PRESENT key (not an absent one).
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { stubStoreCtx } from "@agentick/store";

import { MemoryCollection } from "@agentick/store";

import { StateHarness } from "../harness.js";
import {
  createStateStore,
  stateStoreKey,
  type StateEntry,
  type StateStoreQuery,
} from "../store.js";

const SCOPE = "store-test";

const hydrateCtx = () => ({ sessionId: "store-test", tick: 0, storeCtx: stubStoreCtx() });

async function makeHarness(
  store?: MemoryCollection<StateEntry, StateStoreQuery>,
  scope = SCOPE,
): Promise<StateHarness> {
  const harness = new StateHarness(
    scope,
    new MemoryJournal({ capacity: 10_000 }),
    new LocalEventBus(),
    new LocalInbox(),
    store !== undefined ? { store } : {},
  );
  await harness.ready;
  return harness;
}

describe("StateHarness — store write-through", () => {
  it("a value set writes through to the store", async () => {
    const store = createStateStore();
    const harness = await makeHarness(store);

    await harness.set({ key: "user", value: { name: "ada" } });
    await harness.set({ key: "count", value: 42 });

    // Store mirrors the projection (durable truth), keyed by state key.
    expect(await store.get(stateStoreKey(SCOPE, "user"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "user",
      value: { name: "ada" },
    });
    expect(await store.get(stateStoreKey(SCOPE, "count"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "count",
      value: 42,
    });
    const listed = await store.list(undefined, stubStoreCtx());
    expect(new Map(listed.map((e) => [e.key, e.value]))).toEqual(
      new Map<string, unknown>([
        ["user", { name: "ada" }],
        ["count", 42],
      ]),
    );
    // The sync projection is unaffected — reads still resolve.
    expect(harness.get("count")).toBe(42);
    await harness.close();
  });

  it("a later set of the same key upserts the store cell", async () => {
    const store = createStateStore();
    const harness = await makeHarness(store);

    await harness.set({ key: "mode", value: "draft" });
    await harness.set({ key: "mode", value: "final" });

    expect(await store.get(stateStoreKey(SCOPE, "mode"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "mode",
      value: "final",
    });
    expect((await store.list(undefined, stubStoreCtx())).length).toBe(1);
    await harness.close();
  });

  it("a delete removes the store cell", async () => {
    const store = createStateStore();
    const harness = await makeHarness(store);
    await harness.set({ key: "temp", value: 1 });
    expect(await store.get(stateStoreKey(SCOPE, "temp"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "temp",
      value: 1,
    });

    await harness.delete({ key: "temp" });

    expect(await store.get(stateStoreKey(SCOPE, "temp"), stubStoreCtx())).toBeUndefined();
    expect(harness.has("temp")).toBe(false);
    await harness.close();
  });

  it("stores `undefined` as a real present value (write-through)", async () => {
    const store = createStateStore();
    const harness = await makeHarness(store);

    await harness.set({ key: "maybe", value: undefined });

    // Present in the projection (a key-membership fact), value is `undefined`.
    expect(harness.has("maybe")).toBe(true);
    expect(harness.get("maybe")).toBeUndefined();
    // The store holds the cell too — presence, not `value !== undefined`.
    expect(await store.get(stateStoreKey(SCOPE, "maybe"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "maybe",
      value: undefined,
    });
    expect((await store.list(undefined, stubStoreCtx())).map((e) => e.key)).toEqual(["maybe"]);
    await harness.close();
  });
});

describe("StateHarness — hydrate() from a pre-seeded store", () => {
  it("repopulates the sync projection from the store", async () => {
    const store = createStateStore();
    await store.put({ scope: SCOPE, key: "alpha", value: 1 }, stubStoreCtx());
    await store.put({ scope: SCOPE, key: "beta", value: "two" }, stubStoreCtx());
    await store.put({ scope: SCOPE, key: "gamma", value: false }, stubStoreCtx());

    const harness = await makeHarness(store);
    // Before hydrate the projection is empty (store is not the sync read path).
    expect(harness.get("alpha")).toBeUndefined();

    await harness.hydrate(hydrateCtx());

    expect(harness.get("alpha")).toBe(1);
    expect(harness.get("beta")).toBe("two");
    expect(harness.get("gamma")).toBe(false);
    expect(new Set(harness.list().map((e) => e.key))).toEqual(new Set(["alpha", "beta", "gamma"]));
    await harness.close();
  });

  it("hydrates an `undefined`-valued cell as a present key", async () => {
    const store = createStateStore();
    await store.put({ scope: SCOPE, key: "maybe", value: undefined }, stubStoreCtx());
    const harness = await makeHarness(store);

    await harness.hydrate(hydrateCtx());

    expect(harness.has("maybe")).toBe(true);
    expect(harness.get("maybe")).toBeUndefined();
    await harness.close();
  });

  it("pings subscribers so a useSyncExternalStore consumer re-reads", async () => {
    const store = createStateStore();
    await store.put({ scope: SCOPE, key: "x", value: 7 }, stubStoreCtx());
    const harness = await makeHarness(store);

    let allHits = 0;
    harness.subscribeAll(() => {
      allHits++;
    });
    let keyHits = 0;
    harness.subscribe("x", () => {
      keyHits++;
    });

    await harness.hydrate(hydrateCtx());

    expect(allHits).toBeGreaterThan(0);
    expect(keyHits).toBeGreaterThan(0);
    await harness.close();
  });

  it("emits NO typed change — a wholesale rebuild is not N deltas (importSnapshot's rule)", async () => {
    const store = createStateStore();
    await store.put({ scope: SCOPE, key: "x", value: 7 }, stubStoreCtx());
    const harness = await makeHarness(store);
    const changes: unknown[] = [];
    harness.onChange((c) => changes.push(c));

    await harness.hydrate(hydrateCtx());

    expect(harness.get("x")).toBe(7);
    expect(changes).toEqual([]);
    await harness.close();
  });

  it("REPLACES the projection — a cell the store does not hold is dropped", async () => {
    const store = createStateStore();
    await store.put({ scope: SCOPE, key: "fromStore", value: "s" }, stubStoreCtx());
    const harness = await makeHarness(store);
    await harness.set({ key: "live", value: "l" });
    // The store is the authority: drop the cell behind the projection's back.
    await store.delete(stateStoreKey(SCOPE, "live"), stubStoreCtx());

    await harness.hydrate(hydrateCtx());

    expect(harness.has("live")).toBe(false);
    expect(harness.get("fromStore")).toBe("s");
    await harness.close();
  });

  it("reads only its own scope's cells from a store shared with another session", async () => {
    const store = createStateStore();
    await store.put({ scope: SCOPE, key: "mine", value: "a" }, stubStoreCtx());
    await store.put({ scope: "other-session:state", key: "theirs", value: "b" }, stubStoreCtx());
    const harness = await makeHarness(store);

    await harness.hydrate(hydrateCtx());

    expect(harness.get("mine")).toBe("a");
    expect(harness.has("theirs")).toBe(false);
    await harness.close();
  });
});

describe("StateHarness — persist/hydrate across harness instances (the store outlives the harness)", () => {
  it("cells set on harness A are readable on harness B sharing store S", async () => {
    const store = createStateStore();
    const a = await makeHarness(store);
    await a.set({ key: "mode", value: "final" });
    await a.set({ key: "count", value: 3 });
    await a.persist(hydrateCtx());
    await a.close();

    const b = await makeHarness(store);
    await b.hydrate(hydrateCtx());

    expect(b.get("mode")).toBe("final");
    expect(b.get("count")).toBe(3);
    await b.close();
  });

  it("persist surfaces a failed store write so the caller aborts its unmount", async () => {
    const failing = {
      backend: "failing",
      query: () => Promise.resolve([]),
      mutate: () => Promise.reject(new Error("store offline")),
    };
    const harness = new StateHarness(
      SCOPE,
      new MemoryJournal({ capacity: 10_000 }),
      new LocalEventBus(),
      new LocalInbox(),
      { store: failing },
    );
    await harness.ready;

    await harness.set({ key: "doomed", value: 1 });

    await expect(harness.persist(hydrateCtx())).rejects.toThrow("store offline");
    await harness.close();
  });
});

describe("StateHarness — importSnapshot / exportSnapshot coexist with the store", () => {
  it("importSnapshot populates BOTH the projection and the store", async () => {
    const store = createStateStore();
    const harness = await makeHarness(store);

    harness.importSnapshot({ a: 1, b: "two", c: true });

    // Projection.
    expect(harness.get("a")).toBe(1);
    expect(harness.get("b")).toBe("two");
    expect(harness.get("c")).toBe(true);
    // Store write-through.
    expect(await store.get(stateStoreKey(SCOPE, "a"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "a",
      value: 1,
    });
    expect(await store.get(stateStoreKey(SCOPE, "b"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "b",
      value: "two",
    });
    expect(await store.get(stateStoreKey(SCOPE, "c"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "c",
      value: true,
    });
    await harness.close();
  });

  it("importSnapshot drops keys absent from the new snapshot (projection + store)", async () => {
    const store = createStateStore();
    const harness = await makeHarness(store);
    harness.importSnapshot({ keep: 1, drop: 2 });

    harness.importSnapshot({ keep: 9 });

    expect(harness.has("drop")).toBe(false);
    expect(harness.get("keep")).toBe(9);
    expect(await store.get(stateStoreKey(SCOPE, "drop"), stubStoreCtx())).toBeUndefined();
    expect(await store.get(stateStoreKey(SCOPE, "keep"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "keep",
      value: 9,
    });
    await harness.close();
  });

  it("exportSnapshot round-trips through importSnapshot", async () => {
    const source = await makeHarness();
    await source.set({ key: "a", value: 1 });
    await source.set({ key: "b", value: "two" });
    const snap = source.exportSnapshot();

    const store = createStateStore();
    const restored = await makeHarness(store);
    restored.importSnapshot(snap);

    expect(restored.exportSnapshot()).toEqual({ a: 1, b: "two" });
    expect(await store.get(stateStoreKey(SCOPE, "a"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "a",
      value: 1,
    });
    expect(await store.get(stateStoreKey(SCOPE, "b"), stubStoreCtx())).toEqual({
      scope: SCOPE,
      key: "b",
      value: "two",
    });
    await source.close();
    await restored.close();
  });

  it("a store-hydrated projection is re-exportable (store → projection → snapshot)", async () => {
    const store = createStateStore();
    await store.put({ scope: SCOPE, key: "k", value: "v" }, stubStoreCtx());
    const harness = await makeHarness(store);
    await harness.hydrate(hydrateCtx());

    // The snapshot path reads the projection, which the store just filled.
    expect(harness.exportSnapshot()).toEqual({ k: "v" });
    await harness.close();
  });
});
