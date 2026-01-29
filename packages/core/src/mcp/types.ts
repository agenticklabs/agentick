/**
 * MCP (Model Context Protocol) Types
 *
 * Configuration types for MCP integration using @modelcontextprotocol/sdk
 */

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
 */
export type MCPTransport = "stdio" | "sse" | "websocket";

/**
 * MCP server configuration
 */
export interface MCPConfig {
  /**
   * Unique identifier for this MCP server connection
   */
  serverName: string;

  /**
   * Transport type for MCP communication
   */
  transport: MCPTransport;

  /**
   * Connection details (transport-specific)
   */
  connection: {
    /**
     * For stdio: command and args to spawn
     */
    command?: string;
    args?: string[];

    /**
     * For SSE/StreamableHTTP: server URL
     */
    url?: string;

    /**
     * Additional transport-specific options
     */
    [key: string]: any;
  };

  /**
   * Optional authentication
   */
  auth?: {
    type: "bearer" | "api_key" | "custom";
    token?: string;
    [key: string]: any;
  };
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
}
