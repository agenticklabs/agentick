/**
 * RFC 6570-lite URI-template matcher.
 *
 * `ResourcesHarness.read(uri)` prefers a fixed binding, then falls back
 * to the first registered template whose pattern matches the concrete
 * uri. The matcher only produces a boolean — the resolver receives the
 * raw uri and parses its own parameters, so we never build a variable
 * bag here.
 *
 * Supported expansion classes (the subset MCP servers use in practice):
 *   - `{name}`   — matches exactly one path segment (no `/`).
 *   - `{+name}`  — reserved expansion: matches across segments (incl `/`).
 *   - `{/name}`  — path expansion: matches across segments (incl `/`).
 *
 * Everything else in the template is treated as a literal and
 * regex-escaped. Anchored end-to-end.
 */

const EXPRESSION = /\{[+/#.;?&]?[^}]+\}/g;

/** Escape a literal chunk for embedding in a `RegExp`. */
function escapeLiteral(segment: string): string {
  return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a URI template into an anchored `RegExp`. Cached by the
 * harness per registration so this cost is paid once per template.
 */
export function compileUriTemplate(uriTemplate: string): RegExp {
  let pattern = "";
  let lastIndex = 0;
  for (const match of uriTemplate.matchAll(EXPRESSION)) {
    const expr = match[0];
    const start = match.index;
    // Literal run preceding this expression.
    pattern += escapeLiteral(uriTemplate.slice(lastIndex, start));
    // Operator-aware capture width. Reserved (`+`) and path (`/`)
    // operators cross segment boundaries; the default operator does not.
    const operator = expr[1];
    pattern += operator === "+" || operator === "/" ? "(.+)" : "([^/]+)";
    lastIndex = start + expr.length;
  }
  pattern += escapeLiteral(uriTemplate.slice(lastIndex));
  return new RegExp(`^${pattern}$`);
}

/** True iff `uri` matches the compiled template pattern. */
export function matchesTemplate(compiled: RegExp, uri: string): boolean {
  return compiled.test(uri);
}
