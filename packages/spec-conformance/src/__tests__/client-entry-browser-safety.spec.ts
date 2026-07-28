/**
 * ANTI-ROT: no Node builtin is reachable from a browser entry point.
 *
 * An Angular consumer's webpack build hard-failed with
 * `UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins`.
 * The cause was one bad edge four hops deep: `@agentick/transport-websocket/client`
 * → `src/client/transport.ts` → the ROOT barrel `@agentick/transport` → its
 * `export * from "./server/index.js"` → `server/web-security.ts` →
 * `import { randomBytes } from "node:crypto"`. Every file in that chain is
 * browser-innocent on its own; only the graph is guilty. So the check walks the
 * graph.
 *
 * Bundlers do not tree-shake a `node:` scheme away — the resolver fails before
 * shaking happens. One wrong barrel import in any client-facing package breaks
 * every web consumer, and it breaks at THEIR build, not ours. Hence a test.
 *
 * Deliberately manifest-driven: the entry set comes from each package's `exports`
 * map, so a new package with a `/client` subpath is covered the moment it exists.
 * We read the DEV exports (they point at `./src/...`) so the graph is source, not
 * `dist`.
 *
 * Type-only edges are not traversed. `import type { IncomingMessage } from
 * "node:http"` erases at compile time and cannot reach a bundle; several packages
 * type against Node shapes on purpose. Mixed forms (`import { type A, b }`) are
 * runtime imports and are followed.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/** The workspace's `packages/` directory, from this file's location. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..");

interface Pkg {
  readonly dir: string;
  readonly exports: Record<string, unknown>;
}

/** Every workspace package by name, with its DEV `exports` map. */
const PKGS: ReadonlyMap<string, Pkg> = new Map(
  readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(PACKAGES, e.name, "package.json")))
    .map((e) => {
      const dir = join(PACKAGES, e.name);
      const json = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name?: string;
        exports?: Record<string, unknown>;
      };
      return [json.name ?? e.name, { dir, exports: json.exports ?? {} }] as const;
    }),
);

/** Collapse an exports entry to one target, preferring what a bundler would pick. */
function pick(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry;
  if (typeof entry !== "object" || entry === null) return undefined;
  const conds = entry as Record<string, unknown>;
  for (const key of ["browser", "import", "default", "types"]) {
    const hit = pick(conds[key]);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * Does this subpath DENY the browser condition (`"browser": null`)?
 *
 * Not every `/client` is a browser client. `@agentick/transport-unix-socket`'s
 * is the connecting end of a same-host IPC pair — a CLI talking to a daemon —
 * and a Unix domain socket has no browser existence at all, so `node:net` there
 * is correct. The package says so in its manifest, which both keeps this sweep
 * free of a hand-maintained exception list AND makes a web bundler that lands
 * there fail with "not exported under browser condition" rather than an
 * unresolvable scheme.
 */
function deniesBrowser(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "browser" in entry &&
    (entry as Record<string, unknown>).browser === null
  );
}

/** The entries a web bundler can land on: `./client`, `@agentick/client*`, `browser`. */
function browserEntries(): readonly { readonly label: string; readonly file: string }[] {
  const out: { label: string; file: string }[] = [];
  for (const [name, pkg] of PKGS) {
    const dot = pkg.exports["."];
    const add = (label: string, target: string | undefined): void => {
      const file = target === undefined ? undefined : join(pkg.dir, target);
      if (file !== undefined && existsSync(file)) out.push({ label, file });
    };
    if (!deniesBrowser(pkg.exports["./client"])) {
      add(`${name}/client`, pick(pkg.exports["./client"]));
    }
    if (name.startsWith("@agentick/client")) add(name, pick(dot));
    if (typeof dot === "object" && dot !== null) {
      add(`${name} (browser condition)`, pick((dot as Record<string, unknown>).browser));
    }
  }
  return out;
}

/** Runtime (non-type-only) specifiers imported by a source file. */
function runtimeSpecifiers(src: string): readonly string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1");
  const out: string[] = [];
  // `[^;=]` keeps a multi-line clause from swallowing the next statement, which
  // would otherwise mis-read the `type` marker of the import that follows.
  for (const m of code.matchAll(/^\s*(?:import|export)\s+([^;=]*?)\bfrom\s*["']([^"']+)["']/gm)) {
    if (!/^\s*type\b/.test(m[1]!)) out.push(m[2]!);
  }
  // Bare side-effect imports and dynamic `import("...")` — both reach the bundler.
  for (const m of code.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g)) out.push(m[1]!);
  return out;
}

/** Specifier → workspace source file. Non-`@agentick` bare specifiers are out of scope. */
function resolveSpec(spec: string, from: string): string | undefined {
  if (spec.startsWith(".")) {
    // Source uses ESM `.js` specifiers that map to `.ts`/`.tsx` on disk.
    const base = resolve(dirname(from), spec).replace(/\.jsx?$/, "");
    const candidates = [
      `${base}.ts`,
      `${base}.tsx`,
      join(base, "index.ts"),
      join(base, "index.tsx"),
    ];
    return candidates.find((c) => existsSync(c) && statSync(c).isFile());
  }
  const parts = /^(@agentick\/[^/]+)(\/.+)?$/.exec(spec);
  const pkg = parts === null ? undefined : PKGS.get(parts[1]!);
  if (parts === null || pkg === undefined) return undefined;
  const target = pick(pkg.exports[parts[2] === undefined ? "." : `.${parts[2]}`]);
  const file = target === undefined ? undefined : join(pkg.dir, target);
  return file !== undefined && existsSync(file) ? file : undefined;
}

/** DFS from one entry, returning a rendered chain per Node builtin reached. */
function chainsToNodeBuiltins(
  entry: { label: string; file: string },
  seen: Set<string>,
): readonly string[] {
  const found: string[] = [];
  const visited = new Set<string>();
  const stack: { file: string; chain: readonly string[] }[] = [
    { file: entry.file, chain: [entry.label] },
  ];
  while (stack.length > 0) {
    const { file, chain } = stack.pop()!;
    if (visited.has(file)) continue; // the graph has cycles
    visited.add(file);
    seen.add(file);
    const here = [...chain, relative(PACKAGES, file)];
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith("node:")) {
        found.push([...here, spec].join(" → "));
        continue;
      }
      const next = resolveSpec(spec, file);
      if (next !== undefined && !next.includes("__tests__"))
        stack.push({ file: next, chain: here });
    }
  }
  return found;
}

describe("browser entry points reach no Node builtin", () => {
  const entries = browserEntries();
  const seen = new Set<string>();
  const violations = entries.flatMap((entry) => chainsToNodeBuiltins(entry, seen));

  it("no `node:*` specifier is reachable through the module graph", () => {
    // Full chains, not a count: CI output has to name the edge to cut.
    expect(violations).toEqual([]);
  });

  it("the sweep is non-vacuous — it walked real entries and real files", () => {
    // A resolver a refactor silently broke would report zero violations because it
    // inspected nothing. Pin both ends: entries discovered, files actually read.
    expect(entries.length).toBeGreaterThan(10); // 21 at the time of writing
    expect(seen.size).toBeGreaterThan(100); // 264 at the time of writing
  });

  it("a `/client` that denies the browser condition is excluded, by declaration", () => {
    // The one exclusion is a manifest fact, so assert the manifest still says it.
    // If the deny key is renamed the sweep over-collects and fails loudly above;
    // this pins the other direction — that the mechanism is exercised at all.
    expect(entries.map((e) => e.label)).not.toContain("@agentick/transport-unix-socket/client");
    expect(deniesBrowser(PKGS.get("@agentick/transport-unix-socket")?.exports["./client"])).toBe(
      true,
    );
  });

  it("reads type-only edges as erased and mixed edges as runtime", () => {
    // The one piece of real parsing here, and the piece most likely to be wrong.
    const src = [
      'import type { A } from "node:http";',
      'export type { B } from "node:tls";',
      'import {\n  type C,\n  d,\n} from "node:zlib";',
      "const x = 1;",
      'import { e } from "node:net";',
      'import "node:crypto";',
    ].join("\n");
    expect(runtimeSpecifiers(src)).toEqual(["node:zlib", "node:net", "node:crypto"]);
  });
});
