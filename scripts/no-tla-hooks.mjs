/**
 * ESM resolve hook for the no-TLA gate.
 *
 * In the dev monorepo every `@agentick/*` package.json `exports` points at
 * `./src/index.ts` — the `publishConfig.exports` → `./dist/*.js` rewrite only
 * happens at PUBLISH time (pnpm/changeset swaps it into the tarball). So a plain
 * `require()` of a built dist entry resolves its `@agentick/*` DEPENDENCIES back
 * to their `src/*.ts`, which bare Node cannot load — a false failure that hides
 * the real question (does the dist graph load under require(ESM)?).
 *
 * This hook reproduces the PUBLISHED resolution in-tree: any `@agentick/*`
 * specifier (bare or subpath) is resolved through the target package's own
 * `exports` map, then `src`→`dist` / `.ts(x)`→`.js` — exactly what publishConfig
 * does — so the whole graph loads from `dist`, and a top-level await ANYWHERE in
 * it surfaces as the genuine `ERR_REQUIRE_ASYNC_MODULE` we gate on.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

/** name → { dir, exports } for every workspace package under packages-next/ and packages/. */
const workspace = new Map();
for (const base of ["packages-next", "packages"]) {
  const baseDir = join(ROOT, base);
  if (!existsSync(baseDir)) continue;
  for (const name of readdirSync(baseDir)) {
    const pjPath = join(baseDir, name, "package.json");
    if (!existsSync(pjPath)) continue;
    try {
      const pj = JSON.parse(readFileSync(pjPath, "utf8"));
      if (typeof pj.name === "string") {
        workspace.set(pj.name, { dir: join(baseDir, name), exports: pj.exports ?? {} });
      }
    } catch {
      /* skip unparseable */
    }
  }
}

/** `@agentick/foo-next` → ["@agentick/foo-next", "."]; `.../bar` → [pkg, "./bar"]. */
function splitSpecifier(spec) {
  const parts = spec.split("/");
  if (spec.startsWith("@")) {
    const pkg = parts.slice(0, 2).join("/");
    const sub = parts.length > 2 ? `./${parts.slice(2).join("/")}` : ".";
    return [pkg, sub];
  }
  const pkg = parts[0];
  const sub = parts.length > 1 ? `./${parts.slice(1).join("/")}` : ".";
  return [pkg, sub];
}

/** The dev `exports` entry (a `./src/*.ts` path) for a subpath, mapped to dist. */
function distTarget(entry, sub) {
  const e = entry.exports[sub];
  const devFile = typeof e === "string" ? e : (e?.import ?? e?.default);
  if (typeof devFile !== "string") return undefined;
  const distFile = devFile.replace("/src/", "/dist/").replace(/\.tsx?$/, ".js");
  const abs = join(entry.dir, distFile);
  return existsSync(abs) ? abs : undefined;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@agentick/")) {
    const [pkg, sub] = splitSpecifier(specifier);
    const entry = workspace.get(pkg);
    if (entry) {
      const abs = distTarget(entry, sub);
      if (abs) return { url: pathToFileURL(abs).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
