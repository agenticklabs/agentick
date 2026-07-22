/**
 * Realpath-descendant path confinement.
 *
 * @verifiedBy this file — `isPathWithin`, `realpathAllowingMissing`,
 * `realpathWithin`, including the symlink-escape hole that a plain
 * string-prefix check leaves open.
 */

import { mkdtemp, mkdir, rm, symlink, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isPathWithin, realpathAllowingMissing, realpathWithin } from "../node.js";

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

/** A tmp root, realpath'd (macOS `/var → /private/var`) as callers must. */
async function tmpRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agentick-path-"));
  dirs.push(dir);
  return realpath(dir);
}

describe("isPathWithin (pure lexical containment)", () => {
  it("accepts the root itself and nested descendants", () => {
    expect(isPathWithin("/data", "/data")).toBe(true);
    expect(isPathWithin("/data/a/b", "/data")).toBe(true);
  });

  it("rejects a sibling-prefix false match", () => {
    expect(isPathWithin("/data-other", "/data")).toBe(false);
    expect(isPathWithin("/dat", "/data")).toBe(false);
  });
});

describe("realpathAllowingMissing", () => {
  it("realpaths an existing path", async () => {
    const root = await tmpRoot();
    await writeFile(join(root, "f.txt"), "x");
    expect(await realpathAllowingMissing(join(root, "f.txt"))).toBe(join(root, "f.txt"));
  });

  it("bounds a missing leaf by its deepest existing ancestor's realpath", async () => {
    const root = await tmpRoot();
    // Nothing under root/a exists; the real prefix is `root`.
    const resolved = await realpathAllowingMissing(join(root, "a", "b", "c.txt"));
    expect(resolved).toBe(join(root, "a", "b", "c.txt"));
  });

  it("follows a symlink in the real prefix even when the leaf is absent", async () => {
    const root = await tmpRoot();
    const outside = await tmpRoot();
    await symlink(outside, join(root, "link"));
    // `link` exists (→ outside); `secret.txt` under it does not.
    const resolved = await realpathAllowingMissing(join(root, "link", "secret.txt"));
    expect(resolved).toBe(join(outside, "secret.txt"));
  });
});

describe("realpathWithin (the security seam)", () => {
  it("allows a real file under root", async () => {
    const root = await tmpRoot();
    await writeFile(join(root, "note.md"), "hi");
    expect(await realpathWithin(join(root, "note.md"), root)).toBe(join(root, "note.md"));
  });

  it("allows a legitimate symlink that stays INSIDE root", async () => {
    const root = await tmpRoot();
    await mkdir(join(root, "real"));
    await writeFile(join(root, "real", "data.txt"), "ok");
    await symlink(join(root, "real"), join(root, "alias"));
    // Requested via the in-root symlink; realpath lands back under root.
    expect(await realpathWithin(join(root, "alias", "data.txt"), root)).toBe(
      join(root, "real", "data.txt"),
    );
  });

  it("REJECTS a symlink inside root that points outside (the escape hole)", async () => {
    const root = await tmpRoot();
    const outside = await tmpRoot();
    await writeFile(join(outside, "passwd"), "secret");
    await symlink(outside, join(root, "escape"));
    // Lexically `<root>/escape/passwd` startsWith(root) — but realpath is
    // `<outside>/passwd`, so containment must fail.
    expect(await realpathWithin(join(root, "escape", "passwd"), root)).toBeNull();
  });

  it("rejects a `..` traversal out of root", async () => {
    const root = await tmpRoot();
    expect(await realpathWithin(join(root, "..", "elsewhere"), root)).toBeNull();
  });

  it("returns a within-root path for a missing file (caller surfaces ENOENT)", async () => {
    const root = await tmpRoot();
    expect(await realpathWithin(join(root, "does-not-exist.txt"), root)).toBe(
      join(root, "does-not-exist.txt"),
    );
  });
});
