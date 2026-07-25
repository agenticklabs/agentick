/**
 * Prompt loaders — `fromArray` / `fromModule` / `fromStaticUrl`.
 *
 * Pins:
 *  - `fromArray` round-trips literal records (functions intact)
 *  - `fromModule` default picker handles `default`-exported single +
 *    array + named `prompts` collection + custom picker
 *  - `fromStaticUrl` accepts template-only prompts; refuses any prompt
 *    carrying `render` with a helpful error
 *  - end-to-end via PromptsHarness drive of the same code path
 */

import { describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime";

import { PromptsHarness } from "../harness.js";
import { fromArray, fromModule, fromStaticUrl } from "../loaders.js";

describe("fromArray", () => {
  it("yields literal records", async () => {
    const records = await fromArray([
      { declaration: { name: "a", description: "a", template: "hi" } },
    ]).load();
    expect(records).toHaveLength(1);
    expect(records[0]!.declaration.name).toBe("a");
  });

  it("preserves render functions across the boundary", async () => {
    const render = (args: Record<string, unknown>) => `rendered ${String(args.x)}`;
    const records = await fromArray([
      { declaration: { name: "p", description: "p", render } },
    ]).load();
    expect(records[0]!.declaration.render).toBe(render);
  });
});

describe("fromModule", () => {
  it("picks a default-exported single prompt", async () => {
    const records = await fromModule({
      specifier: "doesn't-matter",
      import: async () => ({
        default: { declaration: { name: "p", description: "p", template: "hi" } },
      }),
    }).load();
    expect(records).toHaveLength(1);
    expect(records[0]!.declaration.name).toBe("p");
  });

  it("picks a default-exported array of prompts", async () => {
    const records = await fromModule({
      specifier: "doesn't-matter",
      import: async () => ({
        default: [
          { declaration: { name: "a", description: "a", template: "a" } },
          { declaration: { name: "b", description: "b", template: "b" } },
        ],
      }),
    }).load();
    expect(records).toHaveLength(2);
  });

  it("picks a named `prompts` array when default is absent", async () => {
    const records = await fromModule({
      specifier: "doesn't-matter",
      import: async () => ({
        prompts: [{ declaration: { name: "n", description: "n", template: "n" } }],
      }),
    }).load();
    expect(records).toHaveLength(1);
  });

  it("yields empty when neither default nor prompts present", async () => {
    const records = await fromModule({
      specifier: "doesn't-matter",
      import: async () => ({ irrelevant: true }),
    }).load();
    expect(records).toEqual([]);
  });

  it("honors a custom picker", async () => {
    const records = await fromModule({
      specifier: "doesn't-matter",
      import: async () => ({
        myPrompts: { declaration: { name: "c", description: "c", template: "c" } },
      }),
      picker: (mod) => (mod as { myPrompts: unknown }).myPrompts as never,
    }).load();
    expect(records).toHaveLength(1);
    expect(records[0]!.declaration.name).toBe("c");
  });

  it("preserves render functions", async () => {
    const render = () => "ok";
    const records = await fromModule({
      specifier: "doesn't-matter",
      import: async () => ({ default: { declaration: { name: "x", description: "x", render } } }),
    }).load();
    expect(records[0]!.declaration.render).toBe(render);
  });
});

describe("fromStaticUrl", () => {
  it("loads template-only prompts from a JSON manifest", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          prompts: [{ declaration: { name: "p", description: "p", template: "tpl" } }],
        }),
        { status: 200 },
      )) as typeof fetch;
    const records = await fromStaticUrl({
      url: "https://example/prompts.json",
      fetch: fakeFetch,
    }).load();
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
      fromStaticUrl({ url: "https://example/x", fetch: fakeFetch }).load(),
    ).rejects.toThrow(/must be template-only/);
  });

  it("supports arrayField: null (top-level array)", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify([{ declaration: { name: "x", description: "x", template: "x" } }]),
        { status: 200 },
      )) as typeof fetch;
    const records = await fromStaticUrl({
      url: "https://example/x",
      fetch: fakeFetch,
      arrayField: null,
    }).load();
    expect(records).toHaveLength(1);
  });
});

describe("withPrompts({ loaders }) end-to-end", () => {
  it("registers prompts from loaders via the same code path", async () => {
    const harness = new PromptsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
      {},
    );
    await harness.ready;

    const loaders = [
      fromArray([{ declaration: { name: "a", description: "a", template: "a" } }]),
      fromArray([{ declaration: { name: "b", description: "b", template: "b" } }]),
    ];

    const batches = await Promise.all(loaders.map((l) => l.load()));
    for (const batch of batches) {
      for (const decl of batch) {
        await harness.register(decl);
      }
    }

    expect(
      harness
        .list()
        .map((d) => d.name)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});
