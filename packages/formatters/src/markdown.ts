/**
 * Markdown formatter — default for v2 (ADR 111).
 *
 * The formatter decides which mdast node a block or semantic node becomes;
 * `mdast-util-to-markdown` lays it out. Text is never escaped: markdown is the
 * dialect authors and tools write in, raw HTML is legal CommonMark, and a `*`
 * an author typed is theirs. Raw tags — custom elements, `<kbd>` and friends —
 * are `html` nodes: the tag with its attributes escaped, its content verbatim.
 */

import { toMarkdown, type Options } from "mdast-util-to-markdown";
import { gfmTableToMarkdown } from "mdast-util-gfm-table";
import { gfmStrikethroughToMarkdown } from "mdast-util-gfm-strikethrough";
import type { Nodes, PhrasingContent, RootContent, BlockContent } from "mdast";

import type {
  CodeBlock,
  ContentBlock,
  JsonBlock,
  MessageEntry,
  SemanticContentBlock,
  SemanticNode,
  TextBlock,
} from "@agentick/spec";

import { createFormatter, type DefinedFormatter } from "./create-formatter.js";
import { renderCustomBlock, renderCustomTag } from "./custom-block.js";
import { renderEventTag, type TagEscapers } from "./event-block.js";

/** Attribute position is attribute position in any dialect: a raw `"`, `<` or `&` there breaks the tag. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

/** Content stays verbatim — markdown's raw-HTML passthrough. */
const markdownEscapers: TagEscapers = { attr: escapeAttr, content: (s) => s };

export interface MarkdownFormatterOptions {
  /** Registry id; default `formatter.markdown`. Two configurations are two ids. */
  readonly id?: string;
  readonly version?: string;
  /** `mdast-util-to-markdown` options, merged over the dialect's (`bullet`, `rule`, `fences`, `handlers`, `unsafe`, `extensions`, …). */
  readonly layout?: Partial<Options>;
  /** Per block type, the rendering; return `undefined` to fall back to the dialect's. */
  readonly blocks?: Partial<
    Record<SemanticContentBlock["type"], (block: SemanticContentBlock) => ContentBlock | undefined>
  >;
}

/**
 * Today's look, pinned. Text is never escaped: the library's `text`, `link` and
 * `image` handlers are where it escapes, so they write their values as-is
 * (`unsafe` is merged into the defaults, not replaced — it cannot say "none").
 * A hard break is a newline, as it was, not a backslash.
 */
const DEFAULT_LAYOUT: Options = {
  bullet: "-",
  rule: "-",
  emphasis: "*",
  strong: "*",
  fences: true,
  listItemIndent: "one",
  extensions: [gfmTableToMarkdown(), gfmStrikethroughToMarkdown()],
  handlers: {
    text: (node) => node.value,
    break: () => "\n",
    link: (node, _parent, state, info) => `[${state.containerPhrasing(node, info)}](${node.url})`,
    image: (node) => `![${node.alt ?? ""}](${node.url})`,
  },
};

const text = (value: string): PhrasingContent => ({ type: "text", value });
const html = (value: string): RootContent => ({ type: "html", value });

export function createMarkdownFormatter(options: MarkdownFormatterOptions = {}): DefinedFormatter {
  const layout: Options = {
    ...DEFAULT_LAYOUT,
    ...options.layout,
    handlers: { ...DEFAULT_LAYOUT.handlers, ...options.layout?.handlers },
    extensions: [...(DEFAULT_LAYOUT.extensions ?? []), ...(options.layout?.extensions ?? [])],
  };

  /** Inline nodes only; a block-level child inside an inline position is laid out as its own text. */
  function inlineOf(nodes: readonly RootContent[]): PhrasingContent[] {
    return nodes.map((n) =>
      isPhrasing(n)
        ? n
        : text(toMarkdown({ type: "root", children: [n] }, layout).replace(/\n$/, "")),
    );
  }

  const PHRASING = new Set([
    "text",
    "emphasis",
    "strong",
    "delete",
    "inlineCode",
    "link",
    "image",
    "break",
    "html",
  ]);
  const isPhrasing = (n: RootContent): n is PhrasingContent => PHRASING.has(n.type);

  /** Block nodes only; a run of inline nodes in block position becomes a paragraph. */
  function blocksOf(nodes: readonly RootContent[]): BlockContent[] {
    const out: BlockContent[] = [];
    let run: PhrasingContent[] = [];
    const flush = (): void => {
      if (run.length > 0) out.push({ type: "paragraph", children: run });
      run = [];
    };
    for (const n of nodes) {
      if (isPhrasing(n)) run.push(n);
      else {
        flush();
        out.push(n as BlockContent);
      }
    }
    flush();
    return out;
  }

  const rawTag = (
    tag: string,
    attrs: unknown,
    inner: readonly RootContent[],
    selfClosing: boolean,
  ): RootContent =>
    html(
      renderCustomTag(tag, attrs, selfClosing ? "" : render(inner), selfClosing, markdownEscapers),
    );

  function formatNode(node: SemanticNode): RootContent[] {
    if (node.text !== undefined && node.semantic === undefined) return [text(node.text)];
    const children = node.children ?? [];
    const kids = children.flatMap(formatNode);

    switch (node.semantic) {
      case "strong":
        return [{ type: "strong", children: inlineOf(kids) }];
      case "em":
        return [{ type: "emphasis", children: inlineOf(kids) }];
      case "strikethrough":
        return [{ type: "delete", children: inlineOf(kids) }];
      case "code":
        return [{ type: "inlineCode", value: render(kids) }];
      case "mark":
        return [text(`==${render(kids)}==`)];
      case "underline":
        return [rawTag("u", undefined, kids, false)];
      case "subscript":
        return [rawTag("sub", undefined, kids, false)];
      case "superscript":
        return [rawTag("sup", undefined, kids, false)];
      case "small":
        return [rawTag("small", undefined, kids, false)];
      case "keyboard":
        return [rawTag("kbd", undefined, kids, false)];
      case "variable":
        return [rawTag("var", undefined, kids, false)];
      case "heading": {
        const depth = Math.min(Math.max(Number(node.props?.level ?? 1), 1), 6) as
          | 1
          | 2
          | 3
          | 4
          | 5
          | 6;
        return [{ type: "heading", depth, children: inlineOf(kids) }];
      }
      case "paragraph":
      case "block":
        return [{ type: "paragraph", children: inlineOf(kids) }];
      case "list":
        return [
          {
            type: "list",
            ordered: node.props?.ordered === true,
            spread: false,
            children: children.map((item) => ({
              type: "listItem",
              spread: false,
              children: blocksOf(formatNode(item)),
            })),
          },
        ];
      case "list-item":
        return kids;
      case "table":
        return [
          {
            type: "table",
            children: children.map((row) => ({
              type: "tableRow",
              children: (row.children ?? []).map((cell) => ({
                type: "tableCell",
                children: inlineOf(formatNode(cell)),
              })),
            })),
          },
        ];
      case "blockquote":
        return [{ type: "blockquote", children: blocksOf(kids) }];
      case "line-break":
        return [{ type: "break" }];
      case "horizontal-rule":
        return [{ type: "thematicBreak" }];
      case "link":
        return [{ type: "link", url: String(node.props?.href ?? ""), children: inlineOf(kids) }];
      case "image":
        return [
          { type: "image", url: String(node.props?.src ?? ""), alt: String(node.props?.alt ?? "") },
        ];
      case "audio":
      case "video":
        return [
          { type: "link", url: String(node.props?.src ?? ""), children: [text(node.semantic)] },
        ];
      case "quote":
        return [text(`"${render(kids)}"`)];
      case "citation":
        return [text(`[${render(kids)}]`)];
      case "preformatted":
        return [{ type: "code", value: render(kids) }];
      case "inline":
      case "inline-block":
        return kids;
      case "custom":
        return [
          rawTag(
            String(node.props?.tag ?? "custom"),
            node.props?.attrs,
            kids,
            node.props?.selfClosing === true,
          ),
        ];
      default:
        return kids;
    }
  }

  /** Nodes to markdown. Inline runs stay inline; blocks get their layout; no trailing newline. */
  function render(nodes: readonly RootContent[]): string {
    if (nodes.length === 0) return "";
    const root: Nodes = nodes.every(isPhrasing)
      ? { type: "paragraph", children: nodes as PhrasingContent[] }
      : { type: "root", children: blocksOf(nodes) };
    return toMarkdown(root, layout).replace(/\n$/, "");
  }

  const formatBlock = (block: SemanticContentBlock): ContentBlock =>
    options.blocks?.[block.type]?.(block) ?? dialectBlock(block);

  function dialectBlock(block: SemanticContentBlock): ContentBlock {
    if (block.semanticNode) {
      return { type: "text", text: render(formatNode(block.semanticNode)) } satisfies TextBlock;
    }
    switch (block.type) {
      case "text":
      case "reasoning":
        return block;
      case "code": {
        const c = block as CodeBlock;
        return {
          type: "text",
          text: render([{ type: "code", lang: c.language ?? null, value: c.text }]),
        } satisfies TextBlock;
      }
      case "json": {
        const j = block as JsonBlock;
        const value = j.text ?? (j.data !== undefined ? JSON.stringify(j.data) : "");
        return {
          type: "text",
          text: render([{ type: "code", lang: "json", value }]),
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
        return {
          type: "text",
          text: renderCustomBlock(block, markdownEscapers),
        } satisfies TextBlock;
      default:
        return block;
    }
  }

  // ── Tree level: frames around already-rendered bytes ──────────────────────

  const frameMessage = (entry: MessageEntry, body: string): string => `**${entry.role}:** ${body}`;

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
        return render([{ type: "image", url: src, alt: block.altText ?? "" }]);
      }
      case "document":
      case "audio":
      case "video": {
        const src = block.source.type === "url" ? block.source.url : "[binary]";
        return render([{ type: "link", url: src, children: [text(block.type)] }]);
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

  return createFormatter({
    id: options.id ?? "formatter.markdown",
    format: "markdown",
    ...(options.version !== undefined ? { version: options.version } : {}),
    render: (blocks) => blocks.map(formatBlock),
    frameMessage,
    blocksToText,
  });
}

export const markdownFormatter = createMarkdownFormatter();
