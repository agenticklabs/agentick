/**
 * `extractFrontmatter` — slice the leading `---` block off a text record.
 *
 * Returns the raw frontmatter text + the remaining body. **Does not
 * parse YAML / TOML / JSON** — the caller picks the deserialization
 * strategy (and pulls in a parser if needed). Keeping the primitive
 * dependency-free means harness packages can choose whichever
 * frontmatter dialect fits their record type.
 *
 * Recognized delimiters:
 *  - YAML/TOML/JSON-style: `---` … `---` (default)
 *  - HTML-comment-wrapped: configurable via `delimiter` for adopters
 *    using `<!-- --- ... --- -->`
 *
 * The opening delimiter must be the first non-whitespace content. If
 * no frontmatter block is present (or the closing delimiter is
 * missing), the result is `{ frontmatter: null, body: <input> }` —
 * the input passes through unchanged.
 */

export interface ExtractFrontmatterResult {
  readonly frontmatter: string | null;
  readonly body: string;
}

export interface ExtractFrontmatterOptions {
  /** Delimiter line. Default `---`. The same delimiter opens and closes. */
  readonly delimiter?: string;
}

export function extractFrontmatter(
  input: string,
  options: ExtractFrontmatterOptions = {},
): ExtractFrontmatterResult {
  const delim = options.delimiter ?? "---";
  // Find the opening delimiter as the first non-empty line.
  const lines = input.split(/\r?\n/);
  let cursor = 0;
  while (cursor < lines.length && lines[cursor]!.trim() === "") cursor++;
  if (cursor >= lines.length || lines[cursor]!.trim() !== delim) {
    return { frontmatter: null, body: input };
  }
  const openIdx = cursor;
  // Scan for the closing delimiter.
  for (let i = openIdx + 1; i < lines.length; i++) {
    if (lines[i]!.trim() === delim) {
      const frontmatter = lines.slice(openIdx + 1, i).join("\n");
      const body = lines.slice(i + 1).join("\n");
      // Strip a single leading newline-only line from the body if
      // present — adopters expect `body` to start at the first content
      // line after `---`.
      return { frontmatter, body: body.replace(/^\n/, "") };
    }
  }
  // Unterminated frontmatter — pass through unchanged.
  return { frontmatter: null, body: input };
}
