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
  SemanticContentBlock,
  SemanticNode,
  TextBlock,
} from "@agentick/spec";

import { defineFormatter } from "./define-formatter.js";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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
      const items = (node.children ?? [])
        .map((item) => `<li>${formatNode(item)}</li>`)
        .join("");
      return `<${tag}>${items}</${tag}>`;
    }
    case "list-item":
      return childText;
    case "table": {
      const rows = (node.children ?? [])
        .map((r) => {
          const cells = (r.children ?? [])
            .map((c) => `<td>${formatNode(c)}</td>`)
            .join("");
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
    case "custom": {
      const tag = String(node.props?.tag ?? "custom");
      return `<${tag}>${childText}</${tag}>`;
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
      return {
        type: "text",
        text: `<${block.type}>${escapeXml(block.text ?? "")}</${block.type}>`,
      } satisfies TextBlock;
    default:
      return block;
  }
}

export const xmlFormatter = defineFormatter({
  id: "formatter.xml",
  format: "xml",
  render: (blocks) => blocks.map(formatBlock),
});
