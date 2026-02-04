/**
 * MCP Service
 *
 * Manages MCP server connections, tool discovery, and registration.
 * Uses the official @modelcontextprotocol/sdk Client.
 */

import type { Client } from "@modelcontextprotocol/sdk/client";
import type { MCPClient } from "./client";
import { MCPTool } from "./tool";
import type { MCPConfig, MCPToolDefinition } from "./types";
import type { COM } from "../com/object-model";

/**
 * MCP Service handles discovery and registration of MCP tools
 */
export class MCPService {
  constructor(private mcpClient: MCPClient) {}

  async connect(config: MCPConfig): Promise<Client> {
    return await this.mcpClient.connect(config);
  }

  async disconnect(serverName: string): Promise<void> {
    await this.mcpClient.disconnect(serverName);
  }

  async disconnectAll(): Promise<void> {
    await this.mcpClient.disconnectAll();
  }

  /**
   * Connect to an MCP server and discover its tools using SDK
   */
  async connectAndDiscover(config: MCPConfig): Promise<MCPToolDefinition[]> {
    await this.connect(config);

    return await this.listTools(config.serverName);
  }

  /**
   * Discover tools from an MCP server and register them with the COM
   */
  async discoverAndRegister(config: MCPConfig, com: COM): Promise<void> {
    const tools = await this.connectAndDiscover(config);

    for (const mcpToolDef of tools) {
      const tool = new MCPTool(this.mcpClient, config.serverName, mcpToolDef, {
        serverUrl: config.connection.url,
        serverName: config.serverName,
        transport: config.transport,
      });

      await com.addTool(tool);
    }
  }

  async listTools(serverName: string): Promise<MCPToolDefinition[]> {
    return await this.mcpClient.listTools(serverName);
  }

  /**
   * Register a single MCP tool (useful for manual registration)
   */
  async registerMCPTool(config: MCPConfig, mcpToolDef: MCPToolDefinition, com: COM): Promise<void> {
    const tool = new MCPTool(this.mcpClient, config.serverName, mcpToolDef, {
      serverUrl: config.connection.url,
      serverName: config.serverName,
      transport: config.transport,
    });

    await com.addTool(tool);
  }

  /**
   * Disconnect from an MCP server and remove its tools.
   * Finds tools belonging to this server by checking metadata.mcpConfig.serverName.
   */
  async disconnectAndUnregister(serverName: string, com: COM): Promise<void> {
    // Find all tools that belong to this MCP server
    const allTools = com.getTools();
    const toolsToRemove = allTools
      .filter((tool) => tool.metadata.mcpConfig?.serverName === serverName)
      .map((tool) => tool.metadata.name);

    // Remove each tool from the COM
    for (const toolName of toolsToRemove) {
      com.removeTool(toolName);
    }

    await this.disconnect(serverName);
  }
}
