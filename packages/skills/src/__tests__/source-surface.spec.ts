/**
 * Skills harness — the dynamic SOURCE surface, now driven by the ONE genesis seam
 * (ADR 93 rendered-moot #3: sources are hydrators).
 *
 * Pins:
 *  - `reload()` adds entries the source gained
 *  - `reload()` updates entries whose content changed
 *  - `reload({ pruneMissing: true })` removes entries gone from the source
 *  - `reload()` on a source-less harness touches nothing
 *  - `resolve(name)` returns a registered skill from the sync cache
 *  - `resolve(name)` re-runs the hydrator on a cache miss
 *  - `resolve(name)` returns null when the source lacks the name
 *  - a reload goes through the OPS (unlike genesis, which seeds)
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { SkillsRegisterInput } from "@agentick/spec";
import { SkillNotFound } from "@agentick/spec";

import { SkillsHarness } from "../harness.js";
import { composeHydrators, hydrateFrom } from "../hydrators.js";

async function makeHarness(): Promise<SkillsHarness> {
  const harness = new SkillsHarness(
    `test:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
  );
  await harness.ready;
  return harness;
}

describe("SkillsHarness.reload", () => {
  it("adds entries not yet registered", async () => {
    const h = await makeHarness();
    const records: SkillsRegisterInput[] = [];
    h.setHydrator(hydrateFrom(records));

    records.push({ name: "first", description: "f", content: "FF" });
    const summary = await h.reload();
    expect(summary.added).toEqual(["first"]);
    expect(h.has("first")).toBe(true);
  });

  it("updates entries whose content changed", async () => {
    const h = await makeHarness();
    const initial: SkillsRegisterInput = { name: "x", description: "old", content: "old" };
    const updated: SkillsRegisterInput = { name: "x", description: "new", content: "new" };
    const records: SkillsRegisterInput[] = [initial];
    h.setHydrator(hydrateFrom(records));

    await h.reload();
    expect(h.get("x")?.description).toBe("old");

    // Swap the loader source for an updated snapshot.
    records.length = 0;
    records.push(updated);
    const summary = await h.reload();
    expect(summary.updated).toEqual(["x"]);
    expect(h.get("x")?.description).toBe("new");
    expect(h.get("x")?.content).toBe("new");
  });

  it("does NOT re-update entries when content is unchanged", async () => {
    const h = await makeHarness();
    const records: SkillsRegisterInput[] = [{ name: "x", description: "d", content: "c" }];
    h.setHydrator(hydrateFrom(records));

    await h.reload();
    const second = await h.reload();
    expect(second.added).toEqual([]);
    expect(second.updated).toEqual([]);
  });

  it("removes entries gone from sources when pruneMissing: true", async () => {
    const h = await makeHarness();
    const records: SkillsRegisterInput[] = [
      { name: "alpha", description: "a", content: "a" },
      { name: "beta", description: "b", content: "b" },
    ];
    h.setHydrator(hydrateFrom(records));

    await h.reload();
    records.length = 0;
    records.push({ name: "alpha", description: "a", content: "a" });

    const summary = await h.reload({ pruneMissing: true });
    expect(summary.removed).toEqual(["beta"]);
    expect(h.has("beta")).toBe(false);
    expect(h.has("alpha")).toBe(true);
  });

  it("keeps entries gone from sources when pruneMissing is omitted", async () => {
    const h = await makeHarness();
    const records: SkillsRegisterInput[] = [{ name: "z", description: "z", content: "z" }];
    h.setHydrator(hydrateFrom(records));
    await h.reload();
    records.length = 0;
    const summary = await h.reload();
    expect(summary.removed).toEqual([]);
    expect(h.has("z")).toBe(true);
  });
});

describe("SkillsHarness.resolve", () => {
  it("returns the cached skill when present", async () => {
    const h = await makeHarness();
    await h.register({ name: "cached", description: "c", content: "c" });
    const result = await h.resolve("cached");
    expect(result?.name).toBe("cached");
  });

  it("re-runs the hydrator on a cache miss and registers the hit", async () => {
    const h = await makeHarness();
    const records: SkillsRegisterInput[] = [{ name: "lazy", description: "l", content: "L" }];
    h.setHydrator(hydrateFrom(records));

    expect(h.has("lazy")).toBe(false);
    const result = await h.resolve("lazy");
    expect(result?.name).toBe("lazy");
    expect(h.has("lazy")).toBe(true);
  });

  it("returns null when the source lacks the name", async () => {
    const h = await makeHarness();
    h.setHydrator(hydrateFrom([{ name: "alpha", description: "a", content: "a" }]));
    const result = await h.resolve("does-not-exist");
    expect(result).toBeNull();
  });

  it("returns null on a miss when NO source is configured", async () => {
    const h = await makeHarness();
    expect(await h.resolve("anything")).toBeNull();
  });

  it("composed sources resolve LAST-wins on a duplicate name", async () => {
    const h = await makeHarness();
    // `composeHydrators` is the override ladder: later sources shadow earlier
    // ones, so the working tree can win over the durable catalog.
    h.setHydrator(
      composeHydrators(
        hydrateFrom([{ name: "x", description: "FIRST", content: "1" }]),
        hydrateFrom([{ name: "x", description: "SECOND", content: "2" }]),
      ),
    );
    const result = await h.resolve("x");
    expect(result?.description).toBe("SECOND");
  });
});

describe("SkillsHarness.require", () => {
  it("returns the skill on hit (same as resolve)", async () => {
    const h = await makeHarness();
    h.setHydrator(hydrateFrom([{ name: "p", description: "p", content: "p" }]));
    const result = await h.require("p");
    expect(result.name).toBe("p");
  });

  it("throws SkillNotFound when no source has the name", async () => {
    const h = await makeHarness();
    h.setHydrator(hydrateFrom([{ name: "alpha", description: "a", content: "a" }]));
    await expect(h.require("missing")).rejects.toBeInstanceOf(SkillNotFound);
  });

  it("returns from cache without re-running the hydrator when already registered", async () => {
    const h = await makeHarness();
    await h.register({ name: "cached", description: "c", content: "c" });
    let hydratorCalled = false;
    h.setHydrator(async () => {
      hydratorCalled = true;
      return [];
    });
    const result = await h.require("cached");
    expect(result.name).toBe("cached");
    expect(hydratorCalled).toBe(false);
  });
});

describe("setHydrator — swapping and detaching the source", () => {
  it("detaches the source when handed `undefined`", async () => {
    const h = await makeHarness();
    h.setHydrator(hydrateFrom([{ name: "sourced", description: "s", content: "s" }]));
    expect((await h.reload()).added).toEqual(["sourced"]);

    h.setHydrator(undefined);
    expect(await h.resolve("also-sourced")).toBeNull();
    expect(await h.reload({ pruneMissing: true })).toEqual({
      added: [],
      updated: [],
      removed: [],
    });
    // Detaching the source does not un-register what it already produced.
    expect(h.has("sourced")).toBe(true);
  });
});

describe("reload is an OP, genesis is a seed", () => {
  it("a source-less harness reloads to nothing touched", async () => {
    const h = await makeHarness();
    expect(await h.reload({ pruneMissing: true })).toEqual({
      added: [],
      updated: [],
      removed: [],
    });
  });

  it("reload writes through the store; genesis does not", async () => {
    const mutations: unknown[] = [];
    const records: SkillsRegisterInput[] = [{ name: "s", description: "d", content: "c" }];
    const store = {
      backend: "spy",
      query: async () => [],
      mutate: async (m: unknown) => {
        mutations.push(m);
      },
    };
    const seeded = new SkillsHarness(
      `test:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      { store, hydrate: hydrateFrom(records) },
    );
    await seeded.ready;
    await seeded.hydrate();
    expect(seeded.has("s")).toBe(true);
    // The seed law: genesis never wrote.
    expect(mutations).toEqual([]);

    // A reload of a NEW record goes through `skills:register`, which writes.
    records.push({ name: "later", description: "d", content: "c" });
    await seeded.reload();
    expect(mutations).toHaveLength(1);
    await seeded.close();
  });
});
