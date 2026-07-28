/**
 * ANTI-ROT: every published subpath carries a node10 `typesVersions` fallback.
 *
 * `"moduleResolution": "node"` (node10) predates the `exports` map and ignores it
 * outright. A large Nest/Angular consumer on that setting could not import ONE of
 * our subpaths: `@agentick/mcp/server` resolved as a bare folder lookup, found
 * nothing, and TypeScript reported "Cannot find module" — followed by 27 spurious
 * "has no exported member" errors off the unresolved specifier, for members that
 * are demonstrably present in the shipped `dist/server/index.d.ts`. 37 errors from
 * one missing manifest key. Runtime was never broken: Node honors `exports`
 * regardless. This is purely a TYPES resolution gap, and `typesVersions` is the
 * fallback node10 does read.
 *
 * A consumer cannot flip node10 → bundler on a mature monorepo without a
 * migration, so the fallback is ours to ship. `scripts/sync-types-versions.mjs`
 * derives it from `publishConfig.exports`; this test is what makes the next
 * subpath added without re-running it fail here instead of in someone's build.
 *
 * Deliberately manifest-driven: the subpath set comes from each package's own
 * `publishConfig.exports`, so a new package or a new subpath is covered the moment
 * it exists, with no list to maintain.
 *
 * We assert against `publishConfig` only. The dev `exports` point at `./src/*.ts`
 * and are consumed through workspace links, which resolve without any of this.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The workspace's `packages/` directory, from this file's location. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..");

interface Manifest {
  readonly typesVersions?: Record<string, Record<string, readonly string[]>>;
  readonly publishConfig?: {
    readonly exports?: Record<string, unknown>;
    readonly typesVersions?: Record<string, Record<string, readonly string[]>>;
  };
}

/** Every workspace package's manifest, by directory name. */
const MANIFESTS: ReadonlyMap<string, Manifest> = new Map(
  readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(PACKAGES, e.name, "package.json")))
    .map(
      (e) =>
        [
          e.name,
          JSON.parse(readFileSync(join(PACKAGES, e.name, "package.json"), "utf8")) as Manifest,
        ] as const,
    ),
);

/** Published subpaths (never `"."` — node10 finds the root through `types`). */
function subpaths(manifest: Manifest): readonly string[] {
  return Object.keys(manifest.publishConfig?.exports ?? {}).filter((k) => k !== ".");
}

describe("published subpaths resolve under node10 moduleResolution", () => {
  const offenders: string[] = [];
  let checked = 0;
  for (const [pkg, manifest] of MANIFESTS) {
    const map = manifest.publishConfig?.typesVersions?.["*"] ?? {};
    for (const subpath of subpaths(manifest)) {
      checked += 1;
      // node10 keys are the subpath WITHOUT the `./` prefix — with it, the
      // pattern never matches and the entry is silently inert.
      const target = map[subpath.replace(/^\.\//, "")]?.[0];
      if (target === undefined || !/^\.\/dist\/.*\.d\.ts$/.test(target)) {
        offenders.push(`${pkg}${subpath.slice(1)} → ${target ?? "MISSING"}`);
      }
    }
  }

  it("every `publishConfig.exports` subpath has a `typesVersions` declaration file", () => {
    // Named offenders rather than a count, so a failure says which key to add.
    expect(offenders).toEqual([]);
  });

  it("no `typesVersions` key exists without a matching export subpath", () => {
    // The other direction: a renamed or deleted subpath must not leave a key
    // pointing at a `.d.ts` the tarball no longer contains.
    const stale: string[] = [];
    for (const [pkg, manifest] of MANIFESTS) {
      const declared = new Set(subpaths(manifest).map((s) => s.replace(/^\.\//, "")));
      for (const key of Object.keys(manifest.publishConfig?.typesVersions?.["*"] ?? {})) {
        if (!declared.has(key)) stale.push(`${pkg}: ${key}`);
      }
    }
    expect(stale).toEqual([]);
  });

  it("the fallback stays out of the DEV manifest", () => {
    // A top-level `typesVersions` would redirect workspace-link resolution at
    // `dist`, so every in-repo consumer would need a build to typecheck.
    expect([...MANIFESTS].filter(([, m]) => m.typesVersions !== undefined).map(([p]) => p)).toEqual(
      [],
    );
  });

  it("the sweep is non-vacuous — it inspected real subpaths across real packages", () => {
    // A sweep whose manifest reader a refactor broke reports zero offenders
    // because it looked at nothing. Pin both ends.
    expect(MANIFESTS.size).toBeGreaterThan(40); // 59 at the time of writing
    expect(checked).toBeGreaterThan(60); // 78 at the time of writing
  });
});
