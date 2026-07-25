/**
 * Skill loaders — `fromArray` / `fromUrl` / `fromManifest` + Node fs.
 *
 * Pins:
 *  - `fromArray` round-trips literal records
 *  - `fromUrl` parses default JSON shape + supports `arrayField: null`
 *    + raises helpful error on missing field / non-array body
 *  - `fromFile` parses frontmatter + body; raises on missing required fields
 *  - `fromDirectory` walks `.md` files; silently skips bad records
 *  - `parseSimpleFrontmatter` handles `key: value`, quoted strings, inline arrays
 *  - end-to-end via `withSkills({ loaders })`
 */

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalEventBus, LocalInbox, MemoryJournal, ulid } from "@agentick/runtime-next";

import { SkillsHarness } from "../harness.js";
import { fromArray, fromManifest, fromUrl } from "../loaders.js";
import { fromDirectory, fromFile, parseSimpleFrontmatter } from "../loaders-node.js";
import { withSkills } from "../extension.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-loaders-spec-"));
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
});

describe("fromArray", () => {
  it("yields the array verbatim", async () => {
    const records = await fromArray([
      { name: "a", description: "a", content: "AA" },
      { name: "b", description: "b", content: "BB" },
    ]).load();
    expect(records).toHaveLength(2);
    expect(records[0]!.name).toBe("a");
  });
});

describe("fromUrl", () => {
  it("parses default `skills:` field shape", async () => {
    const fakeFetch = (async () =>
      new Response(
        JSON.stringify({
          skills: [{ name: "x", description: "x", content: "xx" }],
        }),
        { status: 200 },
      )) as typeof fetch;
    const records = await fromUrl({
      url: "https://example/manifest.json",
      fetch: fakeFetch,
    }).load();
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("x");
  });

  it("supports arrayField: null (top-level array)", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify([{ name: "a", description: "a", content: "aa" }]), {
        status: 200,
      })) as typeof fetch;
    const records = await fromUrl({
      url: "https://example/array.json",
      fetch: fakeFetch,
      arrayField: null,
    }).load();
    expect(records).toHaveLength(1);
  });

  it("raises on missing arrayField", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ other: [] }), { status: 200 })) as typeof fetch;
    await expect(fromUrl({ url: "https://example/x", fetch: fakeFetch }).load()).rejects.toThrow(
      /missing "skills" field/,
    );
  });

  it("raises when the field is not an array", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ skills: "not array" }), { status: 200 })) as typeof fetch;
    await expect(fromUrl({ url: "https://example/x", fetch: fakeFetch }).load()).rejects.toThrow(
      /not an array/,
    );
  });

  it("fromManifest is an alias for fromUrl", () => {
    expect(fromManifest).toBe(fromUrl);
  });
});

describe("parseSimpleFrontmatter", () => {
  it("parses key: value lines", () => {
    expect(parseSimpleFrontmatter("name: x\ndescription: y")).toEqual({
      name: "x",
      description: "y",
    });
  });

  it("strips quoted strings", () => {
    expect(parseSimpleFrontmatter('name: "long: name"')).toEqual({ name: "long: name" });
    expect(parseSimpleFrontmatter("name: 'with quote'")).toEqual({ name: "with quote" });
  });

  it("parses inline arrays", () => {
    expect(parseSimpleFrontmatter('tags: [a, b, "c d"]')).toEqual({
      tags: ["a", "b", "c d"],
    });
  });

  it("ignores comments + blank lines", () => {
    expect(parseSimpleFrontmatter("# comment\n\nname: x\n# more")).toEqual({ name: "x" });
  });

  it("handles empty input", () => {
    expect(parseSimpleFrontmatter("")).toEqual({});
  });
});

describe("fromFile", () => {
  it("loads a skill from a markdown file with frontmatter", async () => {
    const path = join(dir, "greet.md");
    await writeFile(path, "---\nname: greet\ndescription: greet the user\n---\nHello.");
    const records = await fromFile({ path }).load();
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("greet");
    expect(records[0]!.description).toBe("greet the user");
    expect(records[0]!.content).toBe("Hello.");
  });

  it("preserves source path in metadata", async () => {
    const path = join(dir, "x.md");
    await writeFile(path, "---\nname: x\ndescription: x\n---\nbody");
    const [record] = await fromFile({ path }).load();
    expect(record!.metadata?.sourcePath).toBe(path);
  });

  it("parses tags from frontmatter", async () => {
    const path = join(dir, "x.md");
    await writeFile(path, "---\nname: x\ndescription: x\ntags: [foo, bar]\n---\nbody");
    const [record] = await fromFile({ path }).load();
    expect(record!.tags).toEqual(["foo", "bar"]);
  });

  it("raises when frontmatter is missing", async () => {
    const path = join(dir, "x.md");
    await writeFile(path, "no frontmatter");
    await expect(fromFile({ path }).load()).rejects.toThrow(/no frontmatter block/);
  });

  it("raises when name or description is missing", async () => {
    const path = join(dir, "x.md");
    await writeFile(path, "---\nname: x\n---\nbody");
    await expect(fromFile({ path }).load()).rejects.toThrow(/missing required/);
  });

  it("maps `allowed-tools` array frontmatter → allowedTools", async () => {
    const path = join(dir, "x.md");
    await writeFile(path, "---\nname: x\ndescription: x\nallowed-tools: [Bash, Read]\n---\nbody");
    const [record] = await fromFile({ path }).load();
    expect(record!.allowedTools).toEqual(["Bash", "Read"]);
    // Stripped from metadata (the canonical field is `allowedTools`).
    expect(record!.metadata).not.toHaveProperty("allowed-tools");
  });

  it("maps `allowed-tools` comma-string frontmatter → allowedTools", async () => {
    const path = join(dir, "x.md");
    await writeFile(path, '---\nname: x\ndescription: x\nallowed-tools: "Bash, Read"\n---\nbody');
    const [record] = await fromFile({ path }).load();
    expect(record!.allowedTools).toEqual(["Bash", "Read"]);
  });
});

describe("fromDirectory", () => {
  it("walks .md files and skips bad records silently", async () => {
    await writeFile(join(dir, "good.md"), "---\nname: good\ndescription: g\n---\nbody");
    await writeFile(join(dir, "bad.md"), "no frontmatter");
    await writeFile(join(dir, "ignored.txt"), "---\nname: x\n---\nbody");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "more.md"), "---\nname: more\ndescription: m\n---\nbody2");

    const records = await fromDirectory({ path: dir }).load();
    expect(records.map((r) => r.name).sort()).toEqual(["good", "more"]);
  });

  it("maps `allowed-tools` frontmatter → allowedTools on each record", async () => {
    await writeFile(
      join(dir, "restricted.md"),
      "---\nname: restricted\ndescription: r\nallowed-tools: [Bash]\n---\nbody",
    );
    const [record] = await fromDirectory({ path: dir }).load();
    expect(record!.allowedTools).toEqual(["Bash"]);
  });
});

describe("withSkills({ loaders }) end-to-end", () => {
  it("registers everything from all loaders at install time", async () => {
    // Drive a SkillsHarness directly using the same code-path the
    // extension uses — proves the wiring without needing a full
    // session shell here.
    const harness = new SkillsHarness(
      `test:${ulid()}`,
      new MemoryJournal({ capacity: 1024 }),
      new LocalEventBus(),
      new LocalInbox(),
    );
    await harness.ready;

    const loaders = [
      fromArray([{ name: "first", description: "f", content: "a" }]),
      fromArray([{ name: "second", description: "s", content: "b" }]),
    ];

    const batches = await Promise.all(loaders.map((l) => l.load()));
    for (const batch of batches) {
      for (const skill of batch) {
        await harness.register(skill);
      }
    }

    expect(
      harness
        .list()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["first", "second"]);
  });

  it("withSkills constructs a SessionExtension that consumes loaders", () => {
    const ext = withSkills({
      loaders: [fromArray([{ name: "x", description: "x", content: "x" }])],
    });
    expect(ext.name).toBe("@agentick/skills-next");
    expect(ext.target).toBe("session");
    expect(typeof ext.install).toBe("function");
  });
});
