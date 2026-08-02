/**
 * `resolveFormatterRef` — the ONE `FormatterRef → DefinedFormatter` lookup.
 *
 * A ref is identity-only data (it crosses the wire); turning it into a callable
 * formatter is a registry lookup with a deliberate two-step match:
 *
 *   1. by `id` — an exact registry key.
 *   2. by `format` — the first registered formatter whose `__identity.format`
 *      equals the ref's hint. This is INTENTIONAL and load-bearing: the JSX
 *      scope components ship refs like `{ id: "xml", format: "xml" }` while the
 *      registry is keyed `formatter.xml`, so the hint is the normal path, and
 *      the adopter gets the FORMAT they asked for.
 *   3. otherwise the caller's fallback.
 *
 * Step 3 is the only arm where the adopter silently gets something OTHER than
 * what they asked for, so the resolution reports HOW it matched
 * ({@link FormatterResolution.match}) instead of collapsing to a bare formatter.
 * Callers that own a diagnostics channel (the compiler harness) surface
 * `"fallback"` as a warning; callers that don't (`formatTree`, a pure
 * serializer) degrade quietly.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D2
 */

import type { FormatterRef, FormatterResolver } from "@agentick/spec";

import type { DefinedFormatter } from "./create-formatter.js";

/** Which arm of the lookup produced the formatter. */
export type FormatterMatch = "id" | "format" | "fallback";

export interface FormatterResolution {
  readonly formatter: DefinedFormatter;
  readonly match: FormatterMatch;
}

/**
 * Resolve `ref` against `formatters`, reporting which arm matched. An absent
 * `ref` is `"fallback"`-matched without complaint — nothing was requested.
 */
export function resolveFormatterRef(
  formatters: ReadonlyMap<string, DefinedFormatter>,
  ref: FormatterRef | undefined,
  fallback: DefinedFormatter,
): FormatterResolution {
  if (ref === undefined) return { formatter: fallback, match: "fallback" };
  return matchFormatter(formatters, ref) ?? { formatter: fallback, match: "fallback" };
}

/** Steps 1 and 2 alone — `undefined` when the registry serves neither arm. */
function matchFormatter(
  formatters: ReadonlyMap<string, DefinedFormatter>,
  ref: FormatterRef,
): FormatterResolution | undefined {
  const byId = formatters.get(ref.id);
  if (byId) return { formatter: byId, match: "id" };
  if (ref.format !== undefined) {
    for (const fmt of formatters.values()) {
      if (fmt.__identity.format === ref.format) return { formatter: fmt, match: "format" };
    }
  }
  return undefined;
}

/**
 * The {@link FormatterResolver} a formatter pass hands to its formatters, so a
 * section that DECLARED a dialect is lowered in that dialect rather than the
 * container's.
 *
 * Steps 1 and 2 of the same lookup, and deliberately not step 3: a declared
 * ref this registry does not serve is NOT grounds for an island. The
 * container's dialect is the honest answer for an unserved ref, and the pass
 * has already reported it through its own diagnostics channel — inventing a
 * dialect boundary on top of a miss would compound one defect with another.
 */
export function declaredFormatterResolver(
  formatters: ReadonlyMap<string, DefinedFormatter>,
): FormatterResolver {
  return (ref) => matchFormatter(formatters, ref)?.formatter;
}

/**
 * The human-readable half of an unresolved ref — shared so the wording of the
 * diagnostic is identical wherever it is raised.
 */
export function describeUnresolvedFormatter(ref: FormatterRef, used: DefinedFormatter): string {
  const hint = ref.format !== undefined ? ` (format hint "${ref.format}")` : "";
  return (
    `No formatter registered for id "${ref.id}"${hint}; ` +
    `rendered with "${used.__identity.id}" instead. ` +
    `Register the formatter, or pass a \`format\` that a registered formatter serves.`
  );
}
