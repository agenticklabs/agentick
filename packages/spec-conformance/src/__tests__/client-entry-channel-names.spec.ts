/**
 * ANTI-ROT: a channel NAME a `/client` consumer needs is reachable from the
 * `/client` barrel.
 *
 * `TASK_PROGRESS_CHANNEL` was exported only from `@agentick/tasks` — the ROOT
 * barrel, which pulls the whole server harness. A browser bundle that wanted the
 * one string constant had to import it, which is exactly the union
 * `client-entry-browser-safety.spec.ts` exists to prevent; the only reason it
 * did not already fail is that the tasks harness happens to reach no `node:*`
 * builtin. Barrels are single-environment: a wire constant a client needs must
 * be nameable from the client entry.
 *
 * The rule: for every package with a `/client` subpath, every
 * `export const *_CHANNEL` / `*_CHANNEL_FQN` declared in that package's src
 * root must be re-exported from `src/client/index.ts`.
 *
 * Scoped to channel NAMES on purpose. The sibling frame/payload TYPES are
 * type-only (invisible at runtime, and covered by `tsc` through the barrel),
 * and the server-side helpers that live next to them — `toWireDescriptor`,
 * `knobPointer` — must NOT cross into a client barrel.
 *
 * Filesystem-driven: a new harness package with a `/client` subpath is covered
 * the moment it exists, with no list to maintain. Barrels are imported by
 * absolute path (not by package name) so this package needs no dependency on
 * the packages it sweeps.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** The workspace's `packages/` directory, from this file's location. */
const PACKAGES = join(import.meta.dirname, "..", "..", "..");

/** `export const FOO_CHANNEL` / `FOO_CHANNEL_FQN` declared in a source file. */
function channelNamesIn(file: string): readonly string[] {
  const src = readFileSync(file, "utf8");
  return [...src.matchAll(/^export const ([A-Z0-9_]*_CHANNEL(?:_FQN)?)\b/gm)].map((m) => m[1]!);
}

interface Entry {
  readonly pkg: string;
  readonly barrel: string;
  readonly required: readonly string[];
}

/** Every `/client` barrel, with the channel names its package declares. */
function entries(): readonly Entry[] {
  const out: Entry[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES, pkg.name, "src");
    const barrel = join(src, "client", "index.ts");
    if (!existsSync(barrel)) continue;
    const required = readdirSync(src, { withFileTypes: true })
      .filter((e) => !e.isDirectory() && e.name.endsWith(".ts"))
      .flatMap((e) => channelNamesIn(join(src, e.name)));
    if (required.length > 0) out.push({ pkg: pkg.name, barrel, required });
  }
  return out;
}

describe("client entry points expose their channel names", () => {
  const found = entries();

  it("the sweep found the packages that declare channels alongside a /client barrel", () => {
    // A resolver a refactor silently broke would report zero gaps because it
    // inspected nothing. Pin the ends the sweep depends on.
    expect(found.map((e) => e.pkg).sort()).toEqual([
      "elicitation",
      "knobs",
      "live",
      "tasks",
      "tool-executor",
    ]);
  });

  it.each(found.map((e) => [e.pkg, e] as const))(
    "@agentick/%s/client re-exports every channel name its package declares",
    async (_pkg, entry) => {
      const barrel = (await import(entry.barrel)) as Record<string, unknown>;
      const missing = entry.required.filter((name) => !(name in barrel));
      // Name the constants to add, not a count.
      expect(missing).toEqual([]);
    },
  );
});
