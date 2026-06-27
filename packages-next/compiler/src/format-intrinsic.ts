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
 *   - `purpose` (optional) — when set to one of the
 *     {@link FormatPurpose} values (`"section"`, `"message"`, …)
 *     scope only that purpose. Unknown values are silently dropped
 *     (no purpose binding, default-scope replacement applies).
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
 * The full set of valid `FormatPurpose` values, mirrored from the
 * spec. Used to validate the `purpose` prop at parse time.
 */
const VALID_PURPOSES: ReadonlySet<FormatPurpose> = new Set<FormatPurpose>([
  "context",
  "message",
  "section",
  "free-root",
  "resource",
  "output",
]);

export interface ParsedFormatProps {
  readonly formatter: FormatterRef;
  readonly purpose?: FormatPurpose;
}

/**
 * Validate and unwrap `<format>` props. Returns the parsed binding,
 * or `null` if the `formatter` prop is missing / malformed (no
 * `{id: string}` shape). Unknown `purpose` values are ignored — the
 * binding falls back to scope-default replacement.
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
  if (typeof p === "string" && VALID_PURPOSES.has(p as FormatPurpose)) {
    return { formatter, purpose: p as FormatPurpose };
  }
  return { formatter };
}
