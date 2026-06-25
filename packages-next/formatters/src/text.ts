/**
 * Plain-text formatter — strips all semantic markup and emits flat text.
 *
 * Used by terminal CLIs, log dumps, and prompt previews where the
 * structural framing of markdown/XML is noise.
 */

import type {
  ContentBlock,
  SemanticContentBlock,
  SemanticNode,
  TextBlock,
} from "@agentick/spec-next";

import { createFormatter } from "./create-formatter.js";

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
      return { type: "text", text: block.text ?? "" } satisfies TextBlock;
    default:
      return block;
  }
}

export const textFormatter = createFormatter({
  id: "formatter.text",
  format: "text",
  render: (blocks) => blocks.map(formatBlock),
});
