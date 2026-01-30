/**
 * V2 Collector
 *
 * Traverses the TentickleNode tree and collects into CompiledStructure.
 */

import type { TentickleNode, TentickleContainer } from "../reconciler/types";
import type {
  CompiledStructure,
  CompiledSection,
  CompiledTimelineEntry,
  CompiledTool,
  CompiledEphemeral,
} from "./types";
import { createEmptyCompiledStructure } from "./types";
import type { SemanticContentBlock, Renderer } from "../renderers/types";

// ============================================================
// Component Type Constants
// These are matched by string name since we're using host config
// ============================================================

const SECTION = "Section";
const ENTRY = "Entry";
const MESSAGE = "Message";
const TOOL = "Tool";
const EPHEMERAL = "Ephemeral";
const TEXT = "Text";
const CODE = "Code";
const IMAGE = "Image";
const JSON_BLOCK = "Json";

/**
 * Collect compiled structure from a container.
 */
export function collect(container: TentickleContainer): CompiledStructure {
  const result = createEmptyCompiledStructure();

  for (const child of container.children) {
    collectNode(child, result);
  }

  return result;
}

/**
 * Collect from a single node and its descendants.
 */
function collectNode(node: TentickleNode, result: CompiledStructure): void {
  const typeName = getTypeName(node.type);

  switch (typeName) {
    case SECTION:
      collectSection(node, result);
      break;

    case ENTRY:
    case MESSAGE:
      collectTimelineEntry(node, result);
      break;

    case TOOL:
      collectTool(node, result);
      break;

    case EPHEMERAL:
      collectEphemeral(node, result);
      break;

    default:
      // Recurse into children for container/fragment nodes
      for (const child of node.children) {
        collectNode(child, result);
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
 */
function collectTimelineEntry(node: TentickleNode, result: CompiledStructure): void {
  const entry: CompiledTimelineEntry = {
    id: node.props.id as string | undefined,
    role: (node.props.role as "user" | "assistant" | "system" | "tool") ?? "user",
    content: collectContent(node.children, node.renderer),
    renderer: node.renderer,
    metadata: node.props.metadata as Record<string, unknown> | undefined,
    createdAt: node.props.createdAt as Date | undefined,
  };

  result.timelineEntries.push(entry);
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
    position: (node.props.position as "before" | "after" | "inline") ?? "inline",
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
  children: TentickleNode[],
  parentRenderer: Renderer | null,
): SemanticContentBlock[] {
  const blocks: SemanticContentBlock[] = [];

  for (const child of children) {
    const typeName = getTypeName(child.type);
    const renderer = child.renderer ?? parentRenderer;

    switch (typeName) {
      case TEXT:
        blocks.push({
          type: "text",
          text: extractText(child),
        });
        break;

      case CODE:
        blocks.push({
          type: "code",
          code: (child.props.code ?? child.props.children) as string,
          language: child.props.language as string | undefined,
        });
        break;

      case IMAGE:
        blocks.push({
          type: "image",
          source: child.props.src as string,
          alt: child.props.alt as string | undefined,
        });
        break;

      case JSON_BLOCK:
        blocks.push({
          type: "json",
          json: child.props.data ?? child.props.children,
        });
        break;

      default:
        // Recurse for nested containers
        if (child.children.length > 0) {
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
