/**
 * # Agentick Shared Types
 *
 * Platform-independent type definitions shared across all Agentick packages.
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
 * import type { Message, ContentBlock, ToolDefinition } from '@agentick/shared';
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
 * @module @agentick/shared
 */

export * from "./block-types.js";
export * from "./blocks.js";
export * from "./messages.js";
export * from "./streaming.js";
export * from "./tools.js";
export * from "./models.js";
export * from "./input.js";
export * from "./timeline.js";
export * from "./errors.js";
export * from "./identity.js";
export * from "./devtools.js";
export * from "./protocol.js";
export * from "./model-catalog.js";
export * from "./transport.js";
export * from "./context.js";
export * from "./secrets.js";
export * from "./split-message.js";
export * from "./embeddings.js";
export * from "./transport-utils.js";
export * from "./rpc-transport.js";
