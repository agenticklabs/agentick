/**
 * MCP runtime types — live connection shape and message envelope.
 *
 * {@link MCPDeclaration} (in `declarations.ts`) is the *declarative*
 * shape — the JSX component said "I want a connection to server X
 * with this config." {@link MCPConnection} is the *runtime* shape —
 * the live handle the framework component creates and registers with
 * the {@link MCPBridge}.
 *
 * Declaration → IR → snapshot. Connection → bridge → bridge consumers
 * (tools that proxy to MCP, resource queries, sampling callbacks).
 *
 * @see docs/proposals/v2/blueprint/22-state-formatters-reconciler-shape.md
 */

import type { MCPDeclaration } from "./declarations.js";
import type { ResourceDeclaration, ToolDeclaration } from "./declarations.js";

// ============================================================================
// Connection
// ============================================================================

export type MCPConnectionStatus = "connecting" | "ready" | "failed" | "disconnected";

/**
 * Live MCP connection registered with the {@link MCPBridge} by a
 * framework-specific component. Once `status === "ready"`, the
 * connection's tools + resources flow into the agent's
 * {@link RuntimeDeclarations}.
 *
 * `request()` is the low-level wire surface — adopters typically
 * interact via the tools the server exposes, not by issuing JSON-RPC
 * directly. Reserved for sampling, elicitation, completion, ping —
 * methods MCP servers can call back into the host.
 */
export interface MCPConnection {
  readonly declaration: MCPDeclaration;
  readonly status: MCPConnectionStatus;
  readonly error?: MCPConnectionError;
  /** Tools exposed by this server, mapped into our `ToolDeclaration` shape. */
  readonly tools: readonly ToolDeclaration[];
  /** Resources exposed by this server, mapped into `ResourceDeclaration`. */
  readonly resources: readonly ResourceDeclaration[];
  /** Optional human-readable instructions the server announced. */
  readonly instructions?: string;
  /**
   * Issue a JSON-RPC request against the server. The host bridges
   * sampling / elicitation / completion via this surface.
   */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Tear down the connection. Idempotent. */
  close(): Promise<void>;
}

export interface MCPConnectionError {
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}
