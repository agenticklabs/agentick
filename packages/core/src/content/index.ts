/**
 * Content types, blocks, and message utilities.
 *
 * @module agentick/content
 */

// Re-export content types, but exclude ones we extend locally
// Note: Message, ContentBlock, etc. are also exported from types.ts re-exports
export {
  normalizeMessageInput,
  normalizeContentInput,
  normalizeContentArray,
  isMessage,
  isContentBlock,
} from "@agentick/shared";
export * from "@agentick/shared/blocks";
export * from "@agentick/shared/block-types";
export * from "@agentick/shared/input";
export * from "@agentick/shared/messages";

// Re-export all streaming types and utilities
// ModelStreamEvent types are model output streaming events
// OrchestrationStreamEvent types are execution/tick/tool events
export * from "@agentick/shared/streaming";
