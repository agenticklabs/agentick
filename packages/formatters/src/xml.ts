/**
 * XML formatter — semantic content as XML elements (ADR 111).
 *
 * The formatter decides which element a block or node becomes; `fast-xml-parser`
 * writes the bytes. Escaping is the serializer's, never a call site's, so no
 * content can form or close an element. Composition across already-rendered
 * strings — a message around its body, a tool result around its content — is a
 * frame: a tag we declared around bytes the serializer already produced.
 */

import { XMLBuilder } from "fast-xml-parser";

import type {
  CodeBlock,
  ContentBlock,
  EventBlock,
  JsonBlock,
  MessageEntry,
  SemanticContentBlock,
  SemanticNode,
  TextBlock,
} from "@agentick/spec";

import { createFormatter, type DefinedFormatter } from "./create-formatter.js";
import { eventParts } from "./event-block.js";

/** `fast-xml-parser`'s ordered shape: an element is `{ [tag]: children, ":@"?: attrs }`, text is `{ "#text": s }`. */
type XmlNode = Record<string, unknown>;

const text = (s: string): XmlNode => ({ "#text": s });

function element(tag: string, children: readonly XmlNode[] = [], attrs?: unknown): XmlNode {
  const pairs =
    attrs !== null && typeof attrs === "object"
      ? Object.entries(attrs as Record<string, unknown>)
      : [];
  return {
    [tag]: children,
    ...(pairs.length > 0
      ? { ":@": Object.fromEntries(pairs.map(([k, v]) => [`@_${k}`, String(v)])) }
      : {}),
  };
}

/** The XML minimum: what must be escaped for the output to parse, and nothing more. */
const escapeText = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

type BuilderOptions = NonNullable<ConstructorParameters<typeof XMLBuilder>[0]>;

export interface XmlFormatterOptions {
  /** Registry id; default `formatter.xml`. Two configurations are two ids. */
  readonly id?: string;
  readonly version?: string;
  /**
   * `fast-xml-parser` builder options, passed through (`format`, `indentBy`,
   * `suppressEmptyNode`, …). Order, attributes and the two escaping
   * processors are the dialect's and stay.
   */
  readonly builder?: Partial<BuilderOptions>;
  /** Per block type, the rendering; return `undefined` to fall back to the dialect's. */
  readonly blocks?: Partial<
    Record<SemanticContentBlock["type"], (block: SemanticContentBlock) => ContentBlock | undefined>
  >;
}

interface Writers {
  /** Inline: pretty-printing lays elements out one per line, which would put whitespace inside mixed content. */
  readonly serialize: (nodes: readonly XmlNode[]) => string;
  /** One element per line, indented — for a tree with no text between its elements. */
  readonly serializePretty: (nodes: readonly XmlNode[]) => string;
}

function writers(builder: Partial<BuilderOptions> = {}): Writers {
  const make = (format: boolean): XMLBuilder =>
    new XMLBuilder({
      indentBy: "  ",
      suppressEmptyNode: true,
      ...builder,
      ignoreAttributes: false,
      preserveOrder: true,
      format: builder.format === undefined ? format : builder.format && format,
      processEntities: false,
      tagValueProcessor: (_name, value) => escapeText(String(value)),
      attributeValueProcessor: (_name, value) => escapeAttr(String(value)),
    });
  const inline = make(false);
  const pretty = make(true);
  return {
    serialize: (nodes) => inline.build(nodes) as string,
    serializePretty: (nodes) => (pretty.build(nodes) as string).replace(/^\n/, ""),
  };
}

const isText = (node: SemanticNode): boolean => node.semantic === undefined;
const isBlank = (node: SemanticNode): boolean => isText(node) && (node.text ?? "").trim() === "";

function formatNode(node: SemanticNode): XmlNode[] {
  if (node.text !== undefined && node.semantic === undefined) return [text(node.text)];
  const children = node.children ?? [];
  const kids = children.flatMap(formatNode);
  const wrap = (tag: string, attrs?: unknown): XmlNode[] => [element(tag, kids, attrs)];

  switch (node.semantic) {
    case "strong":
    case "em":
    case "mark":
    case "small":
    case "code":
    case "blockquote":
      return wrap(node.semantic);
    case "table":
      return [
        element(
          "table",
          children.map((row) =>
            element(
              "tr",
              (row.children ?? []).map((cell) => element("td", formatNode(cell))),
            ),
          ),
        ),
      ];
    case "underline":
      return wrap("u");
    case "strikethrough":
      return wrap("s");
    case "subscript":
      return wrap("sub");
    case "superscript":
      return wrap("sup");
    case "paragraph":
      return wrap("p");
    case "quote":
      return wrap("q");
    case "citation":
      return wrap("cite");
    case "keyboard":
      return wrap("kbd");
    case "variable":
      return wrap("var");
    case "preformatted":
      return wrap("pre");
    case "block":
      return wrap("div");
    case "inline":
    case "inline-block":
      return wrap("span");
    case "heading": {
      const level = Math.min(Math.max(Number(node.props?.level ?? 1), 1), 6);
      return wrap(`h${level}`);
    }
    case "list": {
      const tag = node.props?.ordered === true ? "ol" : "ul";
      return [
        element(
          tag,
          children.map((item) => element("li", formatNode(item))),
        ),
      ];
    }
    case "list-item":
      return kids;
    case "line-break":
      return [element("br")];
    case "horizontal-rule":
      return [element("hr")];
    case "link":
      return wrap("a", { href: String(node.props?.href ?? "") });
    case "image":
      return [
        element("img", [], {
          src: String(node.props?.src ?? ""),
          alt: String(node.props?.alt ?? ""),
        }),
      ];
    case "audio":
    case "video":
      return [element(node.semantic, [], { src: String(node.props?.src ?? "") })];
    case "custom": {
      const tag = String(node.props?.tag ?? "custom");
      if (node.props?.selfClosing === true) return [element(tag, [], node.props?.attrs)];
      // Whitespace-only text between element children is JSX layout, not content.
      const content = children.some((c) => !isText(c))
        ? children.filter((c) => !isBlank(c))
        : children;
      return [element(tag, content.flatMap(formatNode), node.props?.attrs)];
    }
    default:
      return kids;
  }
}

/** A custom element whose children are all elements: laid out one per line, as `<message-metadata>` reads. */
function isElementTree(node: SemanticNode): boolean {
  if (node.semantic !== "custom" || node.props?.selfClosing === true) return false;
  const children = (node.children ?? []).filter((c) => !isBlank(c));
  return children.length > 0 && children.every((c) => !isText(c));
}

function eventNodes(block: EventBlock): XmlNode[] {
  const { attrs, fields } = eventParts(block);
  const body =
    block.text !== undefined
      ? [text(block.text)]
      : fields.map(([key, value]) => element(key, [text(value)]));
  return [element(block.type, body, Object.fromEntries(attrs))];
}

export function createXmlFormatter(options: XmlFormatterOptions = {}): DefinedFormatter {
  const { serialize, serializePretty } = writers(options.builder);

  const eventText = (block: EventBlock): string =>
    block.text !== undefined ? serialize(eventNodes(block)) : serializePretty(eventNodes(block));

  const customText = (tag: string, attrs: unknown, content: string, selfClosing: boolean): string =>
    serialize([element(tag, selfClosing ? [] : [text(content)], attrs)]);

  const formatBlock = (block: SemanticContentBlock): ContentBlock =>
    options.blocks?.[block.type]?.(block) ?? dialectBlock(block);

  function dialectBlock(block: SemanticContentBlock): ContentBlock {
    if (block.semanticNode) {
      const nodes = formatNode(block.semanticNode);
      const rendered = isElementTree(block.semanticNode)
        ? serializePretty(nodes)
        : serialize(nodes);
      return { type: "text", text: rendered } satisfies TextBlock;
    }
    switch (block.type) {
      case "text":
        return { type: "text", text: escapeText(block.text) } satisfies TextBlock;
      case "reasoning":
        return {
          type: "text",
          text: serialize([element("reasoning", [text(block.text)])]),
        } satisfies TextBlock;
      case "code": {
        const c = block as CodeBlock;
        return {
          type: "text",
          text: serialize([
            element("code", [text(c.text)], c.language ? { language: c.language } : undefined),
          ]),
        } satisfies TextBlock;
      }
      case "json": {
        const j = block as JsonBlock;
        const body = j.text ?? (j.data !== undefined ? JSON.stringify(j.data) : "");
        return {
          type: "text",
          text: serialize([element("json", [text(body)])]),
        } satisfies TextBlock;
      }
      case "xml":
      case "html":
        return { type: "text", text: block.text ?? "" } satisfies TextBlock;
      case "csv":
        return {
          type: "text",
          text: serialize([element("csv", [text(block.text ?? "")])]),
        } satisfies TextBlock;
      case "user_action":
      case "system_event":
      case "state_change":
        return { type: "text", text: eventText(block) } satisfies TextBlock;
      case "custom":
        return {
          type: "text",
          text: customText(block.tag, block.attrs, block.content, block.selfClosing === true),
        } satisfies TextBlock;
      default:
        return block;
    }
  }

  // ── Tree level: frames around already-rendered bytes ──────────────────────

  const frameMessage = (entry: MessageEntry, body: string): string =>
    `<message role="${escapeAttr(entry.role)}">\n${body}\n</message>`;

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
        return serialize([
          element("image", [], { src, ...(block.altText ? { alt: block.altText } : {}) }),
        ]);
      }
      case "document":
      case "audio":
      case "video": {
        const src = block.source.type === "url" ? block.source.url : "[binary]";
        return serialize([element(block.type, [], { src })]);
      }
      case "tool_use":
        return serialize([
          element("tool_use", [text(JSON.stringify(block.input))], {
            id: block.toolUseId,
            name: block.name,
          }),
        ]);
      case "tool_result": {
        // A frame around bytes already written; the call it answers rides as attributes.
        const attrs = [`id="${escapeAttr(block.toolUseId)}"`]
          .concat(block.name !== undefined ? [`name="${escapeAttr(block.name)}"`] : [])
          .concat(block.isError === true ? ['error="true"'] : [])
          .join(" ");
        return `<tool_result ${attrs}>${blocksToText(block.content)}</tool_result>`;
      }
      case "user_action":
      case "system_event":
      case "state_change":
        return eventText(block);
      case "custom":
        return customText(block.tag, block.attrs, block.content, block.selfClosing === true);
      default:
        return "";
    }
  }

  return createFormatter({
    id: options.id ?? "formatter.xml",
    format: "xml",
    ...(options.version !== undefined ? { version: options.version } : {}),
    render: (blocks) => blocks.map(formatBlock),
    frameMessage,
    blocksToText,
  });
}

export const xmlFormatter = createXmlFormatter();
