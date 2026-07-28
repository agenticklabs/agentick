/**
 * ANTI-ROT: a subpath barrel whose code READS a bridge slot must import the
 * augment that DECLARES it.
 *
 * A `declare module` augmentation applies program-wide once its file is in the
 * program — but only then. A consumer that deep-imports `@agentick/x/react`
 * without also importing `@agentick/x` never pulls `src/augment.ts`, so the slot
 * the subpath reads has no declared type. The convention is therefore that each
 * subpath barrel side-effect-imports its own augment.
 *
 * This rotted once in practice: `@agentick/resources/react` read
 * `useBridges().resources` while five sibling `/react` barrels imported their
 * augment and it did not. A convention nothing checks is a convention that rots
 * again, so the check lives here rather than in a review comment.
 *
 * Deliberately filesystem-driven: a new harness package with a `/react` or
 * `/client` subpath is covered the moment it exists, with no list to maintain.
 *
 * The rule is "import whatever DECLARES the slot you read" — not "import your
 * own augment". `@agentick/gates/react` reads the KNOBS slot and satisfies the
 * rule with a bare `import "@agentick/knobs"`, which is the general form for
 * cross-package augmentation. So a barrel passes on either.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The workspace's `packages/` directory, from this file's location. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..");

/** Subpaths that receive bridges — the ones where a missing augment bites. */
const SUBPATHS = ["react", "client"] as const;

/** Does any non-barrel file under `dir` read a bridge slot? */
function readsBridges(dir: string): boolean {
  return readdirSync(dir, { withFileTypes: true }).some((entry) => {
    if (entry.isDirectory()) return false; // __tests__ and nested dirs are not the barrel's surface
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) return false;
    if (entry.name === "index.ts") return false;
    return readFileSync(join(dir, entry.name), "utf8").includes("useBridges()");
  });
}

/** Bare side-effect imports anywhere in the subpath, not just its barrel. */
function readSubpathImports(dir: string): string {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.isDirectory() && (e.name.endsWith(".ts") || e.name.endsWith(".tsx")))
    .map((e) => readFileSync(join(dir, e.name), "utf8"))
    .join("\n");
}

interface Offender {
  readonly pkg: string;
  readonly subpath: string;
}

function findOffenders(): readonly Offender[] {
  const out: Offender[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES, pkg.name, "src");
    // Only packages that HAVE an augment can be missing its import.
    if (!existsSync(join(src, "augment.ts"))) continue;
    for (const subpath of SUBPATHS) {
      const dir = join(src, subpath);
      const barrel = join(dir, "index.ts");
      if (!existsSync(barrel) || !readsBridges(dir)) continue;
      // Either its own augment, or a bare barrel import of the package whose
      // slot it reads — both put the declaring file in the program.
      const text = readFileSync(barrel, "utf8") + readSubpathImports(dir);
      const declares = text.includes("augment.js") || /import "@agentick\/[a-z-]+";/.test(text);
      if (!declares) out.push({ pkg: pkg.name, subpath });
    }
  }
  return out;
}

describe("subpath barrels import the augment they read", () => {
  it("no subpath reads a bridge slot without importing its augment", () => {
    // Named offenders rather than a bare count, so a failure says which line to add.
    expect(findOffenders().map((o) => `${o.pkg}/${o.subpath}`)).toEqual([]);
  });

  it("the check is non-vacuous — it finds the barrels it is meant to police", () => {
    // If a refactor moved augments or renamed subpaths, the sweep above would
    // pass by inspecting nothing. Assert it is actually looking at real files.
    let policed = 0;
    for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue;
      const src = join(PACKAGES, pkg.name, "src");
      if (!existsSync(join(src, "augment.ts"))) continue;
      for (const subpath of SUBPATHS) {
        const dir = join(src, subpath);
        if (existsSync(join(dir, "index.ts")) && readsBridges(dir)) policed += 1;
      }
    }
    expect(policed).toBeGreaterThan(3);
  });
});
