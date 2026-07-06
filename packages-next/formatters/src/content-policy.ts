/**
 * Content-reduction formatters — `textOnlyFormatter` and
 * `summarizedFormatter`.
 *
 * Where {@link markdownFormatter} / {@link xmlFormatter} / {@link
 * textFormatter} change how blocks *serialize*, these change *which*
 * blocks survive. They are pure `SemanticContentBlock[] → ContentBlock[]`
 * reductions, so they compose in exactly the same registry and are the
 * v2 home of v1's connector `content-pipeline.ts` (`ContentPolicy` +
 * `ToolSummarizer`).
 *
 *   - {@link textOnlyFormatter}   — keep only text (+ media) blocks;
 *                                   drop `tool_use` / `tool_result`.
 *   - {@link summarizedFormatter} — collapse each `tool_use` into a short
 *                                   text summary (`[Ran: …]`, `[Read …]`)
 *                                   and drop `tool_result`; keep text/media.
 *
 * A connector applies one of these to outbound assistant content before
 * chunking + delivering to a chat surface, so a user sees prose rather
 * than raw tool-call JSON.
 *
 * @see docs/proposals/v2/blueprint/58-connectors.md §content policy
 */

import type {
  ContentBlock,
  SemanticContentBlock,
  ToolUseBlock,
  TextBlock,
} from "@agentick/spec-next";
import { isToolUseBlock } from "@agentick/spec-next";

import { createFormatter, type DefinedFormatter } from "./create-formatter.js";

// ============================================================================
// Tool summarizer (ported from v1 content-pipeline.ts)
// ============================================================================

/** Turn a `tool_use` (name + input) into a short human-readable line. */
export type ToolSummarizer = (name: string, input: Record<string, unknown>) => string;

const filePathSummary = (verb: string) => (i: Record<string, unknown>) =>
  `[${verb} ${i.path ?? i.file_path ?? "a file"}]`;

const bashSummary = (i: Record<string, unknown>) => {
  const cmd = i.command;
  if (typeof cmd === "string") {
    const short = cmd.length > 50 ? `${cmd.slice(0, 50)}...` : cmd;
    return `[Ran: ${short}]`;
  }
  return "[Ran a command]";
};

const searchFileSummary = (i: Record<string, unknown>) =>
  `[Searched for files matching "${i.pattern ?? "..."}"]`;

const searchContentSummary = (i: Record<string, unknown>) =>
  `[Searched for "${i.pattern ?? "..."}" in files]`;

const DEFAULT_SUMMARIES: Record<string, (input: Record<string, unknown>) => string> = {
  // Keys are lowercased; lookup lowercases the tool name first.
  glob: searchFileSummary,
  grep: searchContentSummary,
  read_file: filePathSummary("Read"),
  readfile: filePathSummary("Read"),
  write_file: filePathSummary("Wrote"),
  writefile: filePathSummary("Wrote"),
  edit_file: filePathSummary("Edited"),
  editfile: filePathSummary("Edited"),
  bash: bashSummary,
  shell: bashSummary,
};

/**
 * Build a tool summarizer with optional per-tool overrides. Custom
 * entries win, then the built-in defaults, then a generic `[Used <name>]`
 * fallback.
 */
export function createToolSummarizer(
  custom?: Record<string, (input: Record<string, unknown>) => string>,
): ToolSummarizer {
  return (name, input) => {
    const lower = name.toLowerCase();
    if (custom?.[lower]) return custom[lower]!(input);
    if (custom?.[name]) return custom[name]!(input);
    if (DEFAULT_SUMMARIES[lower]) return DEFAULT_SUMMARIES[lower]!(input);
    return `[Used ${name}]`;
  };
}

/** Default summarizer instance used by {@link summarizedFormatter}. */
const defaultSummarizer = createToolSummarizer();

// ============================================================================
// Block reductions
// ============================================================================

/** Keep only blocks a chat surface can render inline as content. */
function isDeliverableBlock(block: ContentBlock): boolean {
  return (
    block.type === "text" ||
    block.type === "image" ||
    block.type === "audio" ||
    block.type === "video" ||
    block.type === "document"
  );
}

function summarizeBlocks(
  blocks: readonly SemanticContentBlock[],
  summarize: ToolSummarizer,
): ContentBlock[] {
  const out: ContentBlock[] = [];
  for (const block of blocks) {
    if (isDeliverableBlock(block)) {
      out.push(block);
    } else if (isToolUseBlock(block)) {
      const toolUse = block as ToolUseBlock;
      const summary: TextBlock = {
        type: "text",
        text: summarize(toolUse.name, (toolUse.input ?? {}) as Record<string, unknown>),
      };
      out.push(summary);
    }
    // tool_result blocks are intentionally dropped — the tool_use summary
    // already conveys what happened.
  }
  return out;
}

// ============================================================================
// Formatters
// ============================================================================

/**
 * `text-only` content policy — strips `tool_use` / `tool_result`,
 * keeping text and media blocks.
 */
export const textOnlyFormatter: DefinedFormatter = createFormatter({
  id: "formatter.text-only",
  format: "text",
  render: (blocks) => blocks.filter(isDeliverableBlock),
});

/**
 * `summarized` content policy — collapses each `tool_use` into a short
 * text summary using the {@link defaultSummarizer}; drops `tool_result`.
 * For custom summaries, build a bespoke formatter with
 * {@link createSummarizedFormatter}.
 */
export const summarizedFormatter: DefinedFormatter = createFormatter({
  id: "formatter.summarized",
  format: "text",
  render: (blocks) => summarizeBlocks(blocks, defaultSummarizer),
});

/**
 * Factory for a `summarized` formatter with a custom {@link
 * ToolSummarizer}. The default {@link summarizedFormatter} is
 * `createSummarizedFormatter()`.
 */
export function createSummarizedFormatter(summarize?: ToolSummarizer): DefinedFormatter {
  const summarizer = summarize ?? defaultSummarizer;
  return createFormatter({
    id: "formatter.summarized",
    format: "text",
    render: (blocks) => summarizeBlocks(blocks, summarizer),
  });
}
