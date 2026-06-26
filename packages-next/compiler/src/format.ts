/**
 * `format(tree, opts?)` — flatten a `RenderedTree` to a string using
 * the existing `@agentick/formatters-next` pipeline. Default formatter
 * is markdown; adopters override via `opts.formatter`.
 *
 * Framework-agnostic: the input is the canonical IR, the output is a
 * string. This is the LAST step in the static-template render
 * pipeline (`compileToTree(...)` produces the IR; `format(...)` turns
 * it into output). Per-framework `render()` entry points compose the
 * two.
 *
 * Framing rules (the bits that turn a list of formatted entries into
 * one string) live here so all adapters share them:
 *   - Sections render their content (no header by default — section
 *     identity lives in `id`/`title`/`metadata`, not in inline text).
 *   - Messages render their content with the role surfaced as a
 *     leading marker in markdown mode (`> user:` / `> assistant:`)
 *     for human-readability; the formatter harness's downstream
 *     consumer can override via a custom formatter.
 *   - Root-level `tree.content` renders after all entries.
 *
 * Entries are separated by blank lines so markdown stays readable.
 */

import type { ContentBlock, RenderedTree, SemanticContentBlock } from "@agentick/spec-next";
import { type DefinedFormatter, markdownFormatter } from "@agentick/formatters-next";

export interface FormatOptions {
  /**
   * Override the default formatter. Pass `markdownFormatter`,
   * `xmlFormatter`, `textFormatter`, or any `DefinedFormatter` built
   * via `createFormatter`.
   *
   * Default: `markdownFormatter` from `@agentick/formatters-next`.
   */
  readonly formatter?: DefinedFormatter;
}

/**
 * Format the entire RenderedTree to a string. Walks every context
 * entry + root content; runs the formatter on each entry's content
 * blocks; joins with blank-line separators.
 */
export function format(tree: RenderedTree, opts: FormatOptions = {}): string {
  const formatter = opts.formatter ?? markdownFormatter;
  const parts: string[] = [];

  for (const entry of tree.context.entries) {
    const body = blocksToString(formatter(entry.content as readonly SemanticContentBlock[]));
    if (body.length === 0) continue;
    if (entry.kind === "message") {
      parts.push(`${entry.role}:\n${body}`);
    } else {
      parts.push(body);
    }
  }

  if (tree.content && tree.content.length > 0) {
    parts.push(blocksToString(formatter(tree.content as readonly SemanticContentBlock[])));
  }

  return parts
    .map((p) => p.replace(/\n+$/, ""))
    .filter((p) => p.length > 0)
    .join("\n\n");
}

// ────────── Internals ──────────

function blocksToString(blocks: readonly ContentBlock[]): string {
  // After the formatter pass, semantic content is reduced to text
  // blocks (markdown/xml/text formatters all output TextBlock for
  // anything with a serializable representation). Non-text blocks
  // here are media / non-serializable; emit a placeholder so the
  // adopter sees they exist but aren't being rendered as text.
  const out: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") out.push(b.text);
    else out.push(`[block: ${b.type}]`);
  }
  return out.join("");
}
