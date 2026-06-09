/**
 * Markdown formatter — default for v2.
 *
 * Walks `SemanticContentBlock[]` and produces wire-ready `ContentBlock[]`.
 * For each block:
 *
 *   - When `semanticNode` is present, recursively walk the semantic
 *     tree and emit a `TextBlock` carrying markdown-formatted text.
 *   - Code/JSON blocks → `TextBlock` with fenced markdown.
 *   - Image/audio/video/document → native blocks pass through.
 *   - Event blocks (`user_action`, `system_event`, `state_change`) →
 *     `TextBlock` with the block's `.text` if present, or a synthesized
 *     human-readable line.
 *
 * Direct port of v1's `MarkdownRenderer.formatStandard` +
 * `MarkdownRenderer.formatNode` (`packages/core/src/renderers/markdown.ts`).
 */

import type {
  CodeBlock,
  ContentBlock,
  JsonBlock,
  SemanticContentBlock,
  SemanticNode,
  TextBlock,
} from "@agentick/spec-next";

import { defineFormatter } from "./define-formatter.js";

// ============================================================================
// Semantic node walker
// ============================================================================

function formatNode(node: SemanticNode): string {
  if (node.text !== undefined && node.semantic === undefined) {
    return node.text;
  }

  const childText = (node.children ?? []).map(formatNode).join("");

  switch (node.semantic) {
    case "strong":
      return `**${childText}**`;
    case "em":
      return `*${childText}*`;
    case "mark":
      return `==${childText}==`;
    case "underline":
      return `<u>${childText}</u>`;
    case "strikethrough":
      return `~~${childText}~~`;
    case "subscript":
      return `<sub>${childText}</sub>`;
    case "superscript":
      return `<sup>${childText}</sup>`;
    case "small":
      return `<small>${childText}</small>`;
    case "code":
      return `\`${childText}\``;
    case "heading": {
      const level = Math.min(Math.max(Number(node.props?.level ?? 1), 1), 6);
      return `${"#".repeat(level)} ${childText}\n\n`;
    }
    case "paragraph":
      return `${childText}\n\n`;
    case "list": {
      const ordered = node.props?.ordered === true;
      return (node.children ?? [])
        .map((item, i) => {
          const inner = formatNode(item);
          return ordered ? `${i + 1}. ${inner}` : `- ${inner}`;
        })
        .join("\n")
        .concat("\n\n");
    }
    case "list-item":
      return childText;
    case "table": {
      const rows = node.children ?? [];
      if (rows.length === 0) return "";
      const header = rows[0]!;
      const headerCells = (header.children ?? []).map(formatNode);
      const separator = headerCells.map(() => "---");
      const body = rows.slice(1).map((r) => (r.children ?? []).map(formatNode).join(" | "));
      const lines = [
        `| ${headerCells.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((b) => `| ${b} |`),
      ];
      return `${lines.join("\n")}\n\n`;
    }
    case "blockquote":
      return childText
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n")
        .concat("\n\n");
    case "line-break":
      return "\n";
    case "horizontal-rule":
      return "\n---\n\n";
    case "link":
      return `[${childText}](${String(node.props?.href ?? "")})`;
    case "image": {
      const src = String(node.props?.src ?? "");
      const alt = String(node.props?.alt ?? "");
      return `![${alt}](${src})`;
    }
    case "audio":
    case "video": {
      const src = String(node.props?.src ?? "");
      return `[${node.semantic}](${src})`;
    }
    case "quote":
      return `"${childText}"`;
    case "citation":
      return `[${childText}]`;
    case "keyboard":
      return `<kbd>${childText}</kbd>`;
    case "variable":
      return `<var>${childText}</var>`;
    case "preformatted":
      return `\`\`\`\n${childText}\n\`\`\``;
    case "custom":
      return childText;
    default:
      return childText;
  }
}

// ============================================================================
// Block-level pass
// ============================================================================

function formatBlock(block: SemanticContentBlock): ContentBlock {
  if (block.semanticNode) {
    const text = formatNode(block.semanticNode);
    return { type: "text", text };
  }
  switch (block.type) {
    case "text":
    case "reasoning":
      return block;
    case "code": {
      const c = block as CodeBlock;
      return {
        type: "text",
        text: `\`\`\`${c.language ?? ""}\n${c.text}\n\`\`\``,
      } satisfies TextBlock;
    }
    case "json": {
      const j = block as JsonBlock;
      const text = j.text ?? (j.data !== undefined ? JSON.stringify(j.data) : "");
      return {
        type: "text",
        text: `\`\`\`json\n${text}\n\`\`\``,
      } satisfies TextBlock;
    }
    case "xml":
    case "csv":
    case "html":
      return { type: "text", text: block.text ?? "" } satisfies TextBlock;
    case "user_action":
    case "system_event":
    case "state_change":
      return { type: "text", text: block.text ?? "" } satisfies TextBlock;
    default:
      // image / audio / video / document / tool_use / tool_result / generated_* /
      // executable_code / code_execution_result / custom — pass through unchanged.
      return block;
  }
}

export const markdownFormatter = defineFormatter({
  id: "formatter.markdown",
  format: "markdown",
  render: (blocks) => blocks.map(formatBlock),
});
