/**
 * The universal named hydrators (ADR 93 D3) — the source unification.
 *
 * Pins:
 *  - `hydrateFrom` yields the literal array (the deleted `initial:`'s replacement)
 *  - `hydrateFromUrl` parses the default `skills:` shape + `arrayField: null`,
 *    and raises a legible error on a missing field / non-array body
 *  - `hydrateFromManifest` is the same function under a call-site-friendly name
 *  - `hydrateFromStore` reads the definition's own store through `ctx.store`
 *  - `composeHydrators` runs sources concurrently, concatenates in INPUT order,
 *    and resolves a duplicate name LAST-wins (the override ladder)
 *  - one rejecting source rejects the composition (no partial success)
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { Skill } from "@agentick/spec";

import { SkillsHarness } from "../harness.js";
import { InMemorySkillStore } from "../store.js";
import {
  composeHydrators,
  hydrateFrom,
  hydrateFromManifest,
  hydrateFromStore,
  hydrateFromUrl,
} from "../hydrators.js";
import type { SkillsHydrateCtx } from "../definition.js";

/**
 * Literal / URL / composed hydrators never touch the ctx — only
 * `hydrateFromStore` reads the `store` facet, and it is exercised through a real
 * harness below (where the ctx is the branded derived one).
 */
const noCtx = {} as SkillsHydrateCtx;

async function harness(
  options: ConstructorParameters<typeof SkillsHarness>[4] = {},
): Promise<SkillsHarness> {
  const h = new SkillsHarness(
    `test:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    options,
  );
  await h.ready;
  return h;
}

describe("hydrateFrom — the literal source", () => {
  it("yields the array verbatim", async () => {
    const records = await hydrateFrom([
      { name: "a", description: "a", content: "AA" },
      { name: "b", description: "b", content: "BB" },
    ])(noCtx);
    expect(records.map((r) => r.name)).toEqual(["a", "b"]);
  });

  it("re-reads the captured array, so a later mutation is visible", async () => {
    const records = [{ name: "a", description: "a", content: "AA" }];
    const hydrate = hydrateFrom(records);
    records.push({ name: "b", description: "b", content: "BB" });
    expect((await hydrate(noCtx)).map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("hydrateFromUrl — the manifest source", () => {
  const respond = (body: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;

  it("parses the default `skills:` field shape", async () => {
    const records = await hydrateFromUrl({
      url: "https://example/manifest.json",
      fetch: respond({ skills: [{ name: "x", description: "x", content: "xx" }] }),
    })(noCtx);
    expect(records.map((r) => r.name)).toEqual(["x"]);
  });

  it("supports arrayField: null (a top-level array)", async () => {
    const records = await hydrateFromUrl({
      url: "https://example/array.json",
      fetch: respond([{ name: "a", description: "a", content: "aa" }]),
      arrayField: null,
    })(noCtx);
    expect(records).toHaveLength(1);
  });

  it("raises on a missing arrayField", async () => {
    await expect(
      hydrateFromUrl({ url: "https://example/x", fetch: respond({ other: [] }) })(noCtx),
    ).rejects.toThrow(/missing "skills" field/);
  });

  it("raises when the field is not an array", async () => {
    await expect(
      hydrateFromUrl({ url: "https://example/x", fetch: respond({ skills: "nope" }) })(noCtx),
    ).rejects.toThrow(/not an array/);
  });

  it("hydrateFromManifest is the same function", () => {
    expect(hydrateFromManifest).toBe(hydrateFromUrl);
  });
});

describe("hydrateFromStore — the store-read source", () => {
  it("reads the definition's own store through ctx.store", async () => {
    const store = new InMemorySkillStore();
    const stored: Skill = {
      name: "durable",
      description: "d",
      content: "c",
      createdAt: 111,
      updatedAt: 222,
    };
    await store.mutate({ put: stored }, {} as never);

    const h = await harness({ store, hydrate: hydrateFromStore() });
    await h.hydrate();
    expect(h.list().map((s) => s.name)).toEqual(["durable"]);
    // Provenance survives: a store replay is not restamped as brand new.
    expect(h.get("durable")).toMatchObject({ createdAt: 111, updatedAt: 222 });
    await h.close();
  });

  it("an empty store opens an empty library", async () => {
    const h = await harness({ store: new InMemorySkillStore(), hydrate: hydrateFromStore() });
    await h.hydrate();
    expect(h.list()).toEqual([]);
    await h.close();
  });

  it("is NOT a default — a store alone loads nothing", async () => {
    const store = new InMemorySkillStore();
    await store.mutate(
      {
        put: { name: "durable", description: "d", content: "c", createdAt: 1, updatedAt: 1 },
      },
      {} as never,
    );
    const h = await harness({ store });
    await h.hydrate();
    expect(h.list()).toEqual([]);
    await h.close();
  });
});

describe("composeHydrators — the multi-source form", () => {
  it("concatenates in INPUT order, not completion order", async () => {
    const slow = async (): Promise<
      readonly { name: string; description: string; content: string }[]
    > => {
      await new Promise((r) => setTimeout(r, 5));
      return [{ name: "slow", description: "s", content: "s" }];
    };
    const records = await composeHydrators(
      slow,
      hydrateFrom([{ name: "fast", description: "f", content: "f" }]),
    )(noCtx);
    expect(records.map((r) => r.name)).toEqual(["slow", "fast"]);
  });

  it("resolves a duplicate name LAST-wins (the override ladder)", async () => {
    const records = await composeHydrators(
      hydrateFrom([{ name: "x", description: "FROM-STORE", content: "1" }]),
      hydrateFrom([{ name: "x", description: "FROM-DISK", content: "2" }]),
    )(noCtx);
    expect(records).toHaveLength(1);
    expect(records[0]!.description).toBe("FROM-DISK");
  });

  it("one rejecting source rejects the whole composition", async () => {
    const boom = new Error("manifest unreachable");
    await expect(
      composeHydrators(hydrateFrom([{ name: "ok", description: "o", content: "o" }]), () =>
        Promise.reject(boom),
      )(noCtx),
    ).rejects.toBe(boom);
  });

  it("composing nothing yields nothing", async () => {
    expect(await composeHydrators()(noCtx)).toEqual([]);
  });
});
