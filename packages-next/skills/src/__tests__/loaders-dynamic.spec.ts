/**
 * Skills harness — dynamic loader surface.
 *
 * Pins:
 *  - `reload()` adds new entries from configured loaders
 *  - `reload()` updates entries whose content changed
 *  - `reload({ pruneMissing: true })` removes entries gone from sources
 *  - `resolve(name)` returns registered skill from cache
 *  - `resolve(name)` lazy-loads via loader.lookup on miss
 *  - `resolve(name)` returns null when no loader has the name
 *  - `resolve(name)` falls back to load() + filter when lookup is absent
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { Loader } from "@agentick/utils-next/loaders";
import type { SkillsRegisterInput } from "@agentick/spec-next";

import { SkillsHarness } from "../harness.js";
import { fromArray } from "../loaders.js";

async function makeHarness(): Promise<SkillsHarness> {
  const harness = new SkillsHarness(
    `test:${ulid()}`,
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
    h.setLoaders([fromArray(records)]);

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
    h.setLoaders([fromArray(records)]);

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
    h.setLoaders([fromArray(records)]);

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
    h.setLoaders([fromArray(records)]);

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
    h.setLoaders([fromArray(records)]);
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

  it("lazy-loads via loader.lookup on cache miss", async () => {
    const h = await makeHarness();
    const records: SkillsRegisterInput[] = [{ name: "lazy", description: "l", content: "L" }];
    h.setLoaders([fromArray(records)]);

    expect(h.has("lazy")).toBe(false);
    const result = await h.resolve("lazy");
    expect(result?.name).toBe("lazy");
    expect(h.has("lazy")).toBe(true);
  });

  it("returns null when no loader has the name", async () => {
    const h = await makeHarness();
    h.setLoaders([fromArray([{ name: "alpha", description: "a", content: "a" }])]);
    const result = await h.resolve("does-not-exist");
    expect(result).toBeNull();
  });

  it("falls back to load() + filter for loaders without `lookup`", async () => {
    const h = await makeHarness();
    const records: SkillsRegisterInput[] = [{ name: "lazy", description: "l", content: "L" }];
    // Hand-build a Loader that DOESN'T implement lookup.
    const bareLoader: Loader<SkillsRegisterInput> = {
      load: async () => records,
    };
    h.setLoaders([bareLoader]);
    const result = await h.resolve("lazy");
    expect(result?.name).toBe("lazy");
  });

  it("queries loaders in order; first hit wins", async () => {
    const h = await makeHarness();
    h.setLoaders([
      fromArray([{ name: "x", description: "FIRST", content: "1" }]),
      fromArray([{ name: "x", description: "SECOND", content: "2" }]),
    ]);
    const result = await h.resolve("x");
    expect(result?.description).toBe("FIRST");
  });
});
