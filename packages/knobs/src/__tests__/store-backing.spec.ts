/**
 * KnobsHarness — store-backing (data-layer plan §3.5, Phase 3 storification)
 * and the checkpoint contract (checkpointing §3.2): `persist()` is the flush
 * barrier, `hydrate()` rebuilds the sync projection from the store partition,
 * and durability across harness instances holds exactly when the injected
 * store outlives the harness.
 */

import { describe, expect, it } from "vitest";
import {
  LocalEventBus,
  LocalInbox,
  MemoryJournal,
  namespaceSlotAppScopes,
} from "@agentick/runtime";
import { stubStoreCtx } from "@agentick/store";

import "../augment.js";
import { KnobsHarness, type KnobsHarnessOptions } from "../harness.js";
import { createKnobStore, type KnobEntry, type KnobStoreQuery } from "../store.js";
import type { CollectionMutation, HydrateCtx, KnobPrimitive, PersistCtx } from "@agentick/spec";

const SCOPE = "store-test";

async function makeHarness(
  store?: KnobsHarnessOptions["store"],
  scope = SCOPE,
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

function checkpointCtx(sessionId = SCOPE): PersistCtx & HydrateCtx {
  return { sessionId, tick: 0, storeCtx: stubStoreCtx() };
}

/** A cell as the harness stores it — scope-stamped. */
function cell(id: string, value: KnobPrimitive, scope = SCOPE): KnobEntry {
  return { scope, id, value };
}

describe("KnobsHarness — store write-through", () => {
  it("a value set writes through to the store", async () => {
    const store = createKnobStore();
    const harness = await makeHarness(store);

    await harness.set({ id: "verbose", value: true });
    await harness.set({ id: "limit", value: 42 });

    const listed = await store.list({ scope: SCOPE }, stubStoreCtx());
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

    expect(await store.list({ scope: SCOPE }, stubStoreCtx())).toEqual([cell("mode", "final")]);
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

    expect(await store.list({ scope: SCOPE }, stubStoreCtx())).toEqual([cell("mood", "curious")]);
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

    expect(await store.list({ scope: SCOPE }, stubStoreCtx())).toEqual([cell("tone", "cool")]);
    expect(harness.get("tone")).toBe("cool");
    await harness.close();
  });

  it("cells are keyed by harness scope, so one store serves many sessions without collision", async () => {
    const shared = createKnobStore();
    const a = await makeHarness(shared, "sess-a:knobs");
    const b = await makeHarness(shared, "sess-b:knobs");

    await a.set({ id: "mood", value: "curious" });
    await b.set({ id: "mood", value: "decisive" });

    await a.hydrate(checkpointCtx("sess-a"));
    await b.hydrate(checkpointCtx("sess-b"));

    expect(a.get("mood")).toBe("curious");
    expect(b.get("mood")).toBe("decisive");
    await a.close();
    await b.close();
  });
});

describe("KnobsHarness — hydrate() from a pre-seeded store", () => {
  it("repopulates the sync projection from the store", async () => {
    const store = createKnobStore();
    await store.put(cell("alpha", 1), stubStoreCtx());
    await store.put(cell("beta", "two"), stubStoreCtx());
    await store.put(cell("gamma", false), stubStoreCtx());

    const harness = await makeHarness(store);
    // Before hydrate the projection is empty (store is not the sync read path).
    expect(harness.get("alpha")).toBeUndefined();

    await harness.hydrate(checkpointCtx());

    expect(harness.get("alpha")).toBe(1);
    expect(harness.get("beta")).toBe("two");
    expect(harness.get("gamma")).toBe(false);
    const byId = Object.fromEntries(harness.list().map((k) => [k.id, k.value]));
    expect(byId).toEqual({ alpha: 1, beta: "two", gamma: false });
    await harness.close();
  });

  it("pings subscribers so a useSyncExternalStore consumer re-reads", async () => {
    const store = createKnobStore();
    await store.put(cell("x", 7), stubStoreCtx());
    const harness = await makeHarness(store);

    let allHits = 0;
    harness.subscribeAll(() => {
      allHits++;
    });
    let keyHits = 0;
    harness.subscribe("x", () => {
      keyHits++;
    });

    await harness.hydrate(checkpointCtx());

    expect(allHits).toBeGreaterThan(0);
    expect(keyHits).toBeGreaterThan(0);
    await harness.close();
  });
});

describe("KnobsHarness — persist() (the flush barrier)", () => {
  it("resolves once every in-flight store write has settled", async () => {
    let settle: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const store = createKnobStore();
    const harness = await makeHarness({
      backend: store.backend,
      query: (q, c) => store.query(q, c),
      mutate: async (m, c) => {
        await gate;
        return store.mutate(m, c);
      },
    });

    await harness.set({ id: "slow", value: 1 });
    let flushed = false;
    const barrier = harness.persist(checkpointCtx()).then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);

    settle!();
    await barrier;
    expect(flushed).toBe(true);
    expect(await store.list({ scope: SCOPE }, stubStoreCtx())).toEqual([cell("slow", 1)]);
    await harness.close();
  });
});

describe("KnobsHarness — durability across harness instances", () => {
  it("a per-harness default store loses values across instances (the injection seam is load-bearing)", async () => {
    const first = await makeHarness();
    await first.set({ id: "mood", value: "curious" });
    await first.persist(checkpointCtx());
    await first.close();

    const second = await makeHarness();
    await second.hydrate(checkpointCtx());

    expect(second.get("mood")).toBeUndefined();
    await second.close();
  });
});

describe("KnobsHarness — the construction seed writes through", () => {
  it("seed populates BOTH the projection and the store", async () => {
    const store = createKnobStore();
    const harness = await makeHarness(store);

    harness.seed({ a: 1, b: "two", c: true });

    expect(harness.get("a")).toBe(1);
    expect(harness.get("b")).toBe("two");
    expect(harness.get("c")).toBe(true);
    expect(new Set(await store.list({ scope: SCOPE }, stubStoreCtx()))).toEqual(
      new Set([cell("a", 1), cell("b", "two"), cell("c", true)]),
    );
    await harness.close();
  });

  it("seed UPSERTS — a hydrated knob the seed does not name survives it", async () => {
    // The create-call seed runs AFTER the hydrate fan-out, so replace semantics
    // would silently wipe everything the store just restored.
    const shared = createKnobStore();
    const first = await makeHarness(shared);
    await first.set({ id: "durable", value: "kept" });
    await first.persist(checkpointCtx());
    await first.close();

    const second = await makeHarness(shared);
    await second.hydrate(checkpointCtx());
    second.seed({ fromCreate: 9 });

    expect(second.get("durable")).toBe("kept");
    expect(second.get("fromCreate")).toBe(9);
    await second.close();
  });
});

describe("KnobsHarness — the store seam (query/mutate only)", () => {
  it("hydrate/persist drive a seam-only store — no CollectionStore profile methods", async () => {
    const backing = createKnobStore();
    const seamOnly = {
      backend: "seam",
      query: (q: KnobStoreQuery | undefined, c = stubStoreCtx()) => backing.query(q, c),
      mutate: (m: CollectionMutation<KnobEntry>, c = stubStoreCtx()) => backing.mutate(m, c),
    };

    const first = await makeHarness(seamOnly);
    await first.set({ id: "seamed", value: "yes" });
    await first.persist(checkpointCtx());
    await first.close();

    const second = await makeHarness(seamOnly);
    await second.hydrate(checkpointCtx());

    expect(second.get("seamed")).toBe("yes");
    await second.close();
  });
});

describe("the knobs namespace slot — the app-scoped default store", () => {
  it("an explicit `store: undefined` does not clobber the app default", () => {
    // Adopters build config bags out of optional fields, so `{ store: opts.store }`
    // spreads an explicit `undefined` — which a bare spread would layer OVER the
    // default, leaving every session on a per-harness store and nothing to
    // hydrate from after an evict.
    const fold = namespaceSlotAppScopes()["knobs"]!;
    const omitted = fold(undefined) as { store?: unknown };
    const explicitUndefined = fold({ store: undefined }) as { store?: unknown };

    expect(omitted.store).toBeDefined();
    expect(explicitUndefined.store).toBe(omitted.store);
  });
});
