/**
 * `formatTree(tree, defaultFormatter, opts?): string` — IR → final string.
 *
 * The single tree-level serialization entry point for
 * `@agentick/formatters`. Delegates ALL serialization work to
 * the resolved formatter:
 *   - block-level formatting via `formatter(blocks)` (existing
 *     contract — `SemanticContentBlock[] → ContentBlock[]`)
 *   - block-to-text flattening via `formatter.blocksToText`
 *   - message framing via `formatter.frameMessage`
 *
 * The built-in markdown / xml / text formatters supply all three
 * tree-level methods. 3rd-party formatters that omit them fall back
 * to markdown-flavored defaults from `defaultFormatter` (when that
 * formatter supplies them) or, as last-resort, to baked-in markdown
 * defaults in this module.
 *
 * Per-entry formatter resolution:
 *   - When `opts.formatters` is provided, each entry's `renderedWith`
 *     (set by the JSX `<format>` scope intrinsic, or by adapter-level
 *     defaults) is resolved against the map by id, then by `format`
 *     hint. Falls back to `defaultFormatter` when no match.
 *   - When `opts.formatters` is omitted, `defaultFormatter` applies
 *     uniformly. `entry.renderedWith` is ignored.
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md §D2
 */

import type {
  FormatterRef,
  MessageEntry,
  RenderedTree,
  SemanticContentBlock,
} from "@agentick/spec";

import type { DefinedFormatter } from "./create-formatter.js";
import { resolveFormatterRef } from "./resolve-formatter.js";

export interface FormatTreeOptions {
  /**
   * Per-entry formatter resolution map. When provided, each entry's
   * `renderedWith.id` is looked up against this map (with a `format`
   * fallback); `defaultFormatter` applies when no match. Omit to
   * always use `defaultFormatter`.
   */
  readonly formatters?: ReadonlyMap<string, DefinedFormatter>;
}

export function formatTree(
  tree: RenderedTree,
  defaultFormatter: DefinedFormatter,
  opts: FormatTreeOptions = {},
): string {
  const parts: string[] = [];

  for (const entry of tree.context.entries) {
    const formatter = resolveFormatter(entry.renderedWith, defaultFormatter, opts);
    const formattedBlocks = formatter(entry.content as readonly SemanticContentBlock[]);
    const bodyText = (formatter.blocksToText ?? defaultBlocksToText)(formattedBlocks);
    parts.push((formatter.frameMessage ?? defaultFrameMessage)(entry, bodyText));
  }

  if (tree.content && tree.content.length > 0) {
    const formatter = resolveFormatter(tree.renderedWith, defaultFormatter, opts);
    const formattedBlocks = formatter(tree.content as readonly SemanticContentBlock[]);
    parts.push((formatter.blocksToText ?? defaultBlocksToText)(formattedBlocks));
  }

  return parts.filter((p) => p.length > 0).join("\n\n");
}

// ────────── Formatter resolution ──────────
//
// Per-entry resolution defers to the shared `resolveFormatterRef`. `formatTree`
// returns a string and owns no diagnostics channel, so an unresolvable ref
// degrades to `defaultFormatter` quietly here; the compiler harness's formatter
// pass runs the same lookup over the same map and REPORTS the `"fallback"`
// match, so the adopter still hears about it exactly once.

function resolveFormatter(
  entryRef: FormatterRef | undefined,
  fallback: DefinedFormatter,
  opts: FormatTreeOptions,
): DefinedFormatter {
  if (!opts.formatters) return fallback;
  return resolveFormatterRef(opts.formatters, entryRef, fallback).formatter;
}

// ────────── Last-resort defaults ──────────
//
// Used ONLY when a formatter doesn't supply its own framing /
// flatten methods. The built-in markdown / xml / text formatters all
// supply theirs — these defaults exist to protect 3rd-party
// formatters that only implement the block-level contract.

function defaultFrameMessage(entry: MessageEntry, body: string): string {
  return `**${entry.role}:** ${body}`;
}

function defaultBlocksToText(blocks: readonly import("@agentick/spec").ContentBlock[]): string {
  // Bare TextBlock-aware fallback — concatenates text content from
  // text-shaped blocks and emits a brief placeholder for non-text
  // blocks. A 3rd-party formatter wanting richer block handling
  // supplies its own `blocksToText`.
  const out: string[] = [];
  for (const b of blocks) {
    if ((b as { text?: string }).text !== undefined) {
      out.push((b as { text: string }).text);
    } else {
      out.push(`[${b.type}]`);
    }
  }
  return out.filter((s) => s.length > 0).join("\n\n");
}
