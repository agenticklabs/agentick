/**
 * Node `fs`-backed loaders.
 *
 * Pins:
 *  - `sourceFromFile` reads a file and yields one record
 *  - `readFrontmatterFile` splits frontmatter + body
 *  - `sourceFromDirectory` walks recursively, sorts deterministically,
 *    skips hidden + symlinks by default, honors RegExp + predicate match
 */

import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readFrontmatterFile, sourceFromDirectory, sourceFromFile } from "../node/index.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "loaders-spec-"));
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true });
});

describe("sourceFromFile", () => {
  it("reads a file and yields a one-element batch", async () => {
    const path = join(dir, "skill.md");
    await writeFile(path, "hello");
    const records = await sourceFromFile({ path }).load();
    expect(records).toEqual([{ path, content: "hello" }]);
  });
});

describe("readFrontmatterFile", () => {
  it("splits frontmatter and body", async () => {
    const path = join(dir, "skill.md");
    await writeFile(path, "---\nname: x\n---\nbody content");
    const record = await readFrontmatterFile(path);
    expect(record.path).toBe(path);
    expect(record.frontmatter).toBe("name: x");
    expect(record.body).toBe("body content");
  });

  it("returns null frontmatter when none present", async () => {
    const path = join(dir, "plain.md");
    await writeFile(path, "no frontmatter here");
    const record = await readFrontmatterFile(path);
    expect(record.frontmatter).toBeNull();
    expect(record.body).toBe("no frontmatter here");
  });
});

describe("sourceFromDirectory", () => {
  it("walks recursively and yields all files", async () => {
    await writeFile(join(dir, "a.md"), "A");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "b.md"), "B");
    await mkdir(join(dir, "sub", "deep"));
    await writeFile(join(dir, "sub", "deep", "c.md"), "C");

    const records = await sourceFromDirectory({ path: dir }).load();
    expect(records.map((r) => r.content)).toEqual(["A", "B", "C"]);
  });

  it("returns results sorted by path (deterministic)", async () => {
    await writeFile(join(dir, "z.md"), "Z");
    await writeFile(join(dir, "a.md"), "A");
    await writeFile(join(dir, "m.md"), "M");

    const records = await sourceFromDirectory({ path: dir }).load();
    expect(records.map((r) => r.content)).toEqual(["A", "M", "Z"]);
  });

  it("skips hidden entries by default", async () => {
    await writeFile(join(dir, "visible.md"), "V");
    await writeFile(join(dir, ".hidden.md"), "H");
    await mkdir(join(dir, ".secret"));
    await writeFile(join(dir, ".secret", "x.md"), "X");

    const records = await sourceFromDirectory({ path: dir }).load();
    expect(records.map((r) => r.content)).toEqual(["V"]);
  });

  it("includes hidden when opted in", async () => {
    await writeFile(join(dir, "visible.md"), "V");
    await writeFile(join(dir, ".hidden.md"), "H");

    const records = await sourceFromDirectory({ path: dir, includeHidden: true }).load();
    expect(records.map((r) => r.content).sort()).toEqual(["H", "V"]);
  });

  it("honors recursive: false", async () => {
    await writeFile(join(dir, "top.md"), "T");
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "sub", "b.md"), "B");

    const records = await sourceFromDirectory({ path: dir, recursive: false }).load();
    expect(records.map((r) => r.content)).toEqual(["T"]);
  });

  it("filters by RegExp on the file name", async () => {
    await writeFile(join(dir, "skill.md"), "M");
    await writeFile(join(dir, "skill.txt"), "T");
    await writeFile(join(dir, "skill.json"), "J");

    const records = await sourceFromDirectory({ path: dir, match: /\.md$/ }).load();
    expect(records.map((r) => r.content)).toEqual(["M"]);
  });

  it("filters by predicate", async () => {
    await writeFile(join(dir, "a.md"), "A");
    await writeFile(join(dir, "b.md"), "B");

    const records = await sourceFromDirectory({
      path: dir,
      match: ({ name }) => name === "a.md",
    }).load();
    expect(records.map((r) => r.content)).toEqual(["A"]);
  });

  it("does NOT follow symlinks", async () => {
    await writeFile(join(dir, "real.md"), "R");
    const target = join(dir, "real.md");
    const link = join(dir, "link.md");
    try {
      await symlink(target, link);
    } catch {
      // Skip on platforms where symlinks aren't supported / permitted.
      return;
    }
    const records = await sourceFromDirectory({ path: dir }).load();
    expect(records.map((r) => r.content)).toEqual(["R"]);
  });

  it("throws with a helpful message when readdir fails", async () => {
    const missing = join(dir, "does-not-exist");
    await expect(sourceFromDirectory({ path: missing }).load()).rejects.toThrow(/readdir failed/);
  });
});
