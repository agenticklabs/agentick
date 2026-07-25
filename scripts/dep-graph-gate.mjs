#!/usr/bin/env node
/**
 * dep-graph gate — the static "does the published dist import graph only reach
 * DECLARED dependencies?" probe.
 *
 * WHY: a consumer install of `@agentick/session` from the registry failed at
 * require time because `@agentick/elicitation/dist/conformance.js` imports
 * `vitest` (a devDependency) and conformance was re-exported from elicitation's
 * MAIN barrel. In the workspace this is masked — vitest resolves from the hoisted
 * root `node_modules`, so the no-TLA gate (which loads dist in-repo) passes. A
 * real consumer has no vitest, no devDeps, and no private workspace packages, so
 * ANY external specifier reachable from a public entrypoint that is NOT a
 * declared runtime dependency is an uninstallable-graph defect.
 *
 * WHAT: for every PUBLISHABLE (non-private) package, walk the dist import graph
 * from each `publishConfig.exports` entrypoint (the artifact a consumer imports),
 * following only relative (in-package) specifiers, and collect every EXTERNAL
 * specifier it statically imports/exports-from. Each external specifier's package
 * name must be a key of that package's `dependencies` / `peerDependencies` /
 * `optionalDependencies`. `node:` builtins and bare Node builtins are exempt.
 *
 * The `./testing` entrypoint ships test infrastructure (Meszaros doubles +
 * conformance suites), so a consumer that imports it already has a test runner:
 * `vitest` is allowlisted THERE (VITEST_ALLOWLIST) — but every other undeclared
 * external on a `./testing` graph is still a violation. Test infra must live on
 * `./testing`, never on the main barrel (that is the house rule this gate
 * enforces).
 *
 * SPECIFIERS: dist is tsc-emitted ESM — every import/export specifier is a string
 * literal, so a regex over the `.js` is faithful (no bundler indirection). We do
 * NOT walk into external packages (their deps are their problem); we only follow
 * the package's own relative graph.
 *
 * EXIT: 0 iff every publishable entrypoint's graph reaches only declared deps;
 * non-zero (naming package + entrypoint + file + specifier) otherwise. Unbuilt
 * dist is a LOUD failure, never a silent skip.
 *
 * INVOCATION: `node scripts/dep-graph-gate.mjs` (run after `pnpm build`). Wired
 * into `pnpm verify:publish` after the no-TLA gate.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG_DIR = join(ROOT, "packages");

// Test infra reachable from `./testing` is expected to need a runner; the
// consumer that imports `./testing` has one. Everything else must be declared.
const VITEST_ALLOWLIST = new Set(["vitest"]);

const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Strip block (`/* *​/`, JSDoc) and line comments — tsc preserves them in dist,
 *  and their `@example` snippets contain literal `import`/`from` strings that
 *  would otherwise be mistaken for real edges. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1"); // keep `:` before `//` so URLs survive
}

/** Extract every STATIC import/export-from specifier from tsc ESM: `… from "x"`,
 *  side-effect `import "x"`, and `export … from "x"`. Dynamic `import("x")` is
 *  deliberately NOT matched — it is the pattern for guarded, optional lazy-loads
 *  (e.g. compiler-react's `react-devtools-core`), which a consumer never hits on
 *  a cold require and which belong in `optionalDependencies`, not the hard graph. */
const SPEC_RE =
  /(?:\bfrom\s*|\bimport\s+)["']([^"'\n]+)["']|\bexport\s+(?:\*|\{[^}]*\})\s+from\s*["']([^"'\n]+)["']/g;

function specifiersOf(src) {
  const out = new Set();
  for (const m of stripComments(src).matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2];
    if (spec) out.add(spec);
  }
  return out;
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`. */
function packageNameOf(spec) {
  if (spec.startsWith("@")) {
    const [scope, name] = spec.split("/");
    return name ? `${scope}/${name}` : scope;
  }
  return spec.split("/")[0];
}

const isRelative = (s) => s.startsWith("./") || s.startsWith("../");
const isBuiltin = (s) => BUILTINS.has(s) || BUILTINS.has(packageNameOf(s));

/** Resolve a relative dist specifier to an on-disk file (tsc emits explicit .js). */
function resolveRelative(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.js`, join(base, "index.js")]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

/**
 * BFS the in-package dist graph from `entryAbs`; return the set of external
 * specifiers reached and any relative specifiers that could not be resolved.
 */
function walk(entryAbs) {
  const externals = new Set();
  const unresolved = new Set();
  const seen = new Set();
  const queue = [entryAbs];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      unresolved.add(file);
      continue;
    }
    for (const spec of specifiersOf(src)) {
      if (isBuiltin(spec)) continue;
      if (isRelative(spec)) {
        const next = resolveRelative(file, spec);
        if (next) queue.push(next);
        else unresolved.add(`${spec} (from ${file})`);
      } else {
        externals.add(spec);
      }
    }
  }
  return { externals, unresolved };
}

/** Resolve every publishable package + its publishConfig entrypoints. */
function publishablePackages() {
  const out = [];
  for (const name of readdirSync(PKG_DIR)) {
    const pjPath = join(PKG_DIR, name, "package.json");
    if (!existsSync(pjPath)) continue;
    const pj = JSON.parse(readFileSync(pjPath, "utf8"));
    if (pj.private) continue;
    const exp = pj.publishConfig?.exports ?? {};
    const entries = Object.entries(exp)
      .map(([sub, v]) => [sub, typeof v === "string" ? v : (v.import ?? v.default)])
      .filter(([, file]) => typeof file === "string");
    const declared = new Set([
      ...Object.keys(pj.dependencies ?? {}),
      ...Object.keys(pj.peerDependencies ?? {}),
      ...Object.keys(pj.optionalDependencies ?? {}),
    ]);
    out.push({ pkg: pj.name, dir: join(PKG_DIR, name), entries, declared });
  }
  return out.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

// ── Run ──────────────────────────────────────────────────────────────────────
const packages = publishablePackages();
console.log(`dep-graph gate — ${packages.length} publishable packages\n`);

const violations = [];
const unbuilt = [];
for (const { pkg, dir, entries, declared } of packages) {
  for (const [sub, file] of entries) {
    const abs = join(dir, file);
    const label = sub === "." ? pkg : `${pkg} (${sub})`;
    const isTesting = sub === "./testing" || sub.endsWith("/testing");
    if (!existsSync(abs)) {
      unbuilt.push(label);
      console.log(`▲ UNBUILT   ${label}`);
      continue;
    }
    const { externals, unresolved } = walk(abs);
    const bad = [];
    for (const spec of externals) {
      const name = packageNameOf(spec);
      if (name === pkg) continue; // self-reference resolves via the package's own exports map
      if (declared.has(name)) continue;
      if (isTesting && VITEST_ALLOWLIST.has(name)) continue;
      bad.push({ spec, name });
    }
    if (bad.length === 0 && unresolved.size === 0) {
      console.log(`✔ PASS     ${label}`);
    } else {
      console.log(`✘ FAIL     ${label}`);
      for (const { spec, name } of bad) {
        console.log(`             undeclared: "${spec}" (package "${name}")`);
        violations.push({ label, spec, name });
      }
      for (const u of unresolved) {
        console.log(`             unresolved relative import: ${u}`);
        violations.push({ label, spec: u, name: "(unresolved)" });
      }
    }
  }
}

console.log("");
if (unbuilt.length > 0) {
  console.error(`✘ ${unbuilt.length} publishable entrypoint(s) have NO dist — run \`pnpm build\`:`);
  for (const u of unbuilt) console.error(`    ${u}`);
}
if (violations.length > 0) {
  console.error(
    `✘ ${violations.length} undeclared-dependency edge(s) reachable from published entrypoints:`,
  );
  for (const v of violations) console.error(`    ${v.label}  →  ${v.spec}`);
  console.error(
    `\nFix: move test infra to the \`./testing\` subpath barrel, or declare the ` +
      `dependency. Test infra must never be reachable from the main barrel.`,
  );
}
if (unbuilt.length === 0 && violations.length === 0) {
  console.log("✔ every published entrypoint graph reaches only declared dependencies.");
  process.exit(0);
}
process.exit(1);
