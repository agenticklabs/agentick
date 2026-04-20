/**
 * MCP (Model Context Protocol) Types
 *
 * Configuration types for MCP integration using @modelcontextprotocol/sdk.
 * Auth and connection types are inherited from @agentick/mcp — this module
 * adds Cursor-style shorthand and the 'websocket' transport alias.
 */

import type { MCPConnectionConfig } from "@agentick/mcp/client";

/**
 * Cursor-style MCP server configuration (simplified format)
 * Used for both EngineConfig.mcpServers and MCPToolComponent config
 */
export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * MCP transport types
 * Note: 'websocket' maps to StreamableHTTP in the SDK
 * 'in-process' uses a pre-created Transport object (e.g. InMemoryTransport)
 */
export type MCPTransport = "stdio" | "sse" | "websocket" | "in-process";

/**
 * MCP server configuration.
 *
 * Extends @agentick/mcp's MCPConnectionConfig with the 'websocket' transport
 * alias and a broader transport union. Auth types are inherited — see
 * MCPConnectionConfig.auth for bearer, api_key, oauth, none options.
 */
export interface MCPConfig extends Omit<MCPConnectionConfig, "transport"> {
  transport: MCPTransport;
}

/**
 * MCP tool definition (from server)
 * Matches the SDK's Tool type structure
 */
export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  /**
   * Tool metadata per MCP spec — carries `_meta.ui` for MCP Apps
   * (resourceUri + visibility).
   */
  _meta?: Record<string, unknown>;
}

// ============================================================================
// Resource Types
// ============================================================================

/**
 * An MCP resource discovered from a server.
 * Enriched with serverName so the routing layer knows where it came from.
 */
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

/**
 * An MCP resource template discovered from a server.
 * Templates have parameterized URIs like `db://schema/{table}`.
 */
export interface MCPResourceTemplate {
  uriTemplate: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

/**
 * Content returned by reading a resource.
 */
export interface MCPResourceContent {
  uri: string;
  text?: string;
  blob?: string;
  mimeType?: string;
}
