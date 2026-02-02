/**
 * Message types for model input/output.
 *
 * Messages represent conversation entries with specific roles:
 * - `user` - Human input messages
 * - `assistant` - Model-generated responses
 * - `system` - System/behavioral instructions
 * - `tool` - Tool/function call results
 * - `event` - Application events (user actions, system events, state changes)
 *
 * @example Creating messages
 * ```typescript
 * const userMsg = createUserMessage('Hello!');
 * const systemMsg = createSystemMessage('You are a helpful assistant.');
 * const assistantMsg: AssistantMessage = {
 *   role: 'assistant',
 *   content: [{ type: 'text', text: 'Hi there!' }]
 * };
 * ```
 *
 * @see {@link Message} - Base message interface
 * @see {@link ContentBlock} - Content block types
 *
 * @module
 */

import type { MessageRoles } from "./block-types";
import type { ContentBlock, EventAllowedBlock } from "./blocks";

// ============================================================================
// Message Types
// ============================================================================

/**
 * Base message interface for all message types.
 *
 * Messages are the fundamental unit of conversation in Tentickle.
 * Each message has a role indicating its source and an array
 * of content blocks.
 *
 * @example
 * ```typescript
 * const message: Message = {
 *   id: 'msg-123',
 *   role: 'user',
 *   content: [{ type: 'text', text: 'Hello!' }],
 *   metadata: { source: 'web' }
 * };
 * ```
 *
 * @see {@link UserMessage}, {@link AssistantMessage}, {@link SystemMessage}
 */
export interface Message {
  /** Unique message identifier */
  readonly id?: string;
  /** Message role (user, assistant, system, tool, event) */
  readonly role: MessageRoles;
  /** Array of content blocks */
  readonly content: ContentBlock[];
  /** Additional metadata */
  readonly metadata?: Record<string, any>;
  /** When the message was created */
  readonly createdAt?: string | Date;
  /** When the message was last updated */
  readonly updatedAt?: string | Date;
}

export interface ModelMessage extends Message {}

/** Message from a user/human */
export interface UserMessage extends Message {
  readonly role: "user";
}

/** Message from the AI assistant/model */
export interface AssistantMessage extends Message {
  readonly role: "assistant";
}

/** System instruction message (typically at conversation start) */
export interface SystemMessage extends Message {
  readonly role: "system";
}

/** Tool/function execution result message */
export interface ToolMessage extends Message {
  readonly role: "tool";
  /** ID of the tool call this result is for */
  readonly toolCallId?: string;
}

/** Application event message (user actions, system events, state changes) */
export interface EventMessage extends Message {
  readonly role: "event";
  readonly content: EventAllowedBlock[];
  /** Categorization of the event type */
  readonly eventType?: string;
}

// ============================================================================
// Message Helpers
// ============================================================================

export function createUserMessage(
  content: ContentBlock[] | string,
  metadata?: Record<string, any>,
): UserMessage {
  return {
    role: "user",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    metadata,
  };
}

export function createAssistantMessage(
  content: ContentBlock[] | string,
  metadata?: Record<string, any>,
): AssistantMessage {
  return {
    role: "assistant",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    metadata,
  };
}

export function createSystemMessage(
  content: ContentBlock[] | string,
  metadata?: Record<string, any>,
): SystemMessage {
  return {
    role: "system",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    metadata,
  };
}

export function isUserMessage(message: Message): message is UserMessage {
  return message.role === "user";
}

export function isAssistantMessage(message: Message): message is AssistantMessage {
  return message.role === "assistant";
}

export function isSystemMessage(message: Message): message is SystemMessage {
  return message.role === "system";
}

export function isToolMessage(message: Message): message is ToolMessage {
  return message.role === "tool";
}

export function isEventMessage(message: Message): message is EventMessage {
  return message.role === "event";
}

export function createToolMessage(
  content: ContentBlock[] | string,
  toolCallId?: string,
  metadata?: Record<string, any>,
): ToolMessage {
  return {
    role: "tool",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    toolCallId,
    metadata,
  };
}

export function createEventMessage(
  content: EventAllowedBlock[] | string,
  eventType?: string,
  metadata?: Record<string, any>,
): EventMessage {
  return {
    role: "event",
    content: typeof content === "string" ? [{ type: "text", text: content }] : content,
    eventType,
    metadata,
  };
}
