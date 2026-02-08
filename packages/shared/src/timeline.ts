/**
 * Timeline Types
 *
 * Platform-independent types for timeline entries.
 * Used by both backend (@agentick/core) and frontend (@agentick/client).
 *
 * Timeline entries represent the conversation history. Tool calls and results
 * are embedded in message content blocks (tool_use, tool_result), not as
 * separate timeline entries. This is consistent with how models output them.
 */

import type { Message } from "./messages";

// ============================================================================
// Timeline Entry (Unified Format)
// ============================================================================

/**
 * Timeline entry - represents a message or event in the conversation.
 *
 * Tool calls and results are embedded in message content blocks:
 * - Tool calls: `tool_use` blocks in assistant messages
 * - Tool results: `tool_result` blocks in tool messages
 *
 * This unified format is used by both client and backend.
 * Backend extends this with SemanticContentBlock[] and renderer fields.
 */
export interface TimelineEntry {
  /**
   * Unique identifier for this timeline entry
   */
  id?: string;

  /**
   * Kind of timeline entry.
   * Currently only 'message' is supported. Additional kinds may be added in the future.
   *
   * Note: Application events (user actions, system events) use role: 'event' on the message,
   * not a separate kind. This keeps the model simple while allowing events to be
   * distinguished from conversation messages.
   */
  kind: "message";

  /**
   * The message content.
   * Tool calls and results are embedded in message.content as blocks:
   * - Assistant messages may contain `tool_use` blocks
   * - Tool messages contain `tool_result` blocks
   */
  message: Message;

  /**
   * Visibility control - who can see this entry
   * - 'model': Visible to the model (default)
   * - 'observer': Visible to observers/logs but not model
   * - 'log': Only in logs, not visible to model or observers
   */
  visibility?: "model" | "observer" | "log";

  /**
   * Tags for categorization and filtering
   */
  tags?: string[];

  /**
   * Optional metadata
   */
  metadata?: Record<string, unknown>;
}
