#!/usr/bin/env node
/**
 * ctx-derivers gate — the ADR 91 structural enforcement of "one deriver".
 *
 * WHY: ADR 91 (§2 / §Enforcement) makes `deriveContext` the ONE constructor of
 * a boundary context — the sole place the raw `deriveObservability` /
 * `deriveOps` facet derivers are called. Before the ADR, ~six sites
 * hand-assembled ctx facets by calling those derivers directly; that is the
 * Frankenstein smell the ADR retires. A boundary ctx must route through
 * `deriveContext` (or `BaseHarness.defineOperationFacets`, which shares the same
 * `attachOperationFacets` core) so every ctx carries the trunk + brand.
 *
 * WHAT: grep every `packages/<pkg>/src/**` source file for a direct call to
 * `deriveObservability(` / `deriveOps(`. The ONLY files allowed to contain one:
 *   - the deriver DEFINITIONS (`observability.ts`, `ops.ts`);
 *   - the single sanctioned caller (`derive-context.ts`);
 *   - test files (`*.spec.*` / `__tests__/`), which unit-test the derivers.
 * Any other hit fails the build (naming file + line).
 *
 * EXIT: 0 iff no unsanctioned direct call exists; non-zero (naming offenders)
 * otherwise — so CI can gate on it.
 *
 * INVOCATION: `pnpm check:ctx-derivers` (root) or `node scripts/ctx-derivers-gate.mjs`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "packages");

// The direct facet derivers a boundary ctx must NOT call outside deriveContext.
const CALL_RE = /\b(deriveObservability|deriveOps)\s*\(/;

// Files exempt from the gate: the deriver definitions + the sole sanctioned
// caller. Matched by path suffix (POSIX-normalized).
const ALLOWED_SUFFIXES = [
  "packages/runtime/src/substrate/observability.ts",
  "packages/runtime/src/substrate/ops.ts",
  "packages/runtime/src/substrate/derive-context.ts",
];

/** Test files legitimately exercise the derivers directly. */
function isTestFile(posixPath) {
  return /\.spec\.[cm]?tsx?$/.test(posixPath) || posixPath.includes("/__tests__/");
}

function isAllowed(posixPath) {
  return ALLOWED_SUFFIXES.some((suffix) => posixPath.endsWith(suffix)) || isTestFile(posixPath);
}

/** Recursively collect `.ts` / `.tsx` files under a directory. */
function collectSources(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      collectSources(abs, out);
    } else if (/\.[cm]?tsx?$/.test(name)) {
      out.push(abs);
    }
  }
}

const sources = [];
for (const name of readdirSync(PKG_DIR)) {
  const srcDir = join(PKG_DIR, name, "src");
  try {
    if (statSync(srcDir).isDirectory()) collectSources(srcDir, sources);
  } catch {
    /* package without a src/ — skip */
  }
}

const offenders = [];
for (const abs of sources) {
  const posix = relative(ROOT, abs).split("\\").join("/");
  if (isAllowed(posix)) continue;
  const text = readFileSync(abs, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (CALL_RE.test(lines[i])) offenders.push(`${posix}:${i + 1}: ${lines[i].trim()}`);
  }
}

console.log(`ctx-derivers gate — scanned ${sources.length} source files.\n`);
if (offenders.length === 0) {
  console.log(
    "✔ no direct deriveObservability / deriveOps call outside deriveContext — the ADR 91 spine holds.",
  );
  process.exit(0);
}
console.error(
  `✘ ${offenders.length} direct facet-deriver call(s) outside deriveContext (ADR 91 §2):`,
);
for (const o of offenders) console.error(`    ${o}`);
console.error(
  "\n  A boundary ctx must route through `deriveContext` (or `BaseHarness.defineOperationFacets`).",
);
process.exit(1);
