/**
 * Plain-text formatter — strips all semantic markup and emits flat text.
 *
 * Used by terminal CLIs, log dumps, and prompt previews where the
 * structural framing of markdown/XML is noise.
 */

import type {
  ContentBlock,
  MessageEntry,
  SemanticContentBlock,
  SemanticNode,
  TextBlock,
} from "@agentick/spec";

import { createFormatter } from "./create-formatter.js";
import { renderEventPlain } from "./event-block.js";

function formatNode(node: SemanticNode): string {
  if (node.text !== undefined && node.semantic === undefined) {
    return node.text;
  }
  const child = (node.children ?? []).map(formatNode).join("");
  switch (node.semantic) {
    case "heading":
      return `${child}\n\n`;
    case "paragraph":
      return `${child}\n\n`;
    case "list":
      return (node.children ?? [])
        .map((item) => formatNode(item))
        .join("\n")
        .concat("\n\n");
    case "list-item":
      return child;
    case "table": {
      const rows = (node.children ?? [])
        .map((r) => (r.children ?? []).map(formatNode).join("\t"))
        .join("\n");
      return `${rows}\n\n`;
    }
    case "blockquote":
      return `${child}\n\n`;
    case "line-break":
      return "\n";
    case "horizontal-rule":
      return "\n";
    case "link":
      return `${child} (${String(node.props?.href ?? "")})`;
    case "image":
    case "audio":
    case "video":
      return `[${node.semantic}: ${String(node.props?.src ?? "")}]`;
    case "block":
      // Generic structural container — plain-text adds a paragraph
      // break to separate adjacent blocks.
      return `${child}\n\n`;
    case "inline":
    case "inline-block":
      // No wrapping in plain text.
      return child;
    default:
      return child;
  }
}

function formatBlock(block: SemanticContentBlock): ContentBlock {
  if (block.semanticNode) {
    return { type: "text", text: formatNode(block.semanticNode) } satisfies TextBlock;
  }
  switch (block.type) {
    case "text":
    case "reasoning":
    case "xml":
    case "csv":
    case "html":
    case "code":
      return { type: "text", text: block.text ?? "" } satisfies TextBlock;
    case "json":
      return {
        type: "text",
        text: block.text ?? (block.data !== undefined ? JSON.stringify(block.data) : ""),
      } satisfies TextBlock;
    case "user_action":
    case "system_event":
    case "state_change":
      return { type: "text", text: renderEventPlain(block) } satisfies TextBlock;
    default:
      return block;
  }
}

// ============================================================================
// Tree-level framing + flatten (owned by this formatter)
// ============================================================================

function frameMessage(entry: MessageEntry, body: string): string {
  return `${entry.role}: ${body}`;
}

function blocksToText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((b) => blockToText(b))
    .filter((s) => s.length > 0)
    .join("\n\n");
}

function blockToText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
    case "reasoning":
    case "xml":
    case "csv":
    case "html":
      return block.text ?? "";
    case "code":
      return block.text;
    case "json":
      return block.text ?? (block.data !== undefined ? JSON.stringify(block.data) : "");
    case "image":
    case "document":
    case "audio":
    case "video": {
      const src = block.source.type === "url" ? block.source.url : "[binary]";
      return `[${block.type}: ${src}]`;
    }
    case "tool_use":
      return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`;
    case "tool_result":
      return blocksToText(block.content);
    case "user_action":
    case "system_event":
    case "state_change":
      return renderEventPlain(block);
    case "custom":
      return block.content;
    default:
      return "";
  }
}

export const textFormatter = createFormatter({
  id: "formatter.text",
  format: "text",
  render: (blocks) => blocks.map(formatBlock),
  frameMessage,
  blocksToText,
});
