/**
 * Platform-agnostic loader primitives.
 *
 * Pins:
 *  - `sourceFromArray` yields the input verbatim
 *  - `mergeLoaders` concatenates in input order (NOT completion order)
 *  - `mapLoader` transforms and drops `null` / `undefined`
 *  - `sourceFromUrl` calls `fetch`, throws on non-OK, passes Response to parse
 *  - `sourceFromModule` dynamic-imports and applies the picker (single + array)
 *  - `extractFrontmatter` handles delimiter scan, missing close, no frontmatter
 */

import { describe, expect, it } from "vitest";

import {
  extractFrontmatter,
  mapLoader,
  mergeLoaders,
  sourceFromArray,
  sourceFromModule,
  sourceFromUrl,
  type Loader,
} from "../index.js";

describe("sourceFromArray", () => {
  it("yields the array verbatim", async () => {
    const l = sourceFromArray([1, 2, 3]);
    expect(await l.load()).toEqual([1, 2, 3]);
  });

  it("yields empty when given empty", async () => {
    const l = sourceFromArray<number>([]);
    expect(await l.load()).toEqual([]);
  });
});

describe("mergeLoaders", () => {
  it("concatenates batches in input order", async () => {
    const l = mergeLoaders(sourceFromArray([1, 2]), sourceFromArray([3, 4]));
    expect(await l.load()).toEqual([1, 2, 3, 4]);
  });

  it("preserves input order even when later loaders resolve first", async () => {
    const slow: Loader<number> = {
      load: () => new Promise((r) => setTimeout(() => r([1, 2]), 10)),
    };
    const fast = sourceFromArray([3, 4]);
    expect(await mergeLoaders(slow, fast).load()).toEqual([1, 2, 3, 4]);
  });

  it("rejects if any underlying loader rejects", async () => {
    const broken: Loader<number> = {
      load: () => Promise.reject(new Error("boom")),
    };
    await expect(mergeLoaders(sourceFromArray([1]), broken).load()).rejects.toThrow("boom");
  });
});

describe("mapLoader", () => {
  it("transforms each record", async () => {
    const l = mapLoader(sourceFromArray([1, 2, 3]), (n) => n * 10);
    expect(await l.load()).toEqual([10, 20, 30]);
  });

  it("supports async mappers", async () => {
    const l = mapLoader(sourceFromArray([1, 2]), async (n) => n + 100);
    expect(await l.load()).toEqual([101, 102]);
  });

  it("drops records where mapper returns null / undefined", async () => {
    const l = mapLoader(sourceFromArray([1, 2, 3, 4]), (n) => (n % 2 === 0 ? n : null));
    expect(await l.load()).toEqual([2, 4]);
  });
});

describe("sourceFromUrl", () => {
  it("calls fetch with the given URL and passes Response to parse", async () => {
    const seen: string[] = [];
    const fakeFetch = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify([{ id: "a" }, { id: "b" }]), { status: 200 });
    }) as typeof fetch;

    const l = sourceFromUrl<{ id: string }>({
      url: "https://example/manifest.json",
      fetch: fakeFetch,
      parse: async (res) => (await res.json()) as readonly { id: string }[],
    });
    expect(await l.load()).toEqual([{ id: "a" }, { id: "b" }]);
    expect(seen).toEqual(["https://example/manifest.json"]);
  });

  it("throws on non-OK status by default", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 500, statusText: "Server Error" })) as typeof fetch;
    const l = sourceFromUrl({
      url: "https://example/x",
      fetch: fakeFetch,
      parse: async () => [],
    });
    await expect(l.load()).rejects.toThrow(/HTTP 500/);
  });

  it("honors acceptStatuses for statuses fetch would otherwise reject", async () => {
    // 418 is `!ok` per the standard but ergonomically might be a custom
    // success signal for a particular API.
    const fakeFetch = (async () => new Response("[]", { status: 418 })) as typeof fetch;
    const l = sourceFromUrl<unknown>({
      url: "https://example/x",
      fetch: fakeFetch,
      acceptStatuses: [200, 418],
      parse: async (res) => (await res.json()) as readonly unknown[],
    });
    expect(await l.load()).toEqual([]);
  });
});

describe("sourceFromModule", () => {
  it("picks a single record from the module", async () => {
    const l = sourceFromModule<{ name: string }>({
      specifier: "doesn't-matter",
      import: async () => ({ default: { name: "p1" } }),
      picker: (m) => (m as { default: { name: string } }).default,
    });
    expect(await l.load()).toEqual([{ name: "p1" }]);
  });

  it("picks an array of records from the module", async () => {
    const l = sourceFromModule<{ name: string }>({
      specifier: "doesn't-matter",
      import: async () => ({ prompts: [{ name: "a" }, { name: "b" }] }),
      picker: (m) => (m as { prompts: readonly { name: string }[] }).prompts,
    });
    expect(await l.load()).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("yields empty when picker returns undefined", async () => {
    const l = sourceFromModule<{ name: string }>({
      specifier: "doesn't-matter",
      import: async () => ({}),
      picker: () => undefined,
    });
    expect(await l.load()).toEqual([]);
  });

  it("preserves functions across the load boundary", async () => {
    const fn = (n: number) => n + 1;
    const l = sourceFromModule<{ render: (n: number) => number }>({
      specifier: "doesn't-matter",
      import: async () => ({ default: { render: fn } }),
      picker: (m) => (m as { default: { render: typeof fn } }).default,
    });
    const loaded = await l.load();
    expect(loaded[0]!.render(41)).toBe(42);
  });
});

describe("extractFrontmatter", () => {
  it("extracts a YAML-style block", () => {
    const input = "---\nname: x\ndescription: y\n---\nbody text here";
    const { frontmatter, body } = extractFrontmatter(input);
    expect(frontmatter).toBe("name: x\ndescription: y");
    expect(body).toBe("body text here");
  });

  it("passes through unchanged when no frontmatter", () => {
    const input = "just some content";
    const result = extractFrontmatter(input);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe("just some content");
  });

  it("passes through unchanged when the closing delimiter is missing", () => {
    const input = "---\nname: x\nbody but no close";
    const result = extractFrontmatter(input);
    expect(result.frontmatter).toBeNull();
    expect(result.body).toBe(input);
  });

  it("handles leading whitespace before the opening delimiter", () => {
    const input = "\n\n---\nname: x\n---\nbody";
    const result = extractFrontmatter(input);
    expect(result.frontmatter).toBe("name: x");
    expect(result.body).toBe("body");
  });

  it("supports custom delimiters", () => {
    const input = "+++\nname: x\n+++\nbody";
    const result = extractFrontmatter(input, { delimiter: "+++" });
    expect(result.frontmatter).toBe("name: x");
    expect(result.body).toBe("body");
  });

  it("preserves empty body when content ends at the closing delimiter", () => {
    const input = "---\nname: x\n---\n";
    const result = extractFrontmatter(input);
    expect(result.frontmatter).toBe("name: x");
    expect(result.body).toBe("");
  });
});

describe("composition", () => {
  it("array → map → merge flows end-to-end", async () => {
    const a = mapLoader(sourceFromArray([1, 2]), (n) => ({ value: n * 10 }));
    const b = mapLoader(sourceFromArray([3, 4]), (n) => ({ value: n * 10 }));
    const merged = mergeLoaders(a, b);
    expect(await merged.load()).toEqual([
      { value: 10 },
      { value: 20 },
      { value: 30 },
      { value: 40 },
    ]);
  });
});
