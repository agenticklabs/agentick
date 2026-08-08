/**
 * Prompts harness — the dynamic SOURCE surface, now driven by the ONE genesis seam
 * (ADR 93 rendered-moot #3: sources are hydrators).
 *
 * Pins:
 *  - `reload()` adds + updates + (opt-in) removes
 *  - `resolve(name)` returns the cached declaration or re-runs the hydrator
 *  - `invoke({ name })` triggers lookup-on-miss before throwing PromptNotFound
 *  - `render({ name })` takes the same lookup-on-miss path
 *  - a source-less harness never re-runs anything
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";
import type { PromptsRegisterInput } from "@agentick/spec";
import { PromptNotFound } from "@agentick/spec";

import { PromptsHarness } from "../harness.js";
import { hydrateFrom } from "../hydrators.js";

async function makeHarness(): Promise<PromptsHarness> {
  const harness = new PromptsHarness(
    `test:${generateId()}`,
    new MemoryJournal({ capacity: 1024 }),
    new LocalEventBus(),
    new LocalInbox(),
    {},
  );
  await harness.ready;
  return harness;
}

describe("PromptsHarness.reload", () => {
  it("adds new declarations from the source hydrator", async () => {
    const h = await makeHarness();
    const records: PromptsRegisterInput[] = [];
    h.setHydrator(hydrateFrom(records));

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
    h.setHydrator(hydrateFrom(records));

    await h.reload();
    records.length = 0;
    records.push({
      declaration: { name: "x", description: "new description", template: "t2" },
    });

    const summary = await h.reload();
    expect(summary.updated).toEqual(["x"]);
    expect(h.get("x")?.description).toBe("new description");
    expect(h.get("x")?.template).toBe("t2");
  });

  it("removes declarations gone from sources when pruneMissing: true", async () => {
    const h = await makeHarness();
    const records: PromptsRegisterInput[] = [
      { declaration: { name: "alpha", description: "a", template: "a" } },
      { declaration: { name: "beta", description: "b", template: "b" } },
    ];
    h.setHydrator(hydrateFrom(records));

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
    h.setHydrator(hydrateFrom([{ declaration: { name: "p", description: "p", template: "hi" } }]));

    expect(h.has("p")).toBe(false);
    const result = await h.resolve("p");
    expect(result?.name).toBe("p");
    expect(h.has("p")).toBe(true);
  });

  it("returns null when no loader has the name", async () => {
    const h = await makeHarness();
    h.setHydrator(
      hydrateFrom([{ declaration: { name: "other", description: "o", template: "x" } }]),
    );
    const result = await h.resolve("missing");
    expect(result).toBeNull();
  });
});

describe("PromptsHarness lookup-on-miss in invoke / get", () => {
  it("invoke() transparently resolves an unregistered name", async () => {
    const h = await makeHarness();
    h.setHydrator(
      hydrateFrom([
        {
          declaration: {
            name: "summarize",
            description: "summarize",
            template: "Summarize the doc.",
          },
        },
      ]),
    );

    // No initial register — invoke should still succeed.
    const result = await h.invoke({ name: "summarize" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.role).toBe("system");
  });

  it("get() transparently resolves an unregistered name", async () => {
    const h = await makeHarness();
    h.setHydrator(
      hydrateFrom([{ declaration: { name: "greet", description: "g", template: "Hello." } }]),
    );

    const result = await h.render({ name: "greet" });
    expect(result.description).toBe("g");
  });

  it("invoke() still throws PromptNotFound when the source lacks the name", async () => {
    const h = await makeHarness();
    h.setHydrator(
      hydrateFrom([{ declaration: { name: "alpha", description: "a", template: "a" } }]),
    );

    await expect(h.invoke({ name: "unknown" })).rejects.toBeInstanceOf(PromptNotFound);
  });

  it("invoke() skips the source re-run when the name is already registered", async () => {
    const h = await makeHarness();
    // Pre-register
    await h.register({
      declaration: { name: "cached", description: "c", template: "cached body" },
    });
    let hydratorCalled = false;
    h.setHydrator(async () => {
      hydratorCalled = true;
      return [];
    });
    await h.invoke({ name: "cached" });
    expect(hydratorCalled).toBe(false);
  });
});

describe("PromptsHarness.require", () => {
  it("returns the declaration on hit (no render)", async () => {
    const h = await makeHarness();
    h.setHydrator(hydrateFrom([{ declaration: { name: "p", description: "p", template: "hi" } }]));
    const decl = await h.require("p");
    expect(decl.name).toBe("p");
    expect(decl.description).toBe("p");
  });

  it("throws PromptNotFound when no source has the name", async () => {
    const h = await makeHarness();
    h.setHydrator(
      hydrateFrom([{ declaration: { name: "other", description: "o", template: "x" } }]),
    );
    await expect(h.require("missing")).rejects.toBeInstanceOf(PromptNotFound);
  });

  it("returns from cache without re-running the hydrator when already registered", async () => {
    const h = await makeHarness();
    await h.register({
      declaration: { name: "cached", description: "c", template: "x" },
    });
    let hydratorCalled = false;
    h.setHydrator(async () => {
      hydratorCalled = true;
      return [];
    });
    await h.require("cached");
    expect(hydratorCalled).toBe(false);
  });
});

describe("setHydrator — detaching the source", () => {
  it("detaches the source when handed `undefined`", async () => {
    const h = await makeHarness();
    h.setHydrator(
      hydrateFrom([{ declaration: { name: "sourced", description: "s", template: "s" } }]),
    );
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

describe("a source-less harness", () => {
  it("reloads to nothing touched and resolves to null", async () => {
    const h = await makeHarness();
    expect(await h.reload({ pruneMissing: true })).toEqual({
      added: [],
      updated: [],
      removed: [],
    });
    expect(await h.resolve("anything")).toBeNull();
    await expect(h.invoke({ name: "anything" })).rejects.toBeInstanceOf(PromptNotFound);
  });
});
