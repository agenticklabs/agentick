/**
 * Frontmatter parser for skill files.
 *
 * Splits markdown source into `{ data, body }` where `data` is the parsed
 * YAML frontmatter (between `---` delimiters) and `body` is everything
 * after. Frontmatter is parsed with the `yaml` package — full YAML 1.2
 * support: block arrays, multiline strings, nesting, etc.
 *
 * Frontmatter splitting (the `---` delimiter dance) lives here; YAML
 * parsing is delegated to keep us spec-compliant and matched with the
 * broader ecosystem (Jekyll/Hugo/Obsidian/Anthropic Skills/agents.md).
 *
 * @module @agentick/core/skill/frontmatter
 */

import { parse as parseYaml } from "yaml";

export interface ParsedFrontmatter {
  /** The parsed frontmatter object (may be empty) */
  data: Record<string, unknown>;
  /** The body content (everything after the closing `---`) */
  body: string;
}

const FRONTMATTER_DELIM = /^---\s*$/;

/**
 * Split a markdown source into frontmatter object + body. Returns
 * `{ data: {}, body: source }` when no frontmatter is present.
 *
 * Throws on malformed YAML inside the frontmatter block (delegated to the
 * `yaml` package). A missing closing delimiter is treated as "no
 * frontmatter" (returns the source unchanged) — that matches Jekyll and
 * gray-matter behavior.
 */
export function parseFrontmatter(source: string): ParsedFrontmatter {
  const lines = source.split(/\r?\n/);

  // Frontmatter must start with `---` on the first non-empty line
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (i >= lines.length || !FRONTMATTER_DELIM.test(lines[i]!)) {
    return { data: {}, body: source };
  }

  i++; // consume opening `---`
  const fmStart = i;

  // Find closing `---`
  while (i < lines.length && !FRONTMATTER_DELIM.test(lines[i]!)) i++;

  if (i >= lines.length) {
    // No closing delimiter — treat as no frontmatter
    return { data: {}, body: source };
  }

  const fmText = lines.slice(fmStart, i).join("\n");
  const bodyStart = i + 1;
  // Strip a single leading blank line on the body for cleanliness
  let body = lines.slice(bodyStart).join("\n");
  body = body.replace(/^\n+/, "");

  // Empty frontmatter block → empty object, not null/undefined from yaml.parse
  const parsed = fmText.trim() === "" ? {} : parseYaml(fmText);
  const data =
    parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  return { data, body };
}
