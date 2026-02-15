import type { ChatMessage } from "@agentick/client";
import type { ContentBlock } from "@agentick/shared";
import { isToolUseBlock } from "@agentick/shared";
import type { ContentPolicy, ContentPolicyFn } from "./types.js";

/**
 * Summarize a tool call as human-readable text.
 * Connectors can override this per-tool via ContentPolicy functions,
 * or provide a custom `summarizeTool` in ConnectorConfig.
 */
export type ToolSummarizer = (name: string, input: Record<string, unknown>) => string;

/**
 * Default tool summaries for common tools.
 * Returns null for unknown tools (falls through to generic summary).
 */
const filePathSummary = (verb: string) => (i: Record<string, unknown>) =>
  `[${verb} ${i.path ?? i.file_path ?? "a file"}]`;

const shellSummary = (i: Record<string, unknown>) => {
  const cmd = i.command;
  if (typeof cmd === "string") {
    const short = cmd.length > 50 ? cmd.slice(0, 50) + "..." : cmd;
    return `[Ran: ${short}]`;
  }
  return `[Ran a command]`;
};

const searchFileSummary = (i: Record<string, unknown>) =>
  `[Searched for files matching "${i.pattern ?? "..."}"]`;

const searchContentSummary = (i: Record<string, unknown>) =>
  `[Searched for "${i.pattern ?? "..."}" in files]`;

const DEFAULT_SUMMARIES: Record<string, (input: Record<string, unknown>) => string> = {
  // Lookup is case-insensitive via lowercasing, so only need lowercase keys.
  // Tool names like "ReadFile" become "readfile", "read_file" stays "read_file".
  glob: searchFileSummary,
  grep: searchContentSummary,
  read_file: filePathSummary("Read"),
  readfile: filePathSummary("Read"),
  write_file: filePathSummary("Wrote"),
  writefile: filePathSummary("Wrote"),
  edit_file: filePathSummary("Edited"),
  editfile: filePathSummary("Edited"),
  shell: shellSummary,
};

/**
 * Create a tool summarizer with optional custom overrides.
 * Custom summaries are checked first, then defaults, then generic fallback.
 */
export function createToolSummarizer(
  custom?: Record<string, (input: Record<string, unknown>) => string>,
): ToolSummarizer {
  return (name: string, input: Record<string, unknown>) => {
    const lower = name.toLowerCase();

    // Custom overrides first
    if (custom?.[lower]) return custom[lower](input);
    if (custom?.[name]) return custom[name](input);

    // Built-in defaults
    if (DEFAULT_SUMMARIES[lower]) return DEFAULT_SUMMARIES[lower](input);

    // Generic fallback
    return `[Used ${name}]`;
  };
}

/** Default summarizer instance. */
const defaultSummarizer = createToolSummarizer();

/**
 * Build a filter function from a ContentPolicy.
 */
export function buildContentFilter(
  policy: ContentPolicy,
  toolSummarizer?: ToolSummarizer,
): ContentPolicyFn {
  if (typeof policy === "function") return policy;

  const summarize = toolSummarizer ?? defaultSummarizer;

  switch (policy) {
    case "full":
      return (msg) => msg;
    case "text-only":
      return filterTextOnly;
    case "summarized":
      return (msg) => filterSummarized(msg, summarize);
  }
}

/**
 * Strip tool_use and tool_result blocks, keeping text and images.
 */
function filterTextOnly(message: ChatMessage): ChatMessage | null {
  if (typeof message.content === "string") return message;

  const filtered = message.content.filter(
    (block) => block.type === "text" || block.type === "image",
  );

  if (filtered.length === 0) return null;

  return {
    ...message,
    content: filtered,
    toolCalls: undefined,
  };
}

/**
 * Collapse tool_use blocks into brief text summaries, keep text content.
 */
function filterSummarized(message: ChatMessage, summarize: ToolSummarizer): ChatMessage | null {
  if (typeof message.content === "string") return message;

  const blocks: ContentBlock[] = [];

  for (const block of message.content) {
    if (block.type === "text" || block.type === "image") {
      blocks.push(block);
    } else if (isToolUseBlock(block)) {
      const summary = summarize(block.name, block.input);
      blocks.push({ type: "text", text: summary } as ContentBlock);
    }
    // tool_result blocks are dropped — the summary from tool_use is enough
  }

  if (blocks.length === 0) return null;

  return {
    ...message,
    content: blocks,
    toolCalls: undefined,
  };
}

/**
 * Apply the content filter to a batch of messages.
 * Returns only messages that survive filtering.
 */
export function applyContentPolicy(
  messages: readonly ChatMessage[],
  filter: ContentPolicyFn,
): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const msg of messages) {
    // Only filter assistant messages — user messages pass through
    if (msg.role === "user") {
      result.push(msg);
      continue;
    }
    const filtered = filter(msg);
    if (filtered) result.push(filtered);
  }
  return result;
}
