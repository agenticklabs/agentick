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

// The sugar family lives in `@agentick/completions` and is re-exported through
// `./completions.js`; `COMPLETION_MAX_VALUES` is NOT here — the cap is a wire
// constraint and lives with the projection that applies it
// (`@agentick/mcp/server`).
export {
  completeDependent,
  completeFromAsync,
  completeFromEnum,
  completeFromList,
  completePrefixMatch,
  isDependentResolver,
  normalizeCompletionResult,
  type CompletionContext,
  type CompletionHandler,
  type CompletionResult,
  type DependentCompletionResolver,
} from "./completions.js";
