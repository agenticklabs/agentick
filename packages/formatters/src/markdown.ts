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
  MessageEntry,
  SemanticContentBlock,
  SemanticNode,
  TextBlock,
} from "@agentick/spec";

import { createFormatter } from "./create-formatter.js";
import { renderCustomBlock, renderCustomTag } from "./custom-block.js";
import { renderEventTag, type TagEscapers } from "./event-block.js";

// ============================================================================
// Semantic node walker
// ============================================================================

/**
 * Attribute list for a custom tag. Values are escaped exactly as the xml
 * formatter escapes them — attribute position is attribute position in any
 * dialect, and a raw `"`, `<` or `&` there produces a malformed tag. The
 * surrounding markdown is untouched.
 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Content stays verbatim — markdown's raw-HTML passthrough, same as `<custom>`. */
const markdownEscapers: TagEscapers = { attr: escapeAttr, content: (s) => s };

function formatNode(node: SemanticNode, inItem = false): string {
  if (node.text !== undefined && node.semantic === undefined) {
    return node.text;
  }

  const childText = (node.children ?? [])
    .map((child) => formatNode(child, node.semantic === "list-item"))
    .join("");

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
      // A list opening MID-ITEM must break the line first, or its first
      // marker glues onto the item's own text ("…summary.- `name`").
      const lead = inItem ? "\n" : "";
      return (
        lead +
        (node.children ?? [])
          .map((item, i) => {
            // Continuation lines — a nested list inside the item included —
            // indent under their marker, which is what makes `<ul>` in `<li>`
            // an actual nested list instead of a flat run at column 0.
            const inner = formatNode(item).trimEnd();
            const [first = "", ...rest] = inner.split("\n");
            const indented = [
              first,
              ...rest.map((line) => (line === "" ? line : `  ${line}`)),
            ].join("\n");
            return ordered ? `${i + 1}. ${indented}` : `- ${indented}`;
          })
          .join("\n")
          .concat("\n\n")
      );
    }
    case "list-item":
      return childText;
    case "table": {
      const rows = node.children ?? [];
      if (rows.length === 0) return "";
      const header = rows[0]!;
      const headerCells = (header.children ?? []).map((child) => formatNode(child));
      const separator = headerCells.map(() => "---");
      const body = rows
        .slice(1)
        .map((r) => (r.children ?? []).map((child) => formatNode(child)).join(" | "));
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
    case "block":
      // Generic structural container (`<div>`, `<article>`, `<main>`, …).
      // Markdown has no specific block syntax — convey the block-ness
      // via a paragraph break. Trailing newline lets adjacent blocks
      // separate naturally.
      return `${childText}\n\n`;
    case "inline":
    case "inline-block":
      // Generic inline container (`<span>`). No wrapping; children
      // concatenate inline.
      return childText;
    case "custom": {
      // The tag SURVIVES. A custom node's declared purpose is "render this
      // under my own tag", and markdown is a superset of HTML — CommonMark
      // specifies raw HTML blocks, and this formatter already emits `<kbd>`
      // and `<var>` a few cases up. Dropping it left the escape hatch
      // unreachable in the only dialect anyone renders.
      //
      // Content is NOT escaped: it is markdown, and escaping `<` would break
      // every other construct. Attribute values are, since a quote there ends
      // the tag.
      return renderCustomTag(
        String(node.props?.tag ?? "custom"),
        node.props?.attrs,
        childText,
        node.props?.selfClosing === true,
        markdownEscapers,
      );
    }
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
      return { type: "text", text: renderEventTag(block, markdownEscapers) } satisfies TextBlock;
    case "custom":
      return { type: "text", text: renderCustomBlock(block, markdownEscapers) } satisfies TextBlock;
    default:
      // image / audio / video / document / tool_use / tool_result / generated_* /
      // executable_code / code_execution_result — pass through unchanged.
      return block;
  }
}

// ============================================================================
// Tree-level framing + flatten (owned by this formatter)
// ============================================================================

function frameMessage(entry: MessageEntry, body: string): string {
  return `**${entry.role}:** ${body}`;
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
    case "image": {
      const src = block.source.type === "url" ? block.source.url : "[binary]";
      return `![${block.altText ?? ""}](${src})`;
    }
    case "document":
    case "audio":
    case "video": {
      const src = block.source.type === "url" ? block.source.url : "[binary]";
      return `[${block.type}](${src})`;
    }
    case "tool_use":
      return `[tool_use ${block.name}] ${JSON.stringify(block.input)}`;
    case "tool_result":
      return blocksToText(block.content);
    case "user_action":
    case "system_event":
    case "state_change":
      return renderEventTag(block, markdownEscapers);
    case "custom":
      return renderCustomBlock(block, markdownEscapers);
    default:
      return "";
  }
}

export const markdownFormatter = createFormatter({
  id: "formatter.markdown",
  format: "markdown",
  render: (blocks) => blocks.map(formatBlock),
  frameMessage,
  blocksToText,
});
