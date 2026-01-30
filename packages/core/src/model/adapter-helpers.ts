/**
 * Adapter Helpers - Composable utilities for building adapters
 *
 * These are opt-in helpers adapters can import and use.
 * No magic, no DSLs - just functions.
 *
 * @module tentickle/model/adapter-helpers
 */

import type { ContentBlock, Message, UsageStats } from "@tentickle/shared";
import { StopReason } from "@tentickle/shared";

// ============================================================================
// Message Helpers
// ============================================================================

/**
 * Extract system messages into a single string, return the rest.
 */
export function extractSystemPrompt(messages: Message[]): {
  system: string | undefined;
  messages: Message[];
} {
  let system: string | undefined;
  const rest: Message[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text = msg.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("\n\n");
      system = system ? `${system}\n\n${text}` : text;
    } else {
      rest.push(msg);
    }
  }

  return { system, messages: rest };
}

/**
 * Group consecutive tool results by their preceding assistant message.
 * Useful for providers that expect tool results immediately after tool calls.
 */
export function groupToolResults(
  messages: Message[],
): Array<{ message: Message; toolResults?: Message }> {
  const result: Array<{ message: Message; toolResults?: Message }> = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "tool") {
      // Attach to previous entry if it was assistant
      if (result.length > 0 && result[result.length - 1].message.role === "assistant") {
        result[result.length - 1].toolResults = msg;
      } else {
        // Orphan tool result - include anyway
        result.push({ message: msg });
      }
    } else {
      result.push({ message: msg });
    }
  }

  return result;
}

/**
 * Normalize message - handle string messages, ensure content array exists.
 */
export function normalizeMessage(msg: Message | string): Message {
  if (typeof msg === "string") {
    return { role: "user", content: [{ type: "text", text: msg }] };
  }
  return msg;
}

/**
 * Filter empty messages (no content blocks).
 */
export function filterEmptyMessages(messages: Message[]): Message[] {
  return messages.filter((m) => m.content && m.content.length > 0);
}

// ============================================================================
// Content Block Helpers
// ============================================================================

/**
 * Extract text from content blocks.
 */
export function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("");
}

/**
 * Extract text blocks only.
 */
export function getTextBlocks(content: ContentBlock[]): Array<{ type: "text"; text: string }> {
  return content.filter((b): b is { type: "text"; text: string } => b.type === "text");
}

/**
 * Check if content has any images.
 */
export function hasImages(content: ContentBlock[]): boolean {
  return content.some((b) => b.type === "image");
}

/**
 * Check if content has any tool uses.
 */
export function hasToolUses(content: ContentBlock[]): boolean {
  return content.some((b) => b.type === "tool_use");
}

/**
 * Get tool use blocks from content.
 */
export function getToolUseBlocks(content: ContentBlock[]): Array<{
  type: "tool_use";
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}> {
  return content.filter((b) => b.type === "tool_use") as Array<{
    type: "tool_use";
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  }>;
}

/**
 * Get tool result blocks from content.
 */
export function getToolResultBlocks(content: ContentBlock[]): Array<{
  type: "tool_result";
  toolUseId: string;
  name: string;
  content: ContentBlock[];
  isError?: boolean;
}> {
  return content.filter((b) => b.type === "tool_result") as Array<{
    type: "tool_result";
    toolUseId: string;
    name: string;
    content: ContentBlock[];
    isError?: boolean;
  }>;
}

// ============================================================================
// Image Helpers
// ============================================================================

type ImageBlock = {
  type: "image";
  source:
    | { type: "base64"; data: string; mediaType?: string }
    | { type: "url"; url: string }
    | { type: "s3"; bucket: string; key: string }
    | { type: "gcs"; bucket: string; object: string }
    | { type: "file_id"; fileId: string };
  mimeType?: string;
};

/**
 * Get image as base64 data (if available).
 */
export function imageToBase64(block: ContentBlock): string | undefined {
  if (block.type !== "image") return undefined;
  const img = block as ImageBlock;
  if (img.source.type === "base64") return img.source.data;
  return undefined;
}

/**
 * Get image as URL (if available).
 */
export function imageToUrl(block: ContentBlock): string | undefined {
  if (block.type !== "image") return undefined;
  const img = block as ImageBlock;
  if (img.source.type === "url") return img.source.url;
  // Could also construct data: URL from base64
  if (img.source.type === "base64") {
    const mimeType = img.mimeType || "image/png";
    return `data:${mimeType};base64,${img.source.data}`;
  }
  return undefined;
}

/**
 * Get image mime type.
 */
export function imageMimeType(block: ContentBlock): string | undefined {
  if (block.type !== "image") return undefined;
  const img = block as ImageBlock;
  return img.mimeType;
}

/**
 * Check if image is base64.
 */
export function isBase64Image(block: ContentBlock): boolean {
  if (block.type !== "image") return false;
  return (block as ImageBlock).source.type === "base64";
}

/**
 * Check if image is URL.
 */
export function isUrlImage(block: ContentBlock): boolean {
  if (block.type !== "image") return false;
  return (block as ImageBlock).source.type === "url";
}

// ============================================================================
// Document Helpers
// ============================================================================

type DocumentBlock = {
  type: "document";
  source:
    | { type: "base64"; data: string; mediaType?: string }
    | { type: "url"; url: string }
    | { type: "s3"; bucket: string; key: string }
    | { type: "gcs"; bucket: string; object: string }
    | { type: "file_id"; fileId: string };
  mimeType?: string;
};

/**
 * Get document as base64 data (if available).
 */
export function documentToBase64(block: ContentBlock): string | undefined {
  if (block.type !== "document") return undefined;
  const doc = block as DocumentBlock;
  if (doc.source.type === "base64") return doc.source.data;
  return undefined;
}

/**
 * Get document as URL (if available).
 */
export function documentToUrl(block: ContentBlock): string | undefined {
  if (block.type !== "document") return undefined;
  const doc = block as DocumentBlock;
  if (doc.source.type === "url") return doc.source.url;
  return undefined;
}

// ============================================================================
// Tool Definition Helpers
// ============================================================================

/**
 * Normalize tool reference to { name, description, input } shape.
 */
export function normalizeToolDefinition(tool: unknown): {
  name: string;
  description: string;
  input: unknown;
} | null {
  if (!tool || typeof tool !== "object") return null;

  // ExecutableTool shape: { metadata: { name, description, input } }
  if ("metadata" in tool && typeof (tool as any).metadata === "object") {
    const meta = (tool as any).metadata;
    return {
      name: meta.name || "",
      description: meta.description || "",
      input: meta.input,
    };
  }

  // ToolDefinition shape: { name, description, input }
  if ("name" in tool) {
    return {
      name: (tool as any).name || "",
      description: (tool as any).description || "",
      input: (tool as any).input,
    };
  }

  return null;
}

/**
 * Convert tool input schema to JSON Schema (if it's a Zod schema).
 * Returns the schema as-is if it's already JSON Schema.
 */
export function toJsonSchema(schema: unknown): unknown {
  if (!schema) return {};

  // Check if it's a Zod schema (has _def property)
  if (typeof schema === "object" && "_def" in (schema as object)) {
    // Zod schema - would need zod-to-json-schema to convert
    // For now, return as-is and let the adapter handle it
    return schema;
  }

  // Already JSON Schema or plain object
  return schema;
}

// ============================================================================
// Tool Result Helpers
// ============================================================================

/**
 * Convert tool result content to simple text/json format.
 * Useful for providers that expect simple tool outputs.
 */
export function toolResultToSimple(
  content: ContentBlock[],
  isError?: boolean,
): {
  type: "text" | "json" | "error";
  value: unknown;
} {
  if (!content || content.length === 0) {
    return { type: isError ? "error" : "text", value: isError ? "Error" : "Success" };
  }

  // Single text block
  if (content.length === 1 && content[0].type === "text") {
    const text = (content[0] as { text: string }).text;
    return { type: isError ? "error" : "text", value: text };
  }

  // Single JSON block
  if (content.length === 1 && content[0].type === "json") {
    const json = content[0] as { data?: unknown; text?: string };
    const value = json.data ?? (json.text ? JSON.parse(json.text) : {});
    return { type: isError ? "error" : "json", value };
  }

  // Multiple blocks - combine as text
  const text = content
    .map((b) => {
      if (b.type === "text") return (b as { text: string }).text;
      if (b.type === "json") {
        const j = b as { data?: unknown; text?: string };
        return j.text || JSON.stringify(j.data);
      }
      return JSON.stringify(b);
    })
    .join("\n");

  return { type: isError ? "error" : "text", value: text };
}

// ============================================================================
// Usage Helpers
// ============================================================================

/**
 * Normalize usage stats from various provider formats.
 */
export function normalizeUsage(raw: Record<string, unknown> | undefined): UsageStats {
  if (!raw) return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

  const inputTokens = (raw.inputTokens ?? raw.promptTokens ?? raw.prompt_tokens ?? 0) as number;
  const outputTokens = (raw.outputTokens ??
    raw.completionTokens ??
    raw.completion_tokens ??
    0) as number;
  const totalTokens = (raw.totalTokens ?? raw.total_tokens ?? inputTokens + outputTokens) as number;

  return { inputTokens, outputTokens, totalTokens };
}

/**
 * Merge two usage stats (take max of each field).
 */
export function mergeUsage(a: UsageStats, b: Partial<UsageStats>): UsageStats {
  return {
    inputTokens: Math.max(a.inputTokens, b.inputTokens ?? 0),
    outputTokens: Math.max(a.outputTokens, b.outputTokens ?? 0),
    totalTokens: Math.max(a.totalTokens, b.totalTokens ?? 0),
  };
}

// ============================================================================
// Stop Reason Helpers
// ============================================================================

/**
 * Common stop reason mappings for various providers.
 */
export const STOP_REASON_MAP = {
  // OpenAI
  stop: StopReason.STOP,
  length: StopReason.MAX_TOKENS,
  tool_calls: StopReason.TOOL_USE,
  content_filter: StopReason.CONTENT_FILTER,
  function_call: StopReason.TOOL_USE,

  // Anthropic
  end_turn: StopReason.STOP,
  max_tokens: StopReason.MAX_TOKENS,
  stop_sequence: StopReason.STOP,

  // AI SDK
  "tool-calls": StopReason.TOOL_USE,
  other: StopReason.OTHER,
  error: StopReason.ERROR,

  // Google
  STOP: StopReason.STOP,
  MAX_TOKENS: StopReason.MAX_TOKENS,
  SAFETY: StopReason.CONTENT_FILTER,
  RECITATION: StopReason.CONTENT_FILTER,
} as const;

/**
 * Map provider stop reason string to StopReason enum.
 */
export function mapStopReason(reason: string | undefined): StopReason {
  if (!reason) return StopReason.UNSPECIFIED;
  return (STOP_REASON_MAP as Record<string, StopReason>)[reason] ?? StopReason.UNSPECIFIED;
}

// ============================================================================
// Chunk Helpers (for mapChunk implementations)
// ============================================================================

/**
 * Safely get a nested field from an object.
 */
export function getField<T = unknown>(obj: unknown, ...path: string[]): T | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as T | undefined;
}

/**
 * Check if chunk has a specific type field.
 */
export function isChunkType(chunk: unknown, type: string): boolean {
  return typeof chunk === "object" && chunk !== null && (chunk as { type?: string }).type === type;
}
