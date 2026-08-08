/**
 * The named hydrators (ADR 93 D3) — the source unification for prompts.
 *
 * Pins:
 *  - `hydrateFrom` round-trips literal records (render functions intact)
 *  - `hydrateFromModule`'s default picker handles a `default`-exported single
 *    record, an array, a named `prompts` collection, and a custom picker — and
 *    preserves `render` functions, the reason this source exists
 *  - `hydrateFromStaticUrl` accepts template-only prompts and REFUSES any prompt
 *    carrying `render`, with a legible error
 *  - `hydrateFromStore` reads the declaration slice through `ctx.store` and is NOT
 *    a default
 *  - `composeHydrators` concatenates in INPUT order, LAST-wins on a duplicate
 *    name (the override ladder that puts module code over the durable slice)
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, generateId } from "@agentick/runtime";

import { PromptsHarness } from "../harness.js";
import { InMemoryPromptStore } from "../store.js";
import {
  composeHydrators,
  hydrateFrom,
  hydrateFromModule,
  hydrateFromStaticUrl,
  hydrateFromStore,
} from "../hydrators.js";
import type { PromptsHydrateCtx } from "../definition.js";

/**
 * Literal / module / URL / composed hydrators never touch the ctx — only
 * `hydrateFromStore` reads the `store` facet, and it is exercised through a real
 * harness below (where the ctx is the branded derived one).
 */
const noCtx = {} as PromptsHydrateCtx;

describe("hydrateFrom — the literal source", () => {
  it("yields literal records", async () => {
    const records = await hydrateFrom([
      { declaration: { name: "a", description: "a", template: "hi" } },
    ])(noCtx);
    expect(records).toHaveLength(1);
    expect(records[0]!.declaration.name).toBe("a");
  });

  it("preserves render functions across the boundary", async () => {
    const render = (args: Record<string, unknown>) => `rendered ${String(args.x)}`;
    const records = await hydrateFrom([{ declaration: { name: "p", description: "p", render } }])(
      noCtx,
    );
    expect(records[0]!.declaration.render).toBe(render);
  });
});

describe("hydrateFromModule — the function-carrying source", () => {
  it("picks a default-exported single prompt", async () => {
    const records = await hydrateFromModule({
      specifier: "doesn't-matter",
      import: async () => ({
        default: { declaration: { name: "p", description: "p", template: "hi" } },
      }),
    })(noCtx);
    expect(records).toHaveLength(1);
    expect(records[0]!.declaration.name).toBe("p");
  });

  it("picks a default-exported array of prompts", async () => {
    const records = await hydrateFromModule({
      specifier: "doesn't-matter",
      import: async () => ({
        default: [
          { declaration: { name: "a", description: "a", template: "a" } },
          { declaration: { name: "b", description: "b", template: "b" } },
        ],
      }),
    })(noCtx);
    expect(records).toHaveLength(2);
  });

  it("picks a named `prompts` array when default is absent", async () => {
    const records = await hydrateFromModule({
      specifier: "doesn't-matter",
      import: async () => ({
        prompts: [{ declaration: { name: "n", description: "n", template: "n" } }],
      }),
    })(noCtx);
    expect(records).toHaveLength(1);
  });

  it("yields empty when neither default nor prompts present", async () => {
    const records = await hydrateFromModule({
      specifier: "doesn't-matter",
      import: async () => ({ irrelevant: true }),
    })(noCtx);
    expect(records).toEqual([]);
  });

  it("honors a custom picker", async () => {
    const records = await hydrateFromModule({
      specifier: "doesn't-matter",
      import: async () => ({
        myPrompts: { declaration: { name: "c", description: "c", template: "c" } },
      }),
      picker: (mod: unknown) => (mod as { myPrompts: unknown }).myPrompts as never,
    })(noCtx);
    expect(records).toHaveLength(1);
    expect(records[0]!.declaration.name).toBe("c");
  });

  it("preserves render functions", async () => {
    const render = () => "ok";
    const records = await hydrateFromModule({
      specifier: "doesn't-matter",
      import: async () => ({ default: { declaration: { name: "x", description: "x", render } } }),
    })(noCtx);
    expect(records[0]!.declaration.render).toBe(render);
  });
});

describe("hydrateFromStaticUrl — the template-only manifest source", () => {
  it("loads template-only prompts from a JSON manifest", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          prompts: [{ declaration: { name: "p", description: "p", template: "tpl" } }],
        }),
        { status: 200 },
      )) as typeof fetch;
    const records = await hydrateFromStaticUrl({
      url: "https://example/prompts.json",
      fetch: fakeFetch,
    })(noCtx);
    expect(records).toHaveLength(1);
    expect(records[0]!.declaration.template).toBe("tpl");
  });

  it("refuses a prompt with a `render` field (functions can't survive URL)", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          prompts: [{ declaration: { name: "p", description: "p", render: "(not a fn)" } }],
        }),
        { status: 200 },
      )) as typeof fetch;
    await expect(
      hydrateFromStaticUrl({ url: "https://example/x", fetch: fakeFetch })(noCtx),
    ).rejects.toThrow(/must be template-only/);
  });

  it("supports arrayField: null (top-level array)", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify([{ declaration: { name: "x", description: "x", template: "x" } }]),
        { status: 200 },
      )) as typeof fetch;
    const records = await hydrateFromStaticUrl({
      url: "https://example/x",
      fetch: fakeFetch,
      arrayField: null,
    })(noCtx);
    expect(records).toHaveLength(1);
  });
});

describe("hydrateFromStore — the store-read source", () => {
  it("reads the declaration slice through ctx.store", async () => {
    const store = new InMemoryPromptStore();
    await store.mutate({ put: { name: "durable", description: "d" } }, {} as never);
    const h = new PromptsHarness(
      `test:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      { store, hydrate: hydrateFromStore() },
    );
    await h.ready;
    await h.hydrate();
    expect(h.list().map((d) => d.name)).toEqual(["durable"]);
    // Record-only: a store round-trip cannot carry content.
    expect(h.get("durable")?.template).toBeUndefined();
    expect(h.get("durable")?.render).toBeUndefined();
    await h.close();
  });

  it("is NOT a default — a store alone loads nothing", async () => {
    const store = new InMemoryPromptStore();
    await store.mutate({ put: { name: "durable", description: "d" } }, {} as never);
    const h = new PromptsHarness(
      `test:${generateId()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      { store },
    );
    await h.ready;
    await h.hydrate();
    expect(h.list()).toEqual([]);
    await h.close();
  });
});

describe("composeHydrators — the multi-source form", () => {
  it("concatenates in INPUT order, not completion order", async () => {
    const records = await composeHydrators(
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return [{ declaration: { name: "slow", description: "s", template: "s" } }];
      },
      hydrateFrom([{ declaration: { name: "fast", description: "f", template: "f" } }]),
    )(noCtx);
    expect(records.map((r) => r.declaration.name)).toEqual(["slow", "fast"]);
  });

  it("resolves a duplicate name LAST-wins, so module CODE shadows the store slice", async () => {
    const render = (): string => "from code";
    const records = await composeHydrators(
      hydrateFrom([{ declaration: { name: "x", description: "record only" } }]),
      hydrateFrom([{ declaration: { name: "x", description: "with code", render } }]),
    )(noCtx);
    expect(records).toHaveLength(1);
    expect(records[0]!.declaration.render).toBe(render);
  });

  it("one rejecting source rejects the whole composition", async () => {
    const boom = new Error("manifest unreachable");
    await expect(
      composeHydrators(
        hydrateFrom([{ declaration: { name: "ok", description: "o", template: "o" } }]),
        () => Promise.reject(boom),
      )(noCtx),
    ).rejects.toBe(boom);
  });

  it("composing nothing yields nothing", async () => {
    expect(await composeHydrators()(noCtx)).toEqual([]);
  });
});
