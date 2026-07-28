#!/usr/bin/env node
/**
 * typesVersions sync — the node10 fallback for our subpath exports.
 *
 * WHY: a consumer monorepo on `"moduleResolution": "node"` (node10) cannot see a
 * single one of our subpaths. node10 predates `exports` and ignores it outright,
 * so `@agentick/mcp/server` resolves as a literal folder lookup, finds nothing,
 * and TypeScript reports "Cannot find module" — plus a shower of spurious "has no
 * exported member" errors off the unresolved specifier. Runtime is unaffected
 * (Node honors `exports`); this is purely a TYPES gap. `typesVersions` is the
 * standard fallback node10 DOES read, so every published subpath needs one.
 *
 * WHAT: for each package manifest, read `publishConfig.exports` — the
 * PUBLISHED map, whose targets are `./dist/...` — and emit
 * `publishConfig.typesVersions["*"]`, keyed by subpath minus `./`, valued as the
 * one-element array node10 expects. Only `publishConfig` is touched: the dev
 * `exports` point at `./src/*.ts` and are consumed through workspace links, which
 * resolve without any of this.
 *
 * The write is idempotent — re-running after adding a package is a no-op diff —
 * and `packages/spec-conformance/src/__tests__/types-versions-node10.spec.ts`
 * fails if a new subpath ever ships without its entry.
 *
 * INVOCATION: `node scripts/sync-types-versions.mjs` (after adding a subpath).
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGES = new URL("../packages/", import.meta.url).pathname;

/** The `.d.ts` an exports entry declares, through whatever conditions wrap it. */
function typesTarget(entry) {
  if (typeof entry === "string") return entry.endsWith(".d.ts") ? entry : undefined;
  if (entry === null || typeof entry !== "object") return undefined;
  if (typeof entry.types === "string") return entry.types;
  for (const condition of ["import", "default", "node", "browser"]) {
    const hit = typesTarget(entry[condition]);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

let changed = 0;
const missing = [];
for (const pkg of readdirSync(PACKAGES).sort()) {
  const manifest = join(PACKAGES, pkg, "package.json");
  const text = (() => {
    try {
      return readFileSync(manifest, "utf8");
    } catch {
      return undefined;
    }
  })();
  if (text === undefined) continue;
  const json = JSON.parse(text);
  const exports = json.publishConfig?.exports;
  if (exports === undefined) continue;

  const map = {};
  for (const [subpath, entry] of Object.entries(exports)) {
    if (subpath === ".") continue; // node10 finds the root through `types`
    const target = typesTarget(entry);
    if (target === undefined) missing.push(`${pkg} ${subpath}`);
    else map[subpath.replace(/^\.\//, "")] = [target];
  }

  // Compare CONTENT, not text. Writing whenever the serialization differs fights
  // `oxfmt`: this emits `JSON.stringify(…, 2)`, oxfmt reformats, and the next run
  // sees a diff again — a loop that rewrites all 38 manifests on every
  // invocation. Deep-equal on the block itself makes the unchanged case a true
  // no-op; the rare real change is reformatted by the pre-commit gate.
  const desired = Object.keys(map).length > 0 ? { "*": map } : undefined;
  if (JSON.stringify(json.publishConfig.typesVersions) === JSON.stringify(desired)) continue;

  // Rebuilt rather than assigned so the key lands next to `exports`, and so a
  // package that loses its last subpath loses the block instead of keeping a stub.
  const rest = { ...json.publishConfig };
  delete rest.typesVersions;
  const publishConfig = {};
  for (const [key, value] of Object.entries(rest)) {
    publishConfig[key] = value;
    if (key === "exports" && desired !== undefined) publishConfig.typesVersions = desired;
  }

  writeFileSync(manifest, `${JSON.stringify({ ...json, publishConfig }, null, 2)}\n`);
  changed += 1;
  console.log(`updated ${pkg}`);
}

console.log(`${changed} manifest(s) updated`);
if (missing.length > 0) {
  console.error(`no types target for: ${missing.join(", ")}`);
  process.exit(1);
}
