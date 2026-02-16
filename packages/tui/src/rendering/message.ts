/**
 * Full message rendering — content blocks + tool calls.
 *
 * Outputs ANSI-styled strings for console.log (Ink scrollback).
 */

import type { ContentBlock, ToolUseBlock } from "@agentick/shared";
import { extractText } from "@agentick/shared";
import { theme } from "./theme.js";
import { renderContentBlock, renderToolCall } from "./content-block.js";
import { getTerminalWidth } from "./markdown.js";

export interface ToolCallInfo {
  id: string;
  name: string;
  duration?: number;
  summary?: string;
}

export interface RenderMessageOptions {
  role: "user" | "assistant" | "system";
  content: string | ContentBlock[];
  toolCalls?: ToolCallInfo[];
}

/**
 * Render a complete message to an ANSI string for terminal output.
 *
 * User messages: subtle gray borders, muted text — recognizable but not dominant.
 * Assistant messages: rich-rendered content blocks, tool call indicators.
 * No role labels — the styling differentiates.
 */
export function renderMessage({ role, content, toolCalls }: RenderMessageOptions): string {
  const blocks: ContentBlock[] =
    typeof content === "string" ? [{ type: "text", text: content } as ContentBlock] : content;

  if (role === "user") {
    return renderUserMessage(blocks);
  }

  return renderAssistantMessage(blocks, toolCalls);
}

function renderUserMessage(blocks: ContentBlock[]): string {
  const text = extractText(blocks);
  if (!text) return "";

  const width = getTerminalWidth();
  const border = theme.border("─".repeat(width));
  const styledText = theme.dim(text);
  return `${border}\n${styledText}\n${border}`;
}

function renderAssistantMessage(blocks: ContentBlock[], toolCalls?: ToolCallInfo[]): string {
  const parts: string[] = [];

  for (const block of blocks) {
    const rendered = renderContentBlock(block);
    if (rendered) {
      parts.push(rendered);
    }
  }

  if (toolCalls && toolCalls.length > 0) {
    for (const tc of toolCalls) {
      parts.push(renderToolCall(tc.name, tc.duration, tc.summary));
    }
  } else {
    const blockToolCalls = blocks.filter((b): b is ToolUseBlock => b.type === "tool_use");
    for (const tc of blockToolCalls) {
      parts.push(renderToolCall(tc.name));
    }
  }

  return parts.join("\n");
}
