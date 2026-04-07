/**
 * Unified MCP Component
 *
 * Single component that connects to MCP servers and provides both
 * tools and resources. This is the only MCP component users should use.
 *
 * ```tsx
 * <MCP servers={{
 *   postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", connStr] },
 *   filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"] },
 * }} />
 * ```
 *
 * Tools: each server's tools are registered individually.
 * Resources: unified `list_resources` + `read_resource` across all servers.
 */

import React, { useRef } from "react";
import { MCPClient } from "./client.js";
import { MCPToolComponent } from "./component.js";
import { MCPResourceComponent } from "./resource-component.js";
import type { MCPConfig, MCPServerConfig } from "./types.js";
import type { JSX } from "../jsx/jsx-runtime.js";
import type { ComponentBaseProps } from "../jsx/jsx-types.js";
import type { EngineComponent } from "../component/component.js";

// ============================================================================
// Types
// ============================================================================

export interface MCPComponentProps extends ComponentBaseProps, Partial<EngineComponent> {
  /**
   * MCP servers to connect to.
   *
   * Map of server name → config. Supports Cursor-style or full MCPConfig.
   */
  servers: Record<string, MCPServerConfig | MCPConfig>;

  /**
   * Tool filtering per server.
   * Key is server name, value is include/exclude lists.
   */
  toolFilter?: Record<
    string,
    {
      include?: string[];
      exclude?: string[];
      prefix?: string;
    }
  >;

  /**
   * Custom resource tool names.
   */
  listResourcesToolName?: string;
  readResourceToolName?: string;
}

// ============================================================================
// Component
// ============================================================================

export function MCPComponent(props: MCPComponentProps): JSX.Element {
  // Single shared MCPClient — all servers share one client instance
  const clientRef = useRef<MCPClient | null>(null);
  if (!clientRef.current) {
    clientRef.current = new MCPClient();
  }
  const mcpClient = clientRef.current;

  const serverEntries = Object.entries(props.servers);

  return (
    <>
      {serverEntries.map(([name, config]) => {
        const filter = props.toolFilter?.[name];
        return (
          <MCPToolComponent
            key={`mcp-tools-${name}`}
            server={name}
            config={config}
            mcpClient={mcpClient}
            include={filter?.include}
            exclude={filter?.exclude}
            toolPrefix={filter?.prefix}
          />
        );
      })}
      <MCPResourceComponent
        key="mcp-resources"
        servers={props.servers}
        mcpClient={mcpClient}
        listToolName={props.listResourcesToolName}
        readToolName={props.readResourceToolName}
      />
    </>
  ) as unknown as JSX.Element;
}

/**
 * The MCP component. Connects to servers, registers their tools,
 * and provides progressive resource discovery.
 */
export const MCP = MCPComponent;
