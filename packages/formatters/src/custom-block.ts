/**
 * `<tag attr="…">content</tag>` — the one rendering of a custom tag, shared by
 * the node form (a `<custom>` nested inside other structure) and the block form
 * (a leaf `<custom>`, which is a `CustomContentBlock`).
 *
 * The two drifted once already: attributes were escaped in one and not the
 * other. Escaping is the dialect's — markdown passes content through, xml
 * escapes it — so the caller supplies the escapers and this owns the shape.
 */

import type { CustomContentBlock } from "@agentick/spec";

import type { TagEscapers } from "./event-block.js";

export function renderTagAttrs(attrs: unknown, escapeAttr: (s: string) => string): string {
  if (attrs === null || typeof attrs !== "object") return "";
  return Object.entries(attrs as Record<string, unknown>)
    .map(([k, v]) => ` ${k}="${escapeAttr(String(v))}"`)
    .join("");
}

export function renderCustomTag(
  tag: string,
  attrs: unknown,
  content: string,
  selfClosing: boolean,
  escape: TagEscapers,
): string {
  const head = renderTagAttrs(attrs, escape.attr);
  return selfClosing ? `<${tag}${head} />` : `<${tag}${head}>${escape.content(content)}</${tag}>`;
}

export function renderCustomBlock(block: CustomContentBlock, escape: TagEscapers): string {
  return renderCustomTag(block.tag, block.attrs, block.content, block.selfClosing === true, escape);
}
