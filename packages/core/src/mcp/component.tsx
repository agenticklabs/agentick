/**
 * MCP Tool Component
 *
 * A component that connects to an MCP server and registers its tools.
 * Supports runtime configuration (auth tokens, etc.) and tool filtering.
 */

import React, { useEffect, useRef } from "react";
import type { EngineComponent } from "../component/component";
import { MCPClient } from "./client";
import { MCPService } from "./service";
import type { MCPConfig, MCPServerConfig } from "./types";
import type { JSX } from "../jsx/jsx-runtime";
import type { ComponentBaseProps } from "../jsx/jsx-types";
import { useCom } from "../hooks";

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
export function MCPToolComponent(props: MCPToolComponentProps): React.ReactElement | null {
  const ctx = useCom();

  // Refs for managing state across renders
  const mcpClientRef = useRef<MCPClient | null>(null);
  const mcpServiceRef = useRef<MCPService | null>(null);
  const registeredToolNamesRef = useRef<string[]>([]);
  const hasInitializedRef = useRef(false);

  // Initialize refs on first render
  if (!mcpClientRef.current) {
    mcpClientRef.current = props.mcpClient || new MCPClient();
    mcpServiceRef.current = new MCPService(mcpClientRef.current);
  }

  // Mount/unmount effect
  useEffect(() => {
    if (hasInitializedRef.current) {
      return;
    }
    hasInitializedRef.current = true;

    const baseConfig = normalizeMCPConfig(props.server, props.config);
    const effectiveConfig = mergeMCPConfig(baseConfig, props.runtimeConfig);
    const mcpClient = mcpClientRef.current!;
    const mcpService = mcpServiceRef.current!;

    const initMCP = async () => {
      try {
        // Discover tools from MCP server
        const tools = await mcpService.connectAndDiscover(effectiveConfig);

        // Filter tools based on include/exclude
        let filteredTools = tools;

        if (props.include && props.include.length > 0) {
          // Whitelist: only include specified tools
          filteredTools = tools.filter((t) => props.include!.includes(t.name));
        } else if (props.exclude && props.exclude.length > 0) {
          // Blacklist: exclude specified tools
          filteredTools = tools.filter((t) => !props.exclude!.includes(t.name));
        }

        // Register each filtered tool
        for (const mcpToolDef of filteredTools) {
          // Apply tool prefix if specified
          const toolName = props.toolPrefix
            ? `${props.toolPrefix}${mcpToolDef.name}`
            : mcpToolDef.name;

          // Create tool with prefixed name
          const toolDef = {
            ...mcpToolDef,
            name: toolName,
          };

          mcpService.registerMCPTool(effectiveConfig, toolDef, ctx);
          registeredToolNamesRef.current.push(toolName);
        }

        // Call onMount callback if provided
        if (props.onMount) {
          await props.onMount(ctx);
        }
      } catch (error) {
        console.error(`Failed to initialize MCP server "${props.server}":`, error);
        // Call onMount even on error (for error handling)
        if (props.onMount) {
          await props.onMount(ctx);
        }
      }
    };

    initMCP();

    // Cleanup on unmount
    return () => {
      // Remove registered tools
      for (const toolName of registeredToolNamesRef.current) {
        ctx.removeTool(toolName);
      }
      registeredToolNamesRef.current = [];

      // Disconnect MCP client if we created it (not shared)
      if (!props.mcpClient && mcpClient) {
        mcpClient.disconnect(baseConfig.serverName);
      }

      // Call onUnmount callback if provided
      if (props.onUnmount) {
        props.onUnmount(ctx);
      }
    };
  }, [
    ctx,
    props.server,
    props.config,
    props.runtimeConfig,
    props.include,
    props.exclude,
    props.toolPrefix,
    props.mcpClient,
    props.onMount,
    props.onUnmount,
  ]);

  // MCP components don't render anything
  return null;
}

/**
 * Factory function for creating MCPToolComponent in JSX
 */
export function MCPTool(props: MCPToolComponentProps): JSX.Element {
  return React.createElement(MCPToolComponent, props) as unknown as JSX.Element;
}
