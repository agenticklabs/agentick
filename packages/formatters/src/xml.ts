/**
 * XML formatter — wraps semantic content in XML tags.
 *
 * Same shape as {@link markdownFormatter}; emits XML markup instead.
 * Useful for prompts where the model is instructed to read structured
 * tags (`<context>`, `<example>`, `<reasoning>`).
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

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const xmlEscapers: TagEscapers = { attr: escapeXml, content: escapeXml };

function formatNode(node: SemanticNode): string {
  if (node.text !== undefined && node.semantic === undefined) {
    return escapeXml(node.text);
  }

  const childText = (node.children ?? []).map(formatNode).join("");

  switch (node.semantic) {
    case "strong":
      return `<strong>${childText}</strong>`;
    case "em":
      return `<em>${childText}</em>`;
    case "mark":
      return `<mark>${childText}</mark>`;
    case "underline":
      return `<u>${childText}</u>`;
    case "strikethrough":
      return `<s>${childText}</s>`;
    case "subscript":
      return `<sub>${childText}</sub>`;
    case "superscript":
      return `<sup>${childText}</sup>`;
    case "small":
      return `<small>${childText}</small>`;
    case "code":
      return `<code>${childText}</code>`;
    case "heading": {
      const level = Math.min(Math.max(Number(node.props?.level ?? 1), 1), 6);
      return `<h${level}>${childText}</h${level}>`;
    }
    case "paragraph":
      return `<p>${childText}</p>`;
    case "list": {
      const tag = node.props?.ordered === true ? "ol" : "ul";
      const items = (node.children ?? []).map((item) => `<li>${formatNode(item)}</li>`).join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "list-item":
      return childText;
    case "table": {
      const rows = (node.children ?? [])
        .map((r) => {
          const cells = (r.children ?? []).map((c) => `<td>${formatNode(c)}</td>`).join("");
          return `<tr>${cells}</tr>`;
        })
        .join("");
      return `<table>${rows}</table>`;
    }
    case "blockquote":
      return `<blockquote>${childText}</blockquote>`;
    case "line-break":
      return "<br/>";
    case "horizontal-rule":
      return "<hr/>";
    case "link":
      return `<a href="${escapeXml(String(node.props?.href ?? ""))}">${childText}</a>`;
    case "image": {
      const src = escapeXml(String(node.props?.src ?? ""));
      const alt = escapeXml(String(node.props?.alt ?? ""));
      return `<img src="${src}" alt="${alt}"/>`;
    }
    case "audio":
    case "video": {
      const src = escapeXml(String(node.props?.src ?? ""));
      return `<${node.semantic} src="${src}"/>`;
    }
    case "quote":
      return `<q>${childText}</q>`;
    case "citation":
      return `<cite>${childText}</cite>`;
    case "keyboard":
      return `<kbd>${childText}</kbd>`;
    case "variable":
      return `<var>${childText}</var>`;
    case "preformatted":
      return `<pre>${childText}</pre>`;
    case "block":
      // Generic structural container (`<div>`, `<article>`, …).
      // XML wraps in `<div>` to preserve the block-ness in the markup.
      return `<div>${childText}</div>`;
    case "inline":
    case "inline-block":
      // Generic inline container (`<span>`). Wrap in `<span>` so
      // the inline structure round-trips in xml output.
      return `<span>${childText}</span>`;
    case "custom": {
      const tag = String(node.props?.tag ?? "custom");
      const selfClosing = node.props?.selfClosing === true;
      // Pretty-print structure: an element whose children are THEMSELVES
      // elements lays them out one per line, indented — inline join rendered
      // `<message_metadata>` (and every other element tree) as one run-on
      // wall. Text content stays inline in its own tags; whitespace-only text
      // nodes between elements (JSX gaps) are layout, not content, and drop.
      const kids = node.children ?? [];
      const elementKids = kids.filter((k) => k.semantic !== undefined);
      if (!selfClosing && elementKids.length > 0) {
        const parts = kids
          .filter((k) => !(k.semantic === undefined && (k.text ?? "").trim() === ""))
          .map((k) => formatNode(k).replace(/^/gm, "  "));
        const head = renderCustomTag(tag, node.props?.attrs, "", false, {
          attr: escapeXml,
          content: (c) => c,
        });
        const open = head.slice(0, head.length - `</${tag}>`.length);
        return `${open}\n${parts.join("\n")}\n</${tag}>`;
      }
      // The children are already escaped — they came through this walk.
      return renderCustomTag(tag, node.props?.attrs, childText, selfClosing, {
        attr: escapeXml,
        content: (c) => c,
      });
    }
    default:
      return childText;
  }
}

function formatBlock(block: SemanticContentBlock): ContentBlock {
  if (block.semanticNode) {
    return { type: "text", text: formatNode(block.semanticNode) } satisfies TextBlock;
  }
  switch (block.type) {
    case "text":
      return { type: "text", text: escapeXml(block.text) } satisfies TextBlock;
    case "reasoning":
      return {
        type: "text",
        text: `<reasoning>${escapeXml(block.text)}</reasoning>`,
      } satisfies TextBlock;
    case "code": {
      const c = block as CodeBlock;
      const lang = c.language ? ` language="${escapeXml(c.language)}"` : "";
      return {
        type: "text",
        text: `<code${lang}>${escapeXml(c.text)}</code>`,
      } satisfies TextBlock;
    }
    case "json": {
      const j = block as JsonBlock;
      const text = j.text ?? (j.data !== undefined ? JSON.stringify(j.data) : "");
      return {
        type: "text",
        text: `<json>${escapeXml(text)}</json>`,
      } satisfies TextBlock;
    }
    case "xml":
    case "html":
      return { type: "text", text: block.text ?? "" } satisfies TextBlock;
    case "csv":
      return {
        type: "text",
        text: `<csv>${escapeXml(block.text ?? "")}</csv>`,
      } satisfies TextBlock;
    case "user_action":
    case "system_event":
    case "state_change":
      return { type: "text", text: renderEventTag(block, xmlEscapers) } satisfies TextBlock;
    case "custom":
      return { type: "text", text: renderCustomBlock(block, xmlEscapers) } satisfies TextBlock;
    default:
      return block;
  }
}

// ============================================================================
// Tree-level framing + flatten (owned by this formatter)
// ============================================================================

function frameMessage(entry: MessageEntry, body: string): string {
  return `<message role="${escapeXml(entry.role)}">\n${body}\n</message>`;
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
      const alt = block.altText ? ` alt="${escapeXml(block.altText)}"` : "";
      return `<image src="${escapeXml(src)}"${alt}/>`;
    }
    case "document":
    case "audio":
    case "video": {
      const src = block.source.type === "url" ? block.source.url : "[binary]";
      return `<${block.type} src="${escapeXml(src)}"/>`;
    }
    case "tool_use":
      return `<tool_use name="${escapeXml(block.name)}">${escapeXml(JSON.stringify(block.input))}</tool_use>`;
    case "tool_result":
      return `<tool_result>${blocksToText(block.content)}</tool_result>`;
    case "user_action":
    case "system_event":
    case "state_change":
      return renderEventTag(block, xmlEscapers);
    case "custom":
      // Content is escaped here, unlike markdown — the `html` block is the
      // way through in this dialect.
      return renderCustomBlock(block, xmlEscapers);
    default:
      return "";
  }
}

export const xmlFormatter = createFormatter({
  id: "formatter.xml",
  format: "xml",
  render: (blocks) => blocks.map(formatBlock),
  frameMessage,
  blocksToText,
});
