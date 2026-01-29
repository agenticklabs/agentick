/**
 * MCP Tool Component
 *
 * A component that connects to an MCP server and registers its tools.
 * Supports runtime configuration (auth tokens, etc.) and tool filtering.
 */

import { type EngineComponent, Component } from "../component/component";
import { COM } from "../com/object-model";
import { MCPClient } from "./client";
import { MCPService } from "./service";
import type { MCPConfig, MCPServerConfig } from "./types";
import { type JSX, createElement } from "../jsx/jsx-runtime";
import type { ComponentBaseProps } from "../jsx/jsx-types";

/**
 * Normalizes Cursor-style config to full MCPConfig
 */
function normalizeMCPConfig(serverName: string, config: MCPServerConfig | MCPConfig): MCPConfig {
  // If it's already a full MCPConfig, return as-is
  if ("transport" in config && "connection" in config) {
    return config as MCPConfig;
  }

  // Convert Cursor-style config (assumes stdio transport)
  const mcpServerConfig = config as MCPServerConfig;
  return {
    serverName,
    transport: "stdio",
    connection: {
      command: mcpServerConfig.command,
      args: mcpServerConfig.args || [],
      env: mcpServerConfig.env,
    },
  };
}

/**
 * Merges base config with runtime config (runtime overrides base)
 */
function mergeMCPConfig(base: MCPConfig, runtime?: Partial<MCPConfig>): MCPConfig {
  if (!runtime) {
    return base;
  }

  return {
    ...base,
    ...runtime,
    connection: {
      ...base.connection,
      ...runtime.connection,
    },
    auth: runtime.auth || base.auth,
  };
}

/**
 * Props for MCPToolComponent
 */
export interface MCPToolComponentProps extends ComponentBaseProps, Partial<EngineComponent> {
  /**
   * MCP server name (used as identifier)
   */
  server: string;

  /**
   * Base MCP server configuration (Cursor-style or full MCPConfig)
   * This is the static configuration defined at component creation time.
   */
  config: MCPServerConfig | MCPConfig;

  /**
   * Runtime configuration (merged with base config).
   * Useful for user-specific auth tokens, dynamic URLs, etc.
   * Can be passed from user context, execution input, etc.
   */
  runtimeConfig?: Partial<MCPConfig>;

  /**
   * List of tool names to exclude from registration.
   * If provided, only tools NOT in this list will be registered.
   */
  exclude?: string[];

  /**
   * List of tool names to include (whitelist).
   * If provided, only tools in this list will be registered.
   * Takes precedence over exclude.
   */
  include?: string[];

  /**
   * Optional MCPClient instance (for sharing connections across components).
   * If not provided, creates a new instance.
   */
  mcpClient?: MCPClient;

  /**
   * Optional prefix for tool names (to avoid conflicts).
   * Example: prefix="mcp_" → tool "read_file" becomes "mcp_read_file"
   */
  toolPrefix?: string;
}

/**
 * MCPToolComponent connects to an MCP server and registers its tools into the context.
 *
 * Usage:
 * ```tsx
 * // Simple usage with Cursor-style config
 * <MCPToolComponent
 *   server="postgres"
 *   config={{
 *     command: 'npx',
 *     args: ['-y', '@modelcontextprotocol/server-postgres', 'postgresql://localhost/mydb'],
 *   }}
 * />
 *
 * // With runtime config (auth token from user context)
 * <MCPToolComponent
 *   server="api-server"
 *   config={{
 *     transport: 'sse',
 *     connection: { url: 'https://api.example.com/mcp' },
 *   }}
 *   runtimeConfig={{
 *     auth: { type: 'bearer', token: userContext.apiToken },
 *   }}
 *   exclude={['dangerous_tool']}
 * />
 *
 * // With tool filtering
 * <MCPToolComponent
 *   server="filesystem"
 *   config={{ command: 'npx', args: [...] }}
 *   include={['read_file', 'list_directory']} // Only these tools
 *   toolPrefix="fs_"
 * />
 * ```
 */
class MCPToolComponent extends Component<MCPToolComponentProps> {
  private mcpClient: MCPClient;
  private mcpService: MCPService;
  private baseConfig: MCPConfig;
  private registeredToolNames: string[] = [];

  constructor(public props: MCPToolComponentProps) {
    super(props);

    // Use provided client or create new one
    this.mcpClient = props.mcpClient || new MCPClient();
    this.mcpService = new MCPService(this.mcpClient);

    // Normalize base config
    this.baseConfig = normalizeMCPConfig(props.server, props.config);
  }

  async onMount(com: COM): Promise<void> {
    // Merge base config with runtime config
    const effectiveConfig = mergeMCPConfig(this.baseConfig, this.props.runtimeConfig);

    try {
      // Discover tools from MCP server
      const tools = await this.mcpService.connectAndDiscover(effectiveConfig);

      // Filter tools based on include/exclude
      let filteredTools = tools;

      if (this.props.include && this.props.include.length > 0) {
        // Whitelist: only include specified tools
        filteredTools = tools.filter((t) => this.props.include!.includes(t.name));
      } else if (this.props.exclude && this.props.exclude.length > 0) {
        // Blacklist: exclude specified tools
        filteredTools = tools.filter((t) => !this.props.exclude!.includes(t.name));
      }

      // Register each filtered tool
      for (const mcpToolDef of filteredTools) {
        // Apply tool prefix if specified
        const toolName = this.props.toolPrefix
          ? `${this.props.toolPrefix}${mcpToolDef.name}`
          : mcpToolDef.name;

        // Create tool with prefixed name
        const toolDef = {
          ...mcpToolDef,
          name: toolName,
        };

        this.mcpService.registerMCPTool(effectiveConfig, toolDef, com);
        this.registeredToolNames.push(toolName);
      }

      // Call parent onMount if provided
      if (this.props.onMount) {
        return this.props.onMount(com);
      }
    } catch (error) {
      console.error(`Failed to initialize MCP server "${this.props.server}":`, error);
      // Call parent onMount even on error (for error handling)
      if (this.props.onMount) {
        return this.props.onMount(com);
      }
      throw error;
    }
  }

  async onUnmount(com: COM): Promise<void> {
    // Remove registered tools
    for (const toolName of this.registeredToolNames) {
      com.removeTool(toolName);
    }
    this.registeredToolNames = [];

    // Disconnect MCP client if we created it (not shared)
    if (!this.props.mcpClient) {
      await this.mcpClient.disconnect(this.baseConfig.serverName);
    }

    // Call parent onUnmount if provided
    if (this.props.onUnmount) {
      return this.props.onUnmount(com);
    }
  }

  /**
   * Update runtime configuration (useful for dynamic auth tokens, etc.)
   * This will reconnect and re-register tools with new config.
   */
  async updateRuntimeConfig(com: COM, runtimeConfig: Partial<MCPConfig>): Promise<void> {
    // Remove existing tools
    await this.onUnmount(com);

    // Update runtime config
    this.props.runtimeConfig = runtimeConfig;

    // Re-register with new config
    await this.onMount(com);
  }
}

/**
 * Factory function for creating MCPToolComponent in JSX
 */
export function MCPTool(props: MCPToolComponentProps): JSX.Element {
  return createElement(MCPToolComponent, props);
}

// Export the class
export { MCPToolComponent };
