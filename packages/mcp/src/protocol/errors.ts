import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// JSON-RPC Error Codes
// ============================================================================

/** Standard JSON-RPC and MCP-specific error codes. */
export const ErrorCodes = {
  /** Invalid method parameters. */
  INVALID_PARAMS: -32602,
  /** Method not found. */
  METHOD_NOT_FOUND: -32601,
  /** Server-defined error — used for session errors, rate limiting, etc. */
  SERVER_ERROR: -32001,
} as const;

// ============================================================================
// Safe Error Messages
// ============================================================================

/** Patterns that must NEVER appear in client-facing error messages. */
const SENSITIVE_PATTERNS = [
  /at\s+\S+\s+\(.*:\d+:\d+\)/, // Stack trace lines
  /\/[a-zA-Z][\w/.-]+\.\w{1,4}:\d+/, // File paths with line numbers
  /(?:mongodb|postgres|mysql|redis):\/\//i, // DB connection strings
  /password\s*[:=]\s*\S+/i, // Password in config
  /(?:secret|token|key)\s*[:=]\s*\S+/i, // Secrets
];

/**
 * Sanitize an error message for client consumption.
 * Strips stack traces, file paths, connection strings, and secrets.
 * Returns a generic message if anything sensitive is detected.
 */
export function sanitizeErrorMessage(message: string, fallback = "Internal server error"): string {
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(message)) {
      return fallback;
    }
  }
  return message;
}

// ============================================================================
// Tool Result Helpers
// ============================================================================

/**
 * Create an error CallToolResult with isError: true.
 * Always sanitizes the error message to prevent information leakage.
 */
export function toolError(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: sanitizeErrorMessage(message) }],
    isError: true,
  };
}

/** Create a successful text CallToolResult. */
export function toolResult(text: string): CallToolResult {
  return {
    content: [{ type: "text", text }],
  };
}

/**
 * Convert agentick-style content blocks to MCP CallToolResult.
 * Maps content block types to MCP content types.
 *
 * Migrated from gateway plugin's toMCPResult.
 */
export function toMCPResult(result: { content: unknown[] }): CallToolResult {
  return {
    content: result.content.map((block) => {
      const b = block as Record<string, unknown>;
      if (b.type === "text") {
        return { type: "text" as const, text: String(b.text ?? "") };
      }
      if (b.type === "image") {
        return {
          type: "image" as const,
          data: String(b.data ?? ""),
          mimeType: String(b.mediaType ?? b.mimeType ?? "image/png"),
        };
      }
      // Unknown block type — serialize as JSON text
      return { type: "text" as const, text: JSON.stringify(block) };
    }),
  };
}

/**
 * Wrap a tool handler to catch errors and return safe isError results.
 * Prevents stack traces and internal details from reaching the client.
 */
export function safeToolHandler<T extends (...args: any[]) => Promise<CallToolResult>>(
  handler: T,
): T {
  return (async (...args: any[]) => {
    try {
      return await handler(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toolError(message);
    }
  }) as T;
}

// ============================================================================
// Protocol Errors
// ============================================================================

/**
 * Throw-shape for JSON-RPC protocol errors emitted from server handlers.
 *
 * SDK quirk: `new McpError(code, message)` calls `super("MCP error <code>: <message>")`,
 * meaning `error.message` carries a prefix at construction time. The SDK
 * serialization layer then ships `error.message` verbatim, and the receiving
 * client SDK reconstructs an `McpError` adding ANOTHER prefix — yielding a
 * doubled "MCP error -32601: MCP error -32601: ..." in the client's caught
 * error.
 *
 * `protocolError` sidesteps this by throwing a plain `Error` with `code`
 * and `data` properties on it. The SDK's error serialization at
 * `shared/protocol.js` reads `error['code']` and `error.message` directly
 * (no instanceof check on McpError), so the client receives a clean message
 * and the client SDK adds exactly one prefix.
 */
export function protocolError(code: number, message: string, data?: unknown): never {
  const err = new Error(message) as Error & { code: number; data?: unknown };
  err.code = code;
  if (data !== undefined) err.data = data;
  throw err;
}

/**
 * Strip the SDK's "MCP error <code>: " prefix from a message if present.
 * Used to defensively handle handler-thrown McpError values so they don't
 * inflict the double-prefix on the client either.
 */
export function stripMcpErrorPrefix(message: string): string {
  return message.replace(/^MCP error -?\d+:\s*/, "");
}

/**
 * Re-throw a caller-supplied error as a clean protocol error if it is
 * shaped like one (has `code`). Strips the McpError prefix so the client
 * receives a single prefix on round-trip.
 *
 * Returns false if the error is not protocol-shaped — caller should treat
 * it as an execution error or other failure.
 */
export function rethrowAsProtocolError(err: unknown): boolean {
  if (err instanceof McpError) {
    protocolError(err.code, stripMcpErrorPrefix(err.message), err.data);
  }
  if (err instanceof Error && typeof (err as Error & { code?: unknown }).code === "number") {
    // Already protocol-shaped (plain Error with .code) — let it propagate as-is.
    throw err;
  }
  return false;
}
