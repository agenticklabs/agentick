/**
 * Collector
 *
 * Traverses the AgentickNode tree and collects into CompiledStructure.
 */

import type { AgentickNode, AgentickContainer, AgentickTextNode } from "../reconciler/types";
import { isTextNode } from "../reconciler/types";
import type {
  CompiledStructure,
  CompiledSection,
  CompiledTimelineEntry,
  CompiledEphemeral,
} from "./types";
import type { ExecutableTool, ToolMetadata } from "../tool/tool";
import { createEmptyCompiledStructure } from "./types";
import type { SemanticContentBlock, SemanticNode, Renderer } from "../renderers/types";
import type { TokenEstimator } from "../com/types";
import { extractText as extractBlocksText } from "@agentick/shared";
import { Logger } from "@agentick/kernel";

const log = Logger.for("Collector");

// ============================================================
// Component Type Constants
// These are matched by string name since we're using host config
// ============================================================

const SECTION = "Section";
const SECTION_LOWER = "section";
const ENTRY = "Entry";
const ENTRY_LOWER = "entry";
const MESSAGE = "Message";
const MESSAGE_LOWER = "message";
const TOOL = "Tool";
const TOOL_LOWER = "tool";
const EPHEMERAL = "Ephemeral";
const EPHEMERAL_LOWER = "ephemeral";
const TEXT = "Text";
const TEXT_LOWER = "text";
const CODE = "Code";
const CODE_LOWER = "code";
const IMAGE = "Image";
const IMAGE_LOWER = "image";
const JSON_BLOCK = "Json";
const JSON_LOWER = "json";
const DOCUMENT = "Document";
const DOCUMENT_LOWER = "document";
const AUDIO = "Audio";
const AUDIO_LOWER = "audio";
const VIDEO = "Video";
const VIDEO_LOWER = "video";
const H1 = "H1";
const H2 = "H2";
const H3 = "H3";
const HEADER = "Header";
const HEADER_LOWER = "header";
const PARAGRAPH = "Paragraph";
const PARAGRAPH_LOWER = "paragraph";
const LIST = "List";
const LIST_LOWER = "list";
const LIST_ITEM = "ListItem";
const LIST_ITEM_LOWER = "listitem";
const TABLE = "Table";
const TABLE_LOWER = "table";
const ROW = "Row";
const ROW_LOWER = "row";
const COLUMN = "Column";
const COLUMN_LOWER = "column";
const COLLAPSED = "Collapsed";
const COLLAPSED_LOWER = "collapsed";
const USER_ACTION = "UserAction";
const USER_ACTION_LOWER = "user_action";
const SYSTEM_EVENT = "SystemEvent";
const SYSTEM_EVENT_LOWER = "system_event";
const TOOL_USE = "ToolUse";
const TOOL_USE_LOWER = "tooluse";
const STATE_CHANGE = "StateChange";
const STATE_CHANGE_LOWER = "state_change";

// Inline semantic element mapping: lowercase HTML intrinsics → SemanticNode types
const INLINE_SEMANTIC_MAP: Record<string, string> = {
  strong: "strong",
  b: "strong",
  em: "em",
  i: "em",
  mark: "mark",
  u: "underline",
  s: "strikethrough",
  del: "strikethrough",
  sub: "subscript",
  sup: "superscript",
  small: "small",
  inlineCode: "code",
  blockquote: "blockquote",
  p: "paragraph",
  a: "link",
  q: "quote",
  cite: "citation",
  kbd: "keyboard",
  var: "variable",
};

/**
 * Collect compiled structure from a container.
 *
 * @param container - The root container to collect from
 * @param estimator - Optional token estimator. When provided, annotates all compiled entries with token estimates.
 */
export function collect(
  container: AgentickContainer,
  estimator?: TokenEstimator,
): CompiledStructure {
  const result = createEmptyCompiledStructure();

  if (!container.children) {
    log.debug({ hasChildren: false }, "Collector: Container has no children");
    return result;
  }

  for (const child of container.children) {
    collectNode(child, result);
  }

  // Annotate with token estimates if estimator provided
  if (estimator) {
    annotateTokens(result, estimator);
  }

  log.debug(
    {
      sections: result.sections.size,
      timelineEntries: result.timelineEntries.length,
      tools: result.tools.length,
      systemEntries: result.systemEntries.length,
      ephemeral: result.ephemeral.length,
      totalTokens: result.totalTokens,
    },
    "Collector: Collection complete",
  );

  return result;
}

/**
 * Collect from a single node and its descendants.
 */
function collectNode(node: AgentickNode | AgentickTextNode, result: CompiledStructure): void {
  // Skip text nodes - they don't have structural meaning at this level
  if (isTextNode(node)) {
    return;
  }

  const typeName = getTypeName(node.type);

  switch (typeName) {
    case SECTION:
    case SECTION_LOWER:
      collectSection(node, result);
      break;

    case ENTRY:
    case ENTRY_LOWER:
    case MESSAGE:
    case MESSAGE_LOWER:
      collectTimelineEntry(node, result);
      break;

    case TOOL:
    case TOOL_LOWER:
      collectTool(node, result);
      break;

    case EPHEMERAL:
    case EPHEMERAL_LOWER:
      collectEphemeral(node, result);
      break;

    default:
      // Recurse into children for container/fragment nodes
      if (node.children) {
        for (const child of node.children) {
          collectNode(child, result);
        }
      }
  }
}

/**
 * Collect a Section node.
 */
function collectSection(node: AgentickNode, result: CompiledStructure): void {
  const id = node.props.id as string;
  if (!id) {
    console.warn("Section missing id prop");
    return;
  }

  const section: CompiledSection = {
    id,
    title: node.props.title as string | undefined,
    content: collectContent(node.children, node.renderer),
    renderer: node.renderer,
    visibility: node.props.visibility as "model" | "observer" | "log" | undefined,
    audience: node.props.audience as "user" | "model" | "all" | undefined,
    tags: node.props.tags as string[] | undefined,
    metadata: node.props.metadata as Record<string, unknown> | undefined,
  };

  // Merge if section with same id exists
  const existing = result.sections.get(id);
  if (existing) {
    existing.content.push(...section.content);
  } else {
    result.sections.set(id, section);
  }
}

/**
 * Collect a timeline Entry/Message node.
 *
 * Supports two formats:
 * 1. Classic format: <Entry role="user">content children</Entry>
 * 2. Intrinsic format: <entry kind="message" message={{ role, content }} />
 *
 * In both cases, if message.content is empty but node has children,
 * we collect content from children.
 *
 * System role entries are routed to `result.systemEntries` (rebuilt each tick),
 * while all other roles go to `result.timelineEntries`.
 */
function collectTimelineEntry(node: AgentickNode, result: CompiledStructure): void {
  // Check for intrinsic format (lowercase "entry" with message prop)
  if (node.props.message && typeof node.props.message === "object") {
    const msg = node.props.message as {
      role?: string;
      content?: unknown[];
      id?: string;
      metadata?: Record<string, unknown>;
      createdAt?: Date;
    };

    // Determine content: prefer message.content, fallback to collecting from children
    let content: SemanticContentBlock[];
    if (Array.isArray(msg.content) && msg.content.length > 0) {
      content = msg.content as SemanticContentBlock[];
    } else if (node.children && node.children.length > 0) {
      // Collect content from children (e.g., <User>Hello</User>)
      content = collectContent(node.children, node.renderer);
    } else {
      content = [];
    }

    const role = (msg.role as "user" | "assistant" | "system" | "tool") ?? "user";
    const entry: CompiledTimelineEntry = {
      id: msg.id ?? (node.props.id as string | undefined),
      role,
      content,
      renderer: node.renderer,
      metadata: msg.metadata ?? (node.props.metadata as Record<string, unknown> | undefined),
      createdAt: msg.createdAt ?? (node.props.createdAt as Date | undefined),
    };

    // Route system entries separately (rebuilt each tick)
    if (role === "system") {
      result.systemEntries.push(entry);
    } else {
      result.timelineEntries.push(entry);
    }
    return;
  }

  // Classic format: role prop with children content
  const role = (node.props.role as "user" | "assistant" | "system" | "tool") ?? "user";
  const entry: CompiledTimelineEntry = {
    id: node.props.id as string | undefined,
    role,
    content: collectContent(node.children, node.renderer),
    renderer: node.renderer,
    metadata: node.props.metadata as Record<string, unknown> | undefined,
    createdAt: node.props.createdAt as Date | undefined,
  };

  // Route system entries separately (rebuilt each tick)
  if (role === "system") {
    result.systemEntries.push(entry);
  } else {
    result.timelineEntries.push(entry);
  }
}

/**
 * Collect a Tool node.
 *
 * Preserves full ToolMetadata when available (from createTool-based components).
 * Falls back to individual props for raw <tool> elements.
 */
function collectTool(node: AgentickNode, result: CompiledStructure): void {
  // Prefer full metadata (from createTool-based components), fallback to individual props
  const metadata: ToolMetadata = (node.props.metadata as ToolMetadata) ?? {
    name: node.props.name as string,
    description: (node.props.description as string) ?? "",
    input: node.props.schema,
  };

  // Both ToolComponent (createTool) and <Tool> (primitives.ts) create <tool>
  // elements. Both wrap their handler as a Procedure before passing it here.
  result.tools.push({
    metadata,
    run: node.props.handler,
    preview: node.props.preview,
  } as ExecutableTool);
}

/**
 * Collect an Ephemeral node.
 */
function collectEphemeral(node: AgentickNode, result: CompiledStructure): void {
  const ephemeral: CompiledEphemeral = {
    content: collectContent(node.children, node.renderer),
    position: (node.props.position as CompiledEphemeral["position"]) ?? "end",
    order: (node.props.order as number) ?? 0,
    renderer: node.renderer,
    metadata: node.props.metadata as Record<string, unknown> | undefined,
  };

  result.ephemeral.push(ephemeral);
}

/**
 * Collect content blocks from child nodes.
 */
function collectContent(
  children: (AgentickNode | AgentickTextNode)[] | undefined,
  parentRenderer: Renderer | null,
): SemanticContentBlock[] {
  const blocks: SemanticContentBlock[] = [];

  if (!children) {
    return blocks;
  }

  for (const child of children) {
    // Handle text nodes - convert to text block
    if (isTextNode(child)) {
      if (child.text) {
        blocks.push({
          type: "text",
          text: child.text,
        });
      }
      continue;
    }

    const typeName = getTypeName(child.type);
    const renderer = child.renderer ?? parentRenderer;

    switch (typeName) {
      case TEXT:
      case TEXT_LOWER: {
        const tree = hasInlineSemantics(child.children) ? buildSemanticTree(child.children) : null;
        if (tree && tree.length > 0) {
          blocks.push({
            type: "text",
            text: extractText(child),
            semanticNode: { children: tree },
          });
        } else {
          blocks.push({
            type: "text",
            text: extractText(child),
          });
        }
        break;
      }

      case CODE:
      case CODE_LOWER: {
        const codeText =
          ((child.props.code ?? child.props.text ?? child.props.children) as string) ||
          extractText(child);
        blocks.push({
          type: "code",
          text: codeText,
          language: child.props.language,
        } as SemanticContentBlock);
        break;
      }

      case IMAGE:
      case IMAGE_LOWER:
        blocks.push({
          type: "image",
          source: child.props.source ?? { type: "url", url: child.props.src as string },
          altText: (child.props.altText ?? child.props.alt) as string | undefined,
        } as SemanticContentBlock);
        break;

      case JSON_BLOCK:
      case JSON_LOWER: {
        const jsonData = child.props.data ?? child.props.children;
        const jsonText = (child.props.text as string) || JSON.stringify(jsonData);
        blocks.push({
          type: "json",
          text: jsonText,
          data: jsonData,
        } as SemanticContentBlock);
        break;
      }

      case DOCUMENT:
      case DOCUMENT_LOWER:
        blocks.push({
          type: "document",
          source: child.props.source,
          title: child.props.title,
        } as SemanticContentBlock);
        break;

      case AUDIO:
      case AUDIO_LOWER:
        blocks.push({
          type: "audio",
          source: child.props.source,
          transcript: child.props.transcript,
        } as SemanticContentBlock);
        break;

      case VIDEO:
      case VIDEO_LOWER:
        blocks.push({
          type: "video",
          source: child.props.source,
          transcript: child.props.transcript,
        } as SemanticContentBlock);
        break;

      case TOOL_USE:
      case TOOL_USE_LOWER:
        blocks.push({
          type: "tool_use",
          toolUseId: child.props.toolUseId,
          name: child.props.name,
          input: child.props.input ?? {},
        } as SemanticContentBlock);
        break;

      // Semantic: Headings
      case H1:
      case "h1":
      case H2:
      case "h2":
      case H3:
      case "h3":
      case HEADER:
      case HEADER_LOWER: {
        const level = (child.props.level as number) ?? getHeadingLevel(typeName);
        blocks.push({
          type: "text",
          text: extractText(child),
          semantic: { type: "heading", level },
        });
        break;
      }

      // Semantic: Paragraph
      case PARAGRAPH:
      case PARAGRAPH_LOWER:
        blocks.push({
          type: "text",
          text: extractText(child),
          semantic: { type: "paragraph" },
        });
        break;

      // Semantic: List
      case LIST:
      case LIST_LOWER:
        blocks.push({
          type: "text",
          text: "",
          semantic: {
            type: "list",
            structure: extractListStructure(child),
          },
        });
        break;

      // Semantic: Table
      case TABLE:
      case TABLE_LOWER:
        blocks.push({
          type: "text",
          text: "",
          semantic: {
            type: "table",
            structure: extractTableStructure(child),
          },
        });
        break;

      // Semantic: Collapsed
      case COLLAPSED:
      case COLLAPSED_LOWER: {
        // Collect children as semantic blocks for renderer-aware formatting.
        // The renderer formats these through this.format() before wrapping
        // in <collapsed> tags, preserving inline formatting and block structure.
        const childBlocks =
          child.children && child.children.length > 0
            ? collectContent(child.children, renderer)
            : [];

        blocks.push({
          type: "text",
          text: extractText(child), // plain text fallback
          semantic: {
            type: "custom",
            rendererTag: "collapsed",
            rendererAttrs: {
              name: child.props.name,
              group: child.props.group,
              childBlocks: childBlocks.length > 0 ? childBlocks : undefined,
            },
          },
        });
        break;
      }

      // Event block components
      case USER_ACTION:
      case USER_ACTION_LOWER:
        blocks.push({
          type: "user_action",
          text: extractText(child),
          action: child.props.action,
          actor: child.props.actor,
          target: child.props.target,
        } as SemanticContentBlock);
        break;

      case SYSTEM_EVENT:
      case SYSTEM_EVENT_LOWER:
        blocks.push({
          type: "system_event",
          text: extractText(child),
          event: child.props.event,
          source: child.props.source,
        } as SemanticContentBlock);
        break;

      case STATE_CHANGE:
      case STATE_CHANGE_LOWER:
        blocks.push({
          type: "state_change",
          text: extractText(child),
          entity: child.props.entity,
          field: child.props.field,
          from: child.props.from,
          to: child.props.to,
        } as SemanticContentBlock);
        break;

      // Skip structural children of semantic containers
      case LIST_ITEM:
      case LIST_ITEM_LOWER:
      case ROW:
      case ROW_LOWER:
      case COLUMN:
      case COLUMN_LOWER:
        break;

      default: {
        // Inline semantic elements (strong, em, code, a, etc.)
        const inlineSemantic = INLINE_SEMANTIC_MAP[typeName];
        if (inlineSemantic) {
          const tree = buildSemanticTree([child]);
          if (tree.length > 0) {
            blocks.push({
              type: "text",
              text: extractText(child),
              semanticNode: tree[0],
            });
          }
          break;
        }

        // img, br, hr — void elements
        if (typeName === "img") {
          blocks.push({
            type: "text",
            text: "",
            semanticNode: {
              semantic: "image" as any,
              props: { src: child.props.src, alt: child.props.alt },
            },
          });
          break;
        }
        if (typeName === "br") {
          blocks.push({ type: "text", text: "\n", semantic: { type: "line-break" } });
          break;
        }
        if (typeName === "hr") {
          blocks.push({ type: "text", text: "", semantic: { type: "horizontal-rule" } });
          break;
        }

        // Recurse for nested containers
        if (child.children && child.children.length > 0) {
          blocks.push(...collectContent(child.children, renderer));
        }
      }
    }
  }

  return blocks;
}

/**
 * Extract text content from a node.
 *
 * Priority:
 * 1. `text` prop — fast path for `<Text text="hello" />`
 * 2. `children` prop — for cases where children were passed as props
 * 3. `node.children` — reconciled children (the normal JSX case: `<Text>hello</Text>`)
 *
 * For case 3, we recurse through children, collect text blocks, and flatten
 * via the shared `extractText` (which handles ContentBlock[]).
 */
function extractText(node: AgentickNode): string {
  const text = node.props.text ?? node.props.children;

  if (typeof text === "string") {
    return text;
  }

  if (typeof text === "number") {
    return String(text);
  }

  if (Array.isArray(text)) {
    return text
      .map((c) => (typeof c === "string" || typeof c === "number" ? String(c) : ""))
      .join("");
  }

  // Fallback: collect from reconciled children nodes
  if (node.children && node.children.length > 0) {
    const childBlocks = collectContent(node.children, node.renderer);
    return extractBlocksText(childBlocks, "");
  }

  return "";
}

/**
 * Build a SemanticNode tree from reconciled children.
 *
 * Converts inline HTML intrinsics (<strong>, <em>, <code>, <a>, etc.)
 * into a tree of SemanticNode objects for renderer-aware formatting.
 *
 * For block-level elements (lists, headings, tables), falls back to
 * extractText since SemanticNode doesn't model block structures.
 * These are handled via SemanticContentBlock.semantic in collectContent.
 */
function buildSemanticTree(
  children: (AgentickNode | AgentickTextNode)[] | undefined,
): SemanticNode[] {
  if (!children) return [];
  const nodes: SemanticNode[] = [];

  for (const child of children) {
    if (isTextNode(child)) {
      if (child.text) {
        nodes.push({ text: child.text });
      }
      continue;
    }

    const typeName = getTypeName(child.type);
    const inlineSemantic = INLINE_SEMANTIC_MAP[typeName];

    if (inlineSemantic) {
      const node: SemanticNode = {
        semantic: inlineSemantic as any,
        children: buildSemanticTree(child.children),
      };
      if (inlineSemantic === "link" && child.props.href) {
        node.props = { href: child.props.href };
      }
      nodes.push(node);
      continue;
    }

    // img — void element with props, no children
    if (typeName === "img") {
      nodes.push({
        semantic: "image" as any,
        props: { src: child.props.src, alt: child.props.alt },
      });
      continue;
    }

    // br/hr — void elements
    if (typeName === "br") {
      nodes.push({ text: "\n" });
      continue;
    }
    if (typeName === "hr") {
      nodes.push({ text: "\n---\n" });
      continue;
    }

    // For all other elements, recurse into children to extract text
    const text = extractText(child);
    if (text) {
      nodes.push({ text });
    }
  }

  return nodes;
}

/**
 * Check if children contain any inline semantic elements that
 * would benefit from a SemanticNode tree.
 */
function hasInlineSemantics(children: (AgentickNode | AgentickTextNode)[] | undefined): boolean {
  if (!children) return false;
  for (const child of children) {
    if (isTextNode(child)) continue;
    const typeName = getTypeName(child.type);
    if (
      INLINE_SEMANTIC_MAP[typeName] ||
      typeName === "img" ||
      typeName === "br" ||
      typeName === "hr"
    ) {
      return true;
    }
    // Check nested children (e.g., <Text> wrapping a <strong>)
    if (child.children && hasInlineSemantics(child.children)) {
      return true;
    }
  }
  return false;
}

/**
 * Get heading level from type name.
 */
function getHeadingLevel(typeName: string): number {
  switch (typeName) {
    case "H1":
    case "h1":
      return 1;
    case "H2":
    case "h2":
      return 2;
    case "H3":
    case "h3":
      return 3;
    default:
      return 1; // Header defaults to h1
  }
}

/**
 * Extract list structure from a List node's children.
 */
function extractListStructure(node: AgentickNode): {
  ordered: boolean;
  task?: boolean;
  items: (string | { text: string; checked?: boolean })[];
} {
  const ordered = node.props.ordered === true;
  const task = node.props.task === true;
  const items: (string | { text: string; checked?: boolean })[] = [];

  if (node.children) {
    for (const child of node.children) {
      if (isTextNode(child)) continue;
      const name = getTypeName(child.type);
      if (name === LIST_ITEM || name === LIST_ITEM_LOWER) {
        const text = extractText(child);
        if (task && child.props.checked !== undefined) {
          items.push({ text, checked: child.props.checked as boolean });
        } else {
          items.push(text);
        }
      }
    }
  }

  return { ordered, task: task || undefined, items };
}

/**
 * Extract table structure from a Table node's children.
 */
function extractTableStructure(node: AgentickNode): {
  headers: string[];
  rows: string[][];
} {
  // Fast path: headers/rows props
  if (node.props.headers || node.props.rows) {
    return {
      headers: (node.props.headers as string[]) ?? [],
      rows: (node.props.rows as string[][]) ?? [],
    };
  }

  const headers: string[] = [];
  const rows: string[][] = [];

  if (node.children) {
    for (const child of node.children) {
      if (isTextNode(child)) continue;
      const name = getTypeName(child.type);
      if (name === ROW || name === ROW_LOWER) {
        const cells = extractRowCells(child);
        if (child.props.header) {
          headers.push(...cells);
        } else {
          rows.push(cells);
        }
      }
    }
  }

  return { headers, rows };
}

/**
 * Extract cell text from a Row node's Column children.
 */
function extractRowCells(node: AgentickNode): string[] {
  const cells: string[] = [];
  if (node.children) {
    for (const child of node.children) {
      if (isTextNode(child)) continue;
      const name = getTypeName(child.type);
      if (name === COLUMN || name === COLUMN_LOWER) {
        cells.push(extractText(child));
      }
    }
  }
  return cells;
}

/**
 * Get the string name of a node type.
 */
function getTypeName(type: unknown): string {
  if (typeof type === "string") {
    return type;
  }

  if (typeof type === "function") {
    return type.name || "Anonymous";
  }

  if (typeof type === "symbol") {
    return type.description || "Symbol";
  }

  return "Unknown";
}

// ============================================================================
// Token Annotation
// ============================================================================

const MESSAGE_OVERHEAD = 4; // Per-message overhead tokens
const IMAGE_OVERHEAD = 85; // Fixed token overhead for images

/**
 * Estimate tokens for an array of semantic content blocks.
 */
function estimateContentTokens(blocks: SemanticContentBlock[], estimator: TokenEstimator): number {
  let total = 0;
  for (const block of blocks) {
    switch (block.type) {
      case "text":
        total += estimator((block as any).text || "");
        break;
      case "code":
        total += estimator((block as any).text || (block as any).code || "");
        break;
      case "json":
        total += estimator((block as any).text || JSON.stringify((block as any).data));
        break;
      case "tool_use":
        total += estimator(
          ((block as any).name || "") + JSON.stringify((block as any).input || {}),
        );
        break;
      case "tool_result": {
        const nested = (block as any).content;
        if (Array.isArray(nested)) {
          total += estimateContentTokens(nested, estimator);
        } else if (typeof nested === "string") {
          total += estimator(nested);
        }
        break;
      }
      case "image":
        total += IMAGE_OVERHEAD;
        break;
      default:
        // Unknown block type — estimate from JSON representation
        total += estimator(JSON.stringify(block));
        break;
    }
  }
  return total;
}

/**
 * Annotate all entries in a compiled structure with token estimates.
 * Sets `.tokens` on each section and timeline entry, and `.totalTokens` on the structure.
 */
function annotateTokens(structure: CompiledStructure, estimator: TokenEstimator): void {
  let total = 0;

  // Sections
  for (const section of structure.sections.values()) {
    const tokens = estimateContentTokens(section.content, estimator) + MESSAGE_OVERHEAD;
    section.tokens = tokens;
    total += tokens;
  }

  // Timeline entries
  for (const entry of structure.timelineEntries) {
    const tokens = estimateContentTokens(entry.content, estimator) + MESSAGE_OVERHEAD;
    entry.tokens = tokens;
    total += tokens;
  }

  // System entries
  for (const entry of structure.systemEntries) {
    const tokens = estimateContentTokens(entry.content, estimator) + MESSAGE_OVERHEAD;
    entry.tokens = tokens;
    total += tokens;
  }

  // Ephemeral (count but don't stamp — no tokens field on CompiledEphemeral)
  for (const eph of structure.ephemeral) {
    total += estimateContentTokens(eph.content, estimator) + MESSAGE_OVERHEAD;
  }

  structure.totalTokens = total;
}
