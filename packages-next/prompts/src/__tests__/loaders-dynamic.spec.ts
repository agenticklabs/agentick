/**
 * Prompts harness — dynamic loader surface.
 *
 * Pins:
 *  - `reload()` adds + updates + (opt-in) removes
 *  - `resolve(name)` returns cached or lazy-loads
 *  - `invoke({ name })` triggers lookup-on-miss before throwing PromptNotFound
 *  - `get({ name })` same lookup-on-miss path
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";
import type { PromptsRegisterInput } from "@agentick/spec-next";
import { PromptNotFound } from "@agentick/spec-next";

import { PromptsHarness } from "../harness.js";
import { fromArray } from "../loaders.js";

async function makeHarness(): Promise<PromptsHarness> {
  const harness = new PromptsHarness(
    `test:${ulid()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {},
  );
  await harness.ready;
  return harness;
}

describe("PromptsHarness.reload", () => {
  it("adds new declarations from loaders", async () => {
    const h = await makeHarness();
    const records: PromptsRegisterInput[] = [];
    h.setLoaders([fromArray(records)]);

    records.push({ declaration: { name: "first", description: "f", template: "t" } });
    const summary = await h.reload();
    expect(summary.added).toEqual(["first"]);
    expect(h.has("first")).toBe(true);
  });

  it("updates existing declarations when loaders supply new fields", async () => {
    const h = await makeHarness();
    const records: PromptsRegisterInput[] = [
      { declaration: { name: "x", description: "old", template: "t" } },
    ];
    h.setLoaders([fromArray(records)]);

    await h.reload();
    records.length = 0;
    records.push({
      declaration: { name: "x", description: "new description", template: "t2" },
    });

    const summary = await h.reload();
    expect(summary.updated).toEqual(["x"]);
    expect(h.getDeclaration("x")?.description).toBe("new description");
    expect(h.getDeclaration("x")?.template).toBe("t2");
  });

  it("removes declarations gone from sources when pruneMissing: true", async () => {
    const h = await makeHarness();
    const records: PromptsRegisterInput[] = [
      { declaration: { name: "alpha", description: "a", template: "a" } },
      { declaration: { name: "beta", description: "b", template: "b" } },
    ];
    h.setLoaders([fromArray(records)]);

    await h.reload();
    records.length = 0;
    records.push({ declaration: { name: "alpha", description: "a", template: "a" } });

    const summary = await h.reload({ pruneMissing: true });
    expect(summary.removed).toEqual(["beta"]);
    expect(h.has("beta")).toBe(false);
  });
});

describe("PromptsHarness.resolve", () => {
  it("lazy-loads from configured loaders on cache miss", async () => {
    const h = await makeHarness();
    h.setLoaders([fromArray([{ declaration: { name: "p", description: "p", template: "hi" } }])]);

    expect(h.has("p")).toBe(false);
    const result = await h.resolve("p");
    expect(result?.name).toBe("p");
    expect(h.has("p")).toBe(true);
  });

  it("returns null when no loader has the name", async () => {
    const h = await makeHarness();
    h.setLoaders([
      fromArray([{ declaration: { name: "other", description: "o", template: "x" } }]),
    ]);
    const result = await h.resolve("missing");
    expect(result).toBeNull();
  });
});

describe("PromptsHarness lookup-on-miss in invoke / get", () => {
  it("invoke() transparently resolves an unregistered name", async () => {
    const h = await makeHarness();
    h.setLoaders([
      fromArray([
        {
          declaration: {
            name: "summarize",
            description: "summarize",
            template: "Summarize the doc.",
          },
        },
      ]),
    ]);

    // No initial register — invoke should still succeed.
    const result = await h.invoke({ name: "summarize" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("system");
  });

  it("get() transparently resolves an unregistered name", async () => {
    const h = await makeHarness();
    h.setLoaders([
      fromArray([{ declaration: { name: "greet", description: "g", template: "Hello." } }]),
    ]);

    const result = await h.get({ name: "greet" });
    expect(result.description).toBe("g");
  });

  it("invoke() still throws PromptNotFound when no loader has the name", async () => {
    const h = await makeHarness();
    h.setLoaders([
      fromArray([{ declaration: { name: "alpha", description: "a", template: "a" } }]),
    ]);

    await expect(h.invoke({ name: "unknown" })).rejects.toBeInstanceOf(PromptNotFound);
  });

  it("invoke() bypasses loader fallback when name is already registered", async () => {
    const h = await makeHarness();
    // Pre-register
    await h.register({
      declaration: { name: "cached", description: "c", template: "cached body" },
    });
    let loaderCalled = false;
    h.setLoaders([
      {
        load: async () => {
          loaderCalled = true;
          return [];
        },
      },
    ]);
    await h.invoke({ name: "cached" });
    expect(loaderCalled).toBe(false);
  });
});

describe("PromptsHarness.require", () => {
  it("returns the declaration on hit (no render)", async () => {
    const h = await makeHarness();
    h.setLoaders([fromArray([{ declaration: { name: "p", description: "p", template: "hi" } }])]);
    const decl = await h.require("p");
    expect(decl.name).toBe("p");
    expect(decl.description).toBe("p");
  });

  it("throws PromptNotFound when no source has the name", async () => {
    const h = await makeHarness();
    h.setLoaders([
      fromArray([{ declaration: { name: "other", description: "o", template: "x" } }]),
    ]);
    await expect(h.require("missing")).rejects.toBeInstanceOf(PromptNotFound);
  });

  it("returns from cache without consulting loaders when already registered", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: { name: "cached", description: "c", template: "x" },
    });
    let loaderCalled = false;
    h.setLoaders([
      {
        load: async () => {
          loaderCalled = true;
          return [];
        },
      },
    ]);
    await h.require("cached");
    expect(loaderCalled).toBe(false);
  });
});
