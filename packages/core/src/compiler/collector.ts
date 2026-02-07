/**
 * V2 Collector
 *
 * Traverses the TentickleNode tree and collects into CompiledStructure.
 */

import type { TentickleNode, TentickleContainer, TentickleTextNode } from "../reconciler/types";
import { isTextNode } from "../reconciler/types";
import type {
  CompiledStructure,
  CompiledSection,
  CompiledTimelineEntry,
  CompiledTool,
  CompiledEphemeral,
} from "./types";
import { createEmptyCompiledStructure } from "./types";
import type { SemanticContentBlock, Renderer } from "../renderers/types";
import type { TokenEstimator } from "../com/types";
import { Logger } from "@tentickle/kernel";

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

/**
 * Collect compiled structure from a container.
 *
 * @param container - The root container to collect from
 * @param estimator - Optional token estimator. When provided, annotates all compiled entries with token estimates.
 */
export function collect(
  container: TentickleContainer,
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
function collectNode(node: TentickleNode | TentickleTextNode, result: CompiledStructure): void {
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
function collectSection(node: TentickleNode, result: CompiledStructure): void {
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
function collectTimelineEntry(node: TentickleNode, result: CompiledStructure): void {
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
 */
function collectTool(node: TentickleNode, result: CompiledStructure): void {
  const tool: CompiledTool = {
    name: node.props.name as string,
    description: node.props.description as string | undefined,
    schema: node.props.schema,
    handler: node.props.handler as (...args: unknown[]) => unknown,
  };

  result.tools.push(tool);
}

/**
 * Collect an Ephemeral node.
 */
function collectEphemeral(node: TentickleNode, result: CompiledStructure): void {
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
  children: (TentickleNode | TentickleTextNode)[] | undefined,
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
      case TEXT_LOWER:
        blocks.push({
          type: "text",
          text: extractText(child),
        });
        break;

      case CODE:
      case CODE_LOWER:
        blocks.push({
          type: "code",
          text: (child.props.code ?? child.props.children) as string,
          language: child.props.language,
        } as SemanticContentBlock);
        break;

      case IMAGE:
      case IMAGE_LOWER:
        blocks.push({
          type: "image",
          source: child.props.source ?? { type: "url", url: child.props.src as string },
          altText: child.props.alt as string | undefined,
        } as SemanticContentBlock);
        break;

      case JSON_BLOCK:
      case JSON_LOWER:
        blocks.push({
          type: "json",
          text: JSON.stringify(child.props.data ?? child.props.children),
          data: child.props.data ?? child.props.children,
        } as SemanticContentBlock);
        break;

      default:
        // Recurse for nested containers
        if (child.children && child.children.length > 0) {
          blocks.push(...collectContent(child.children, renderer));
        }
    }
  }

  return blocks;
}

/**
 * Extract text content from a Text node.
 * Supports both `text` prop (preferred) and `children` prop (fallback).
 */
function extractText(node: TentickleNode): string {
  // Prefer explicit `text` prop (avoids React trying to reconcile children)
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

  return "";
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
