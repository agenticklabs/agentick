/**
 * Auto-summary functions for collapsed components.
 *
 * Pure functions — no React, fully testable.
 * Each returns a short text summary suitable for:
 * - Knob description (model sees this in set_knob tool)
 * - Collapsed rendering fallback (when collapsed={true})
 */

import type { ContentBlock, MessageRoles } from "@agentick/shared";
import { extractText } from "@agentick/shared";

const MAX_SUMMARY_LENGTH = 80;

function truncate(text: string, max = MAX_SUMMARY_LENGTH): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

/**
 * Auto-summarize a message.
 *
 * Role-aware:
 * - Assistant messages: text-only (no tool/media metadata).
 *   Including fake metadata like "[tools: shell ×3]" in assistant
 *   summaries causes ICL corruption — the model starts producing
 *   literal metadata strings instead of real tool calls.
 * - Other roles: role prefix + truncated text.
 */
export function autoMessageSummary(
  role: MessageRoles,
  content?: ContentBlock[] | string | any[],
): string {
  if (!content) return `[${role}]`;

  const text = typeof content === "string" ? content : extractText(content as ContentBlock[], " ");

  if (!text) return `[${role}]`;

  if (role === "assistant") {
    // Text-only for assistant — never include tool/media metadata
    return truncate(text);
  }

  return truncate(`${role}: ${text}`);
}

/**
 * Auto-summarize a section.
 * Uses title, falls back to id, falls back to "section".
 */
export function autoSectionSummary(title?: string, id?: string): string {
  return title ?? id ?? "section";
}

/**
 * Auto-summarize a content block by type.
 * Returns a type-specific default like "[image]", "[code: ts]", etc.
 */
export function autoContentSummary(type: string, props: Record<string, any>): string {
  switch (type) {
    case "Text":
    case "text": {
      const text = props.text ?? props.children;
      if (typeof text === "string") return truncate(text);
      return "[text]";
    }
    case "Image":
    case "image":
      return props.altText ? `[image: ${truncate(props.altText, 40)}]` : "[image]";
    case "Code":
    case "code":
      return props.language ? `[code: ${props.language}]` : "[code]";
    case "Json":
    case "json":
      return "[json]";
    case "Document":
    case "document":
      return props.title ? `[document: ${truncate(props.title, 40)}]` : "[document]";
    case "Audio":
    case "audio":
      return "[audio]";
    case "Video":
    case "video":
      return "[video]";
    case "ToolUse":
    case "tooluse":
      return props.name ? `[tool: ${props.name}]` : "[tool]";
    default:
      return `[${type}]`;
  }
}
