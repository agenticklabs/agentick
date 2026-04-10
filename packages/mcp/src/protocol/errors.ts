import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

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
