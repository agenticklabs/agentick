/**
 * ANTI-ROT: a subpath whose whole job is a SIDE EFFECT must be listed in its
 * package's `sideEffects`.
 *
 * `@agentick/prompts` declared
 * `sideEffects: ["./src/index.ts", "./src/augment.ts", "./dist/index.js", "./dist/augment.js"]`
 * — an allowlist that omitted `./dist/client/*`. A `/client` barrel exists to run
 * `registerSessionHandleExtension(...)` at import time, so a bundler told the file
 * is side-effect-free DELETES the import outright. The registration never runs and
 * the app dies at first use with
 *
 *   SessionSubHandleNotRegistered: session.prompts is not registered.
 *
 * pointing the adopter at an import they already wrote. Seven packages shipped
 * that way.
 *
 * It is invisible everywhere we test: Node does not tree-shake, and neither does
 * vitest. It appears only in a real bundler, in someone else's app. Hence a test
 * that reads the manifests rather than the behaviour.
 *
 * The rule: if a package declares an allowlist at all, every subpath that
 * registers or augments must be covered by it. A package with NO `sideEffects`
 * key is untouched — that means "assume side effects everywhere", which is safe.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The workspace's `packages/` directory, from this file's location. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..");

/** Subpaths that exist to run an import-time side effect. */
const REGISTERING = ["client", "react"] as const;

/** Does `patterns` cover a file under `<subpath>/`? Handles the `dir/*` glob form. */
function covers(patterns: readonly string[], subpath: string): boolean {
  return patterns.some((pattern) => {
    const normalized = pattern.replace(/^\.\//, "");
    return (
      normalized.startsWith(`src/${subpath}/`) ||
      normalized.startsWith(`dist/${subpath}/`) ||
      normalized === "*" ||
      normalized === "**"
    );
  });
}

interface Gap {
  readonly pkg: string;
  readonly subpath: string;
}

function findGaps(): readonly Gap[] {
  const out: Gap[] = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join(PACKAGES, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    const json = JSON.parse(readFileSync(manifest, "utf8")) as {
      sideEffects?: unknown;
    };
    // No allowlist → every file is assumed effectful. Nothing to check.
    if (!Array.isArray(json.sideEffects)) continue;
    const patterns = json.sideEffects.filter((p): p is string => typeof p === "string");
    for (const subpath of REGISTERING) {
      const barrel = join(PACKAGES, entry.name, "src", subpath, "index.ts");
      if (!existsSync(barrel)) continue;
      if (!covers(patterns, subpath)) out.push({ pkg: entry.name, subpath });
    }
  }
  return out;
}

describe("registering subpaths survive tree-shaking", () => {
  it("every `/client` and `/react` subpath is covered by its package's sideEffects", () => {
    // Named, not counted: a failure has to say which manifest to edit.
    expect(findGaps().map((g) => `${g.pkg}/${g.subpath}`)).toEqual([]);
  });

  it("the sweep is non-vacuous — it inspected real allowlists and real barrels", () => {
    // A refactor that moved the barrels or dropped every `sideEffects` key would
    // make the check above pass by looking at nothing.
    let inspected = 0;
    for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = join(PACKAGES, entry.name, "package.json");
      if (!existsSync(manifest)) continue;
      const json = JSON.parse(readFileSync(manifest, "utf8")) as { sideEffects?: unknown };
      if (!Array.isArray(json.sideEffects)) continue;
      for (const subpath of REGISTERING) {
        if (existsSync(join(PACKAGES, entry.name, "src", subpath, "index.ts"))) inspected += 1;
      }
    }
    expect(inspected).toBeGreaterThan(8);
  });
});
