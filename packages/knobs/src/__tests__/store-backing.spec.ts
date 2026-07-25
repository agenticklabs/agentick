/**
 * KnobsHarness — store-backing (data-layer plan §3.5, Phase 3 storification).
 *
 * The store holds knob VALUES as durable backing; `values: Map` stays the
 * synchronous render projection. These tests pin the additive contract:
 * every value mutation dual-writes (projection + store), `hydrate()` rebuilds
 * the projection from a pre-seeded store, and `importSnapshot`/`exportSnapshot`
 * coexist with the store (import write-through; export round-trips).
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal } from "@agentick/runtime";
import { stubStoreCtx } from "@agentick/store";

import { MemoryCollection } from "@agentick/store";

import { KnobsHarness } from "../harness.js";
import { createKnobStore, type KnobEntry, type KnobStoreQuery } from "../store.js";
import type { KnobPrimitive } from "@agentick/spec";

async function makeHarness(
  store?: MemoryCollection<KnobEntry, KnobStoreQuery>,
  scope = "store-test",
): Promise<KnobsHarness> {
  const harness = new KnobsHarness(
    scope,
    new MemoryJournal({ capacity: 10_000 }),
    new LocalEventBus(),
    new LocalInbox(),
    undefined,
    store !== undefined ? { store } : {},
  );
  await harness.ready;
  return harness;
}

describe("KnobsHarness — store write-through", () => {
  it("a value set writes through to the store", async () => {
    const store = createKnobStore();
    const harness = await makeHarness(store);

    await harness.set({ id: "verbose", value: true });
    await harness.set({ id: "limit", value: 42 });

    // Store mirrors the projection (durable truth), keyed by knob id.
    expect(await store.get("verbose", stubStoreCtx())).toEqual({ id: "verbose", value: true });
    expect(await store.get("limit", stubStoreCtx())).toEqual({ id: "limit", value: 42 });
    const listed = await store.list(undefined, stubStoreCtx());
    expect(new Map<string, KnobPrimitive>(listed.map((e) => [e.id, e.value]))).toEqual(
      new Map<string, KnobPrimitive>([
        ["verbose", true],
        ["limit", 42],
      ]),
    );
    // The sync projection is unaffected — reads still resolve.
    expect(harness.get("verbose")).toBe(true);
    await harness.close();
  });

  it("a later set of the same id upserts the store cell", async () => {
    const store = createKnobStore();
    const harness = await makeHarness(store);

    await harness.set({ id: "mode", value: "draft" });
    await harness.set({ id: "mode", value: "final" });

    expect(await store.get("mode", stubStoreCtx())).toEqual({ id: "mode", value: "final" });
    expect((await store.list(undefined, stubStoreCtx())).length).toBe(1);
    await harness.close();
  });

  it("register that seeds a default value writes through; descriptor-only does not", async () => {
    const store = createKnobStore();
    const harness = await makeHarness(store);

    // Seeds a value → store write.
    await harness.register({
      id: "mood",
      descriptor: { valueType: "string", defaultValue: "curious" },
    });
    // No defaultValue → touches no cell → no store write.
    await harness.register({
      id: "note",
      descriptor: { valueType: "string" },
    });

    expect(await store.get("mood", stubStoreCtx())).toEqual({ id: "mood", value: "curious" });
    expect(await store.get("note", stubStoreCtx())).toBeUndefined();
    await harness.close();
  });

  it("dispatch (which routes through applySet) writes through to the store", async () => {
    const store = createKnobStore();
    const harness = await makeHarness(store);
    await harness.register({
      id: "tone",
      descriptor: { valueType: "string", defaultValue: "warm", options: ["warm", "cool"] },
    });

    await harness.dispatch({ name: "tone", value: "cool" });

    expect(await store.get("tone", stubStoreCtx())).toEqual({ id: "tone", value: "cool" });
    expect(harness.get("tone")).toBe("cool");
    await harness.close();
  });
});

describe("KnobsHarness — hydrate() from a pre-seeded store", () => {
  it("repopulates the sync projection from the store", async () => {
    const store = createKnobStore();
    await store.put({ id: "alpha", value: 1 }, stubStoreCtx());
    await store.put({ id: "beta", value: "two" }, stubStoreCtx());
    await store.put({ id: "gamma", value: false }, stubStoreCtx());

    const harness = await makeHarness(store);
    // Before hydrate the projection is empty (store is not the sync read path).
    expect(harness.get("alpha")).toBeUndefined();

    await harness.hydrate();

    expect(harness.get("alpha")).toBe(1);
    expect(harness.get("beta")).toBe("two");
    expect(harness.get("gamma")).toBe(false);
    const byId = Object.fromEntries(harness.list().map((k) => [k.id, k.value]));
    expect(byId).toEqual({ alpha: 1, beta: "two", gamma: false });
    await harness.close();
  });

  it("pings subscribers so a useSyncExternalStore consumer re-reads", async () => {
    const store = createKnobStore();
    await store.put({ id: "x", value: 7 }, stubStoreCtx());
    const harness = await makeHarness(store);

    let allHits = 0;
    harness.subscribeAll(() => {
      allHits++;
    });
    let keyHits = 0;
    harness.subscribe("x", () => {
      keyHits++;
    });

    await harness.hydrate();

    expect(allHits).toBeGreaterThan(0);
    expect(keyHits).toBeGreaterThan(0);
    await harness.close();
  });

  it("merges store cells over the projection (does not clear-first)", async () => {
    const store = createKnobStore();
    await store.put({ id: "fromStore", value: "s" }, stubStoreCtx());
    const harness = await makeHarness(store);
    // A live set the store also has NOT seen wiped by hydrate.
    await harness.set({ id: "live", value: "l" });

    await harness.hydrate();

    expect(harness.get("live")).toBe("l");
    expect(harness.get("fromStore")).toBe("s");
    await harness.close();
  });
});

describe("KnobsHarness — importSnapshot / exportSnapshot coexist with the store", () => {
  it("importSnapshot populates BOTH the projection and the store", async () => {
    const store = createKnobStore();
    const harness = await makeHarness(store);

    harness.importSnapshot({ a: 1, b: "two", c: true });

    // Projection.
    expect(harness.get("a")).toBe(1);
    expect(harness.get("b")).toBe("two");
    expect(harness.get("c")).toBe(true);
    // Store write-through.
    expect(await store.get("a", stubStoreCtx())).toEqual({ id: "a", value: 1 });
    expect(await store.get("b", stubStoreCtx())).toEqual({ id: "b", value: "two" });
    expect(await store.get("c", stubStoreCtx())).toEqual({ id: "c", value: true });
    await harness.close();
  });

  it("exportSnapshot round-trips through importSnapshot (values only)", async () => {
    const source = await makeHarness();
    await source.set({ id: "a", value: 1 });
    await source.set({ id: "b", value: "two" });
    const snap = source.exportSnapshot();

    const store = createKnobStore();
    const restored = await makeHarness(store);
    restored.importSnapshot(snap);

    expect(restored.exportSnapshot()).toEqual({ a: 1, b: "two" });
    expect(await store.get("a", stubStoreCtx())).toEqual({ id: "a", value: 1 });
    expect(await store.get("b", stubStoreCtx())).toEqual({ id: "b", value: "two" });
    await source.close();
    await restored.close();
  });

  it("a store-hydrated projection is re-exportable (store → projection → snapshot)", async () => {
    const store = createKnobStore();
    await store.put({ id: "k", value: "v" }, stubStoreCtx());
    const harness = await makeHarness(store);
    await harness.hydrate();

    // The snapshot path reads the projection, which the store just filled.
    expect(harness.exportSnapshot()).toEqual({ k: "v" });
    await harness.close();
  });
});
