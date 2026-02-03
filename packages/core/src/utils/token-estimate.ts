/**
 * Token Estimation Utilities
 *
 * Provides rough token count estimates for DevTools visualization.
 * Uses ~4 characters per token as a reasonable approximation for English text.
 *
 * These estimates are intentionally approximate - they're for DevTools
 * visualization, not for accurate billing or context window management.
 */

import type { Message, ContentBlock, ToolDefinition } from "@tentickle/shared";
import type {
  CompiledStructure,
  CompiledTimelineEntry,
  CompiledTool,
  CompiledSection,
} from "../compiler/types";
import type { SemanticContentBlock } from "../renderers/types";

/**
 * Approximate characters per token for English text.
 * This is a rough estimate - actual tokenization varies by model.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count from text.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 *
 * @example
 * ```typescript
 * estimateTokens("Hello, world!"); // ~3 tokens
 * ```
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for a content block.
 */
export function estimateBlockTokens(block: ContentBlock | SemanticContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokens((block as { text: string }).text);
    case "tool_use":
      // Tool use includes name + input JSON
      return (
        estimateTokens((block as { name: string }).name) +
        estimateTokens(JSON.stringify((block as { input: unknown }).input ?? {}))
      );
    case "tool_result":
      // Tool result includes content
      return estimateTokens(JSON.stringify((block as { content: unknown }).content ?? ""));
    case "code":
      // Code includes language + code text
      return (
        estimateTokens((block as { language?: string }).language ?? "") +
        estimateTokens((block as any).code ?? "")
      );
    case "image":
    case "audio":
    case "video":
      // Media blocks - estimate based on type, actual tokens vary
      return 50; // Rough estimate for media tokens
    default:
      // For unknown block types, try to stringify
      try {
        return estimateTokens(JSON.stringify(block));
      } catch {
        return 10; // Fallback for non-serializable blocks
      }
  }
}

/**
 * Estimate tokens for a message.
 *
 * @param message - The message to estimate tokens for
 * @returns Estimated token count
 */
export function estimateMessageTokens(message: Message): number {
  let total = 0;
  for (const block of message.content) {
    total += estimateBlockTokens(block);
  }
  return total;
}

/**
 * Estimate tokens for a compiled timeline entry.
 */
export function estimateTimelineEntryTokens(entry: CompiledTimelineEntry): number {
  let total = 0;
  for (const block of entry.content) {
    total += estimateBlockTokens(block as ContentBlock);
  }
  return total;
}

/**
 * Estimate tokens for a compiled section.
 */
export function estimateSectionTokens(section: CompiledSection): number {
  let total = 0;
  if (section.title) {
    total += estimateTokens(section.title);
  }
  for (const block of section.content) {
    total += estimateBlockTokens(block as ContentBlock);
  }
  return total;
}

/**
 * Estimate tokens for a compiled tool.
 */
export function estimateToolTokens(tool: CompiledTool | ToolDefinition): number {
  let total = 0;
  total += estimateTokens(tool.name);
  if (tool.description) {
    total += estimateTokens(tool.description);
  }
  if ((tool as CompiledTool).schema) {
    total += estimateTokens(JSON.stringify((tool as CompiledTool).schema));
  }
  if ((tool as ToolDefinition).input) {
    total += estimateTokens(JSON.stringify((tool as ToolDefinition).input));
  }
  if ((tool as ToolDefinition).output) {
    total += estimateTokens(JSON.stringify((tool as ToolDefinition).output));
  }
  return total;
}

/**
 * Token summary for a compiled structure.
 */
export interface TokenSummary {
  /** Tokens in system prompt(s) */
  system: number;
  /** Tokens in timeline messages */
  messages: number;
  /** Tokens in tool definitions */
  tools: number;
  /** Tokens in ephemeral content */
  ephemeral: number;
  /** Total tokens */
  total: number;
  /** Token count by component (keyed by component identifier) */
  byComponent: Map<string, number>;
}

/**
 * Compute token summary for a compiled structure.
 *
 * @param compiled - The compiled structure to analyze
 * @returns Token summary with breakdown by category
 *
 * @example
 * ```typescript
 * const summary = computeTokenSummary(compiled);
 * console.log(`Total: ~${summary.total} tokens`);
 * console.log(`System: ${summary.system}, Messages: ${summary.messages}`);
 * ```
 */
export function computeTokenSummary(compiled: CompiledStructure): TokenSummary {
  let system = 0;
  let messages = 0;
  let tools = 0;
  let ephemeral = 0;
  const byComponent = new Map<string, number>();

  // System entries
  for (const entry of compiled.system) {
    const entryTokens = estimateTimelineEntryTokens(entry);
    system += entryTokens;
    if (entry.id) {
      byComponent.set(entry.id, (byComponent.get(entry.id) ?? 0) + entryTokens);
    }
  }

  // Timeline entries (messages)
  for (const entry of compiled.timelineEntries) {
    const entryTokens = estimateTimelineEntryTokens(entry);
    messages += entryTokens;
    if (entry.id) {
      byComponent.set(entry.id, (byComponent.get(entry.id) ?? 0) + entryTokens);
    }
  }

  // Tools
  for (const tool of compiled.tools) {
    const toolTokens = estimateToolTokens(tool);
    tools += toolTokens;
    byComponent.set(`tool:${tool.name}`, toolTokens);
  }

  // Ephemeral content
  for (const eph of compiled.ephemeral) {
    let ephTokens = 0;
    for (const block of eph.content) {
      ephTokens += estimateBlockTokens(block as ContentBlock);
    }
    ephemeral += ephTokens;
  }

  // Sections (typically system-level content like system prompt)
  let sections = 0;
  for (const [sectionId, section] of compiled.sections) {
    const sectionTokens = estimateSectionTokens(section);
    sections += sectionTokens;
    byComponent.set(`section:${sectionId}`, sectionTokens);
  }

  // Add sections to system total (sections are system-level content)
  system += sections;

  return {
    system,
    messages,
    tools,
    ephemeral,
    total: system + messages + tools + ephemeral,
    byComponent,
  };
}

/**
 * Format token count for display.
 * Shows "1.2k" for counts >= 1000.
 *
 * @param tokens - Token count
 * @returns Formatted string
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  return `${(tokens / 1000).toFixed(1)}k`;
}
