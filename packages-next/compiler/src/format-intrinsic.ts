/**
 * The `<format>` intrinsic — formatter-scope provider.
 *
 * `<format formatter={ref} purpose?={...}>...</format>` pushes a new
 * `WalkScope` onto descendants and contributes no entry/block of its
 * own. Walker adapters recognize the tag via `isFormatTag(tag)` and
 * derive the scope via `parseFormatProps(...)`.
 *
 * Props:
 *   - `formatter` (required) — the {@link FormatterRef} to bind.
 *     Malformed / missing → returns `null` and the walker should
 *     emit a diagnostic.
 *   - `purpose` (optional) — when set to one of the SUPPORTED
 *     purposes (`"section"`, `"message"`) scope only that purpose.
 *     Other valid `FormatPurpose` values are silently downgraded to
 *     default-scope replacement — see `SUPPORTED_PURPOSES` below.
 *
 * Lives in compiler-next so every framework adapter sees the same
 * tag name + parsing rules. The walker integration (where to push
 * the scope, when to stamp `renderedWith` on entries) lives in the
 * adapter's walker.
 *
 * @see docs/proposals/v2/blueprint/39-jsx-template-walker.md
 */

import type { FormatPurpose, FormatterRef } from "@agentick/spec-next";

/**
 * Canonical lowercase tag name for the formatter-scope intrinsic.
 */
export const FORMAT_INTRINSIC_TAG = "format" as const;

export function isFormatTag(tag: string): boolean {
  return tag === FORMAT_INTRINSIC_TAG;
}

/**
 * The `purpose` values the walker actually CONSUMES today.
 *
 * The full `FormatPurpose` union from spec-next is broader
 * (`"context" | "message" | "section" | "free-root" | "resource" |
 * "output"`) but only section + message dispatch ask the scope for
 * a purpose-specific formatter (`resolveFormatter(scope,
 * "section" | "message")`). The rest are NOT honest yet:
 *
 *  - `"free-root"` — top-level `tree.content` is formatted by the
 *    single formatter passed to `format(tree, opts)`. No per-scope
 *    free-root stamping. Tracked as Phase 4+ alongside top-level
 *    `tree.renderedWith` plumbing in `finalize()`.
 *  - `"context"`, `"resource"`, `"output"` — these are
 *    consumer-facing format purposes (executor / resource runtime /
 *    output declaration). The compiler walker doesn't emit
 *    `kind: "resource"` / `kind: "output"` ContextEntries yet
 *    (deferred to Phase 2 of the modular intrinsic vocabulary).
 *    Once those entries land, the dispatch handlers can ask the
 *    scope for their purpose-specific formatter and we'll widen
 *    this set.
 *
 * Restricting parse here is the cheap-honest move: an adopter who
 * writes `<format formatter={xml} purpose="resource">` today gets
 * the formatter as the DEFAULT (not purpose-scoped), which is the
 * closest correct behavior. Once Phase 4 lights up the rest, we
 * widen the set + add tests pinning the new dispatch sites.
 */
const SUPPORTED_PURPOSES: ReadonlySet<FormatPurpose> = new Set<FormatPurpose>([
  "section",
  "message",
]);

export interface ParsedFormatProps {
  readonly formatter: FormatterRef;
  readonly purpose?: FormatPurpose;
}

/**
 * Validate and unwrap `<format>` props. Returns the parsed binding,
 * or `null` if the `formatter` prop is missing / malformed (no
 * `{id: string}` shape).
 *
 * `purpose` is honored only for the values the walker currently
 * dispatches on (`"section"`, `"message"`). All other `purpose`
 * values (including the spec-valid `"context"` / `"free-root"` /
 * `"resource"` / `"output"`) are silently dropped — the binding
 * lands as the scope's default. See `SUPPORTED_PURPOSES` above for
 * the rationale.
 */
export function parseFormatProps(
  props: Readonly<Record<string, unknown>>,
): ParsedFormatProps | null {
  const f = props.formatter;
  if (
    !f ||
    typeof f !== "object" ||
    typeof (f as { id?: unknown }).id !== "string" ||
    (f as { id: string }).id.length === 0
  ) {
    return null;
  }
  const formatter = f as FormatterRef;
  const p = props.purpose;
  if (typeof p === "string" && SUPPORTED_PURPOSES.has(p as FormatPurpose)) {
    return { formatter, purpose: p as FormatPurpose };
  }
  return { formatter };
}
