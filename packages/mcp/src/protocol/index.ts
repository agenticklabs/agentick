/**
 * Protocol layer — wire-edge utilities for talking the MCP JSON-RPC
 * dialect. These are pure functions / types; the substrate concerns
 * (transport, lifecycle, registration) live in the client/ tree.
 */

export {
  ErrorCodes,
  protocolError,
  rethrowAsProtocolError,
  safeToolHandler,
  sanitizeErrorMessage,
  stripMcpErrorPrefix,
  toMCPResult,
  toolError,
  toolResult,
} from "./errors.js";

export {
  COMPLETION_MAX_VALUES,
  completeDependent,
  completeFromAsync,
  completeFromEnum,
  completeFromList,
  completePrefixMatch,
  normalizeCompletionResult,
  type CompletionContext,
  type CompletionHandler,
  type CompletionResult,
} from "./completions.js";
