/**
 * Tool Types
 *
 * Platform-independent types for tool calling.
 * Used by both backend (@tentickle/core) and frontend (@tentickle/client).
 */

import type { ContentBlock } from "./blocks";

/**
 * Tool execution type determines how and where the tool is CONFIGURED to execute.
 * This is the tool's definition - where it SHOULD run.
 */
export enum ToolExecutionType {
  /**
   * Server-executed: Tool runs on the engine server (default).
   * Tool has a `run` method that executes synchronously.
   */
  SERVER = "server",

  /**
   * Client-executed: Tool call is delegated to client/3rd party.
   * May or may not require feedback before continuing execution.
   */
  CLIENT = "client",

  /**
   * Provider-executed: Tool is executed by the model provider (e.g., Google grounding).
   * Tool results come directly from provider, bypassing ToolExecutor.
   */
  PROVIDER = "provider",

  /**
   * MCP-executed: Tool is executed by an MCP (Model Context Protocol) server.
   * Engine acts as MCP client, forwarding calls to external MCP servers.
   */
  MCP = "mcp",

  /**
   * Output tool: Emits structured data without returning to the model.
   * The tool's input (validated against schema) is collected in result.outputs.
   * No tool_result is sent back to the model - the data flows out of the app.
   * Use for extracting structured data from the model's reasoning.
   */
  OUTPUT = "output",
}

/**
 * Tool executor identifies WHO actually executed a tool.
 *
 * Different from ToolExecutionType which is WHERE the tool is configured to run.
 * A SERVER-type tool can be executed by either the engine or an adapter library.
 */
export type ToolExecutor =
  /** Executed by Tentickle engine's ToolExecutor */
  | "engine"
  /** Executed by adapter library (e.g., AI SDK with maxSteps) */
  | "adapter"
  /** Executed by the AI provider (e.g., OpenAI code interpreter, Google grounding) */
  | "provider"
  /** Executed by the client (browser/frontend) */
  | "client";

/**
 * Tool intent describes WHAT the tool does, independent of WHERE it runs.
 * Used by clients to determine how to render/handle tool calls.
 */
export enum ToolIntent {
  /**
   * Renders UI in the client (form, chart, document, code output).
   * The tool_use block becomes renderable content.
   */
  RENDER = "render",

  /**
   * Performs an action (navigate, clipboard, notification, native feature).
   * Side-effect focused, may not produce visible output.
   */
  ACTION = "action",

  /**
   * Computes/transforms data (default for most tools).
   * Returns data that becomes part of the conversation.
   */
  COMPUTE = "compute",
}

// ============================================================================
// Tool Call & Result Types
// ============================================================================

/**
 * Tool call - represents a tool call made by the model.
 *
 * Used in streaming, execution tracking, and message content.
 */
export interface ToolCall {
  /** Unique ID for this tool call (correlates with tool_result) */
  id: string;
  /** Tool name */
  name: string;
  /** Tool input parameters */
  input: Record<string, unknown>;
  /** Result of tool execution (present after execution) */
  result?: ToolResult;
}

/**
 * Tool result - represents the result of a tool execution.
 *
 * Used in stream events and execution tracking.
 */
export interface ToolResult {
  /** Optional unique ID for the result itself */
  id?: string;
  /** ID of the tool call this result is for (matches ToolCall.id) */
  toolUseId: string;
  /** Tool name */
  name: string;
  /** Whether execution succeeded */
  success: boolean;
  /** Result content (tool results are ContentBlock[] for rich output) */
  content: ContentBlock[];
  /** Error message if success is false */
  error?: string;
  /** Who executed this tool */
  executedBy?: ToolExecutor;
  /**
   * Execution metadata for observability.
   */
  metadata?: {
    executionTimeMs?: number;
    retryCount?: number;
    cacheHit?: boolean;
    [key: string]: unknown;
  };
}

/**
 * Simplified tool definition - platform-independent base structure.
 * Used for direct tool execution from clients.
 *
 * Backend extends this with providerOptions, libraryOptions, mcpConfig.
 */
export interface ToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description for the model */
  description: string;
  /** JSON Schema for tool input */
  input: Record<string, unknown>;
  /** Optional JSON Schema for tool output (for validation/documentation) */
  output?: Record<string, unknown>;
  /**
   * Tool execution type. Determines how the tool is executed.
   * Default: SERVER (engine executes tool.run on server).
   */
  type?: ToolExecutionType;
  /**
   * Tool intent describes what the tool does (render, action, compute).
   * Used by clients to determine how to render/handle tool calls.
   * Default: COMPUTE
   */
  intent?: ToolIntent;
  /**
   * Whether execution should wait for client response.
   * Only applicable for CLIENT type tools.
   * - true: Server pauses and waits for tool_result from client (e.g., forms)
   * - false: Server continues immediately with defaultResult (e.g., charts)
   * Default: false
   */
  requiresResponse?: boolean;
  /**
   * Timeout in milliseconds when waiting for client response.
   * Only applicable when requiresResponse is true.
   * Default: 30000 (30 seconds)
   */
  timeout?: number;
  /**
   * Default result to use when requiresResponse is false.
   * Returned immediately for render tools that don't need client feedback.
   * Default: [{ type: 'text', text: '[{name} rendered on client]' }]
   */
  defaultResult?: ContentBlock[];
}

/**
 * Client tool definition - sent by clients to declare available tools.
 * Simplified interface for client-provided tools.
 *
 * Note: This is the platform-independent structure. Backend-specific
 * fields (like providerOptions) are added when converting to ToolDefinition.
 */
export interface ClientToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description for the model */
  description: string;
  /** JSON Schema for tool input */
  input: Record<string, unknown>;
  /** Optional JSON Schema for tool output (for validation/documentation) */
  output?: Record<string, unknown>;
  /**
   * Tool intent (render, action, compute).
   * Default: RENDER (most client tools render UI)
   */
  intent?: ToolIntent;
  /**
   * Whether server should wait for client response.
   * Default: false (render tools return default result immediately)
   */
  requiresResponse?: boolean;
  /**
   * Timeout in ms when waiting for response.
   * Default: 30000
   */
  timeout?: number;
  /**
   * Default result when requiresResponse is false.
   * Default: [{ type: 'text', text: '[{name} rendered on client]' }]
   */
  defaultResult?: ContentBlock[];
}

// ============================================================================
// Tool Confirmation Types
// ============================================================================

// Note: ToolConfirmationRequest and ToolConfirmationResponse (the wire format)
// are defined in protocol.ts and exported from the main shared package.

/**
 * Result of a tool confirmation, includes tool metadata for hooks/events.
 * Used internally and in stream events.
 */
export interface ToolConfirmationResult {
  /** ID of the tool call */
  toolUseId: string;
  /** Name of the tool */
  toolName: string;
  /** Whether the tool execution was allowed */
  confirmed: boolean;
  /** Whether this is a persistent preference */
  always: boolean;
}
