/**
 * # Tentickle Shared Types
 *
 * Platform-independent type definitions shared across all Tentickle packages.
 * These types define the core data structures for messages, content blocks,
 * tools, and streaming.
 *
 * ## Content Blocks
 *
 * Content blocks are discriminated unions representing all content types:
 *
 * - **Text** - Plain text content
 * - **Image/Audio/Video** - Media content with base64 or URL sources
 * - **ToolUse/ToolResult** - Tool call requests and responses
 * - **Code** - Executable code blocks
 *
 * ## Messages
 *
 * Messages represent conversation entries with roles:
 *
 * - `user` - Human input
 * - `assistant` - Model responses
 * - `system` - System prompts
 * - `tool_result` - Tool execution results
 *
 * ## Usage
 *
 * ```typescript
 * import type { Message, ContentBlock, ToolDefinition } from '@tentickle/shared';
 *
 * const message: Message = {
 *   role: 'user',
 *   content: [{ type: 'text', text: 'Hello!' }]
 * };
 * ```
 *
 * @see {@link ContentBlock} - All content block types
 * @see {@link Message} - Conversation message structure
 * @see {@link ToolDefinition} - Tool schema definition
 *
 * @module @tentickle/shared
 */

export * from "./block-types";
export * from "./blocks";
export * from "./messages";
export * from "./streaming";
export * from "./tools";
export * from "./models";
export * from "./input";
export * from "./timeline";
export * from "./errors";
export * from "./identity";
export * from "./devtools";
export * from "./protocol";
export * from "./model-catalog";
