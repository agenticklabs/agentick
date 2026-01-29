/**
 * Content types, blocks, and message utilities.
 *
 * @module tentickle/content
 */

// Re-export content types, but exclude ones we extend locally
// Note: Message, ContentBlock, etc. are also exported from types.ts re-exports
export {
  normalizeMessageInput,
  normalizeContentInput,
  normalizeContentArray,
  isMessage,
  isContentBlock,
} from "@tentickle/shared";
export * from "@tentickle/shared/blocks";
export * from "@tentickle/shared/block-types";
export * from "@tentickle/shared/input";
export * from "@tentickle/shared/messages";

// Re-export all streaming types and utilities
// ModelStreamEvent types are model output streaming events
// OrchestrationStreamEvent types are execution/tick/tool events
export * from "@tentickle/shared/streaming";
