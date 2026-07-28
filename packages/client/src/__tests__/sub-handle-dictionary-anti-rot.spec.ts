/**
 * ANTI-ROT for client-core's sub-handle diagnostics dictionary.
 *
 * `@agentick/client-core` names the `/client` subpath behind every known slot as
 * plain STRING LITERALS (it must never import a harness package). Strings rot.
 * This bundle is the one place where every built-in `/client` subpath is actually
 * imported, so it is the one place the dictionary can be checked against reality:
 *
 *   - every slot the bundle REGISTERS must be in the dictionary (a new built-in
 *     sub-handle that forgot to add its entry fails here), and
 *   - every dictionary slot whose package the bundle DEPENDS ON must be
 *     registered (a renamed/removed slot, or a wrong specifier, fails here).
 *
 * The second direction reads this package's own `dependencies` so optional
 * harnesses the bundle deliberately does not ship (`@agentick/live/client`) are
 * skipped without a second hand-maintained list — add `@agentick/live` to the
 * bundle and its entry becomes required automatically.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { knownSessionHandleExtensionImports, registeredSessionHandleExtensions } from "../index.js";

/** `@agentick/x/client` → `@agentick/x`. */
function packageOf(specifier: string): string {
  return specifier.slice(0, specifier.lastIndexOf("/"));
}

function bundleDependencies(): readonly string[] {
  const pkg = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  return Object.keys(
    (JSON.parse(pkg) as { dependencies?: Record<string, string> }).dependencies ?? {},
  );
}

describe("sub-handle diagnostics dictionary cannot rot", () => {
  it("every slot the bundle registers has a dictionary entry", () => {
    const dictionary = knownSessionHandleExtensionImports();
    const unknown = registeredSessionHandleExtensions().filter((name) => !(name in dictionary));
    expect(unknown).toEqual([]);
  });

  it("every dictionary slot from a bundled package is registered", () => {
    const deps = bundleDependencies();
    const registered = registeredSessionHandleExtensions();
    const missing = Object.entries(knownSessionHandleExtensionImports())
      .filter(([, specifier]) => deps.includes(packageOf(specifier)))
      .filter(([name]) => !registered.includes(name))
      .map(([name, specifier]) => `${name} (${specifier})`);
    expect(missing).toEqual([]);
  });

  it("the bundle's own dictionary entries point at packages it depends on", () => {
    const deps = bundleDependencies();
    const bundled = Object.values(knownSessionHandleExtensionImports())
      .map(packageOf)
      .filter((pkg) => deps.includes(pkg));
    // Sanity: the filter above is not vacuous — the bundle really does cover
    // most of the dictionary.
    expect(new Set(bundled).size).toBeGreaterThanOrEqual(10);
  });
});
