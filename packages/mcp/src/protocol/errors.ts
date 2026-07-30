/**
 * MCP wire error utilities — sanitization, tool result builders,
 * protocol error throw-shape.
 *
 * **v1 origin:** ported from `packages/mcp/src/protocol/errors.ts`.
 * Pure functions, no framework coupling.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ContentBlock } from "@agentick/spec";

import { toWireContent } from "./content.js";

// ============================================================================
// JSON-RPC error codes
// ============================================================================

/** Subset of JSON-RPC + MCP error codes adopters reach for. */
export const ErrorCodes = {
  /** Invalid method parameters. */
  INVALID_PARAMS: -32602,
  /** Method not found. */
  METHOD_NOT_FOUND: -32601,
  /**
   * Server-defined error — used for session errors, rate limiting,
   * and other domain-specific failures the JSON-RPC standard doesn't
   * carve out an explicit code for.
   */
  SERVER_ERROR: -32001,
} as const;

// ============================================================================
// Safe error messages
// ============================================================================

/** Patterns that must NEVER appear in client-facing error messages. */
const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /at\s+\S+\s+\(.*:\d+:\d+\)/, // stack trace lines
  /\/[a-zA-Z][\w/.-]+\.\w{1,4}:\d+/, // file paths with line numbers
  /(?:mongodb|postgres|mysql|redis):\/\//i, // db connection strings
  /password\s*[:=]\s*\S+/i, // password in config
  /(?:secret|token|key)\s*[:=]\s*\S+/i, // generic secrets
];

/**
 * Sanitize an error message for client consumption. Strips stack
 * traces, file paths, connection strings, and secrets. Returns
 * `fallback` if anything sensitive is detected.
 */
export function sanitizeErrorMessage(message: string, fallback = "Internal server error"): string {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(message)) return fallback;
  }
  return message;
}

// ============================================================================
// Tool result helpers
// ============================================================================

/**
 * Construct an error `CallToolResult` (`isError: true`). Always
 * sanitizes the error message to prevent leaking internals.
 */
export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: sanitizeErrorMessage(message) }],
    isError: true,
  };
}

/** Construct a successful text `CallToolResult`. */
export function toolResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

/**
 * Project an agentick `{ content: ContentBlock[] }` payload to MCP's
 * `CallToolResult` shape — the whole 23-member union narrowed by
 * {@link toWireContent}, not just text + image.
 *
 * Used at the wire edge when bridging tool results from the local
 * `ToolExecutor` (agentick ContentBlock) to an outbound MCP
 * `tools/call` response (MCP content).
 */
export function toMCPResult(result: { readonly content: readonly ContentBlock[] }): CallToolResult {
  return { content: toWireContent(result.content) };
}

/**
 * Wrap a tool handler so any thrown error becomes a safe
 * `isError: true` result. Stops stack traces and internal details
 * from reaching the client.
 */
export function safeToolHandler<
  Args extends readonly unknown[],
  T extends (...args: Args) => Promise<CallToolResult>,
>(handler: T): T {
  return (async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toolError(message);
    }
  }) as T;
}

// ============================================================================
// Protocol errors
// ============================================================================

/**
 * Throw a JSON-RPC protocol error from a server handler.
 *
 * SDK quirk: `new McpError(code, message)` calls
 * `super("MCP error {code}: {message}")`, so `error.message` carries
 * a prefix at construction. The SDK's serialization layer then ships
 * `error.message` verbatim, and the receiving client SDK reconstructs
 * an `McpError` adding ANOTHER prefix — yielding doubled
 * `"MCP error -32601: MCP error -32601: ..."` on the client side.
 *
 * `protocolError` sidesteps the double-prefix by throwing a plain
 * `Error` with `code` (and optional `data`) properties. The SDK's
 * error serialization reads `error.code` / `error.message` directly
 * (no `instanceof McpError` check), so the client receives a clean
 * message and the client SDK adds exactly one prefix.
 */
export function protocolError(code: number, message: string, data?: unknown): never {
  const err = new Error(message) as Error & { code: number; data?: unknown };
  err.code = code;
  if (data !== undefined) err.data = data;
  throw err;
}

/**
 * Strip the SDK's `"MCP error {code}: "` prefix from a message if
 * present. Used defensively on handler-thrown `McpError` values so
 * they don't inflict the double-prefix on the client either.
 */
export function stripMcpErrorPrefix(message: string): string {
  return message.replace(/^MCP error -?\d+:\s*/, "");
}

/**
 * Re-throw a caller-supplied error as a clean protocol error if it
 * is protocol-shaped (has a numeric `code`). Strips the McpError
 * prefix on round-trip so the client sees a single prefix. Returns
 * `false` if `err` isn't protocol-shaped — caller treats it as an
 * execution error or other failure.
 */
export function rethrowAsProtocolError(err: unknown): boolean {
  if (err instanceof McpError) {
    protocolError(err.code, stripMcpErrorPrefix(err.message), err.data);
  }
  if (err instanceof Error && typeof (err as Error & { code?: unknown }).code === "number") {
    // Already protocol-shaped — propagate verbatim.
    throw err;
  }
  return false;
}
