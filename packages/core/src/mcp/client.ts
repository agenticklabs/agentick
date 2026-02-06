/**
 * MCP Client Service
 *
 * Wraps the official @modelcontextprotocol/sdk Client to manage connections
 * to multiple MCP servers.
 */

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type MCPConfig, type MCPToolDefinition } from "./types";
import { Logger } from "../index";

/**
 * Wrapper around official MCP SDK Client
 * Manages connections to multiple MCP servers
 */
export class MCPClient {
  private logger = Logger.for(this);
  private clients = new Map<string, Client>();
  private tools = new Map<string, MCPToolDefinition[]>(); // refreshed on connect

  /**
   * Connect to an MCP server using the official SDK
   */
  async connect(config: MCPConfig): Promise<Client> {
    const existing = this.getClient(config.serverName);

    if (existing) {
      return existing;
    }

    const client = new Client(
      {
        name: "@tentickle/engine",
        version: "1.0.0",
      },
      {
        // Capabilities are optional - Client will work without explicit capabilities
        // The SDK handles tool discovery automatically
      },
    );

    // Create transport based on config
    const transport = this.createTransport(config);

    // Connect using SDK
    await client.connect(transport);

    // List and cache tools
    await this.listTools(config.serverName);

    client.onclose = () => {
      this.disconnect(config.serverName);
      this.logger.warn({ serverName: config.serverName }, "MCP client disconnected");
    };

    client.onerror = (error) => {
      this.disconnect(config.serverName);
      this.logger.error({ err: error, serverName: config.serverName }, "MCP client error");
    };

    this.clients.set(config.serverName, client);
    return client;
  }

  /**
   * Get an existing client connection
   */
  getClient(serverName: string): Client | undefined {
    return this.clients.get(serverName);
  }

  /**
   * List tools from an MCP server
   */
  async listTools(serverName: string): Promise<MCPToolDefinition[]> {
    const tools = this.tools.get(serverName);
    if (tools) {
      return tools;
    }

    const client = await this.getClient(serverName);
    if (!client) {
      throw new Error(`MCP client not found for server name: ${serverName}`);
    }

    const toolsList = await client.listTools();
    const mcpTools = toolsList.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema as MCPToolDefinition["inputSchema"],
    }));

    this.tools.set(serverName, mcpTools);
    return mcpTools;
  }

  /**
   * Disconnect from an MCP server
   */
  async disconnect(serverName: string): Promise<void> {
    this.clients.delete(serverName);
    this.tools.delete(serverName);
  }

  /**
   * Disconnect from all servers
   */
  async disconnectAll(): Promise<void> {
    const promises = Array.from(this.clients.keys()).map((name) => this.disconnect(name));
    await Promise.all(promises);
  }

  /**
   * Call a tool on an MCP server
   */
  async callTool(serverName: string, toolName: string, input: any): Promise<any> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    // Use SDK's callTool method
    const result = await client.callTool({
      name: toolName,
      arguments: input,
    });

    return result;
  }

  /**
   * Create transport based on config
   */
  private createTransport(config: MCPConfig) {
    switch (config.transport) {
      case "stdio":
        if (!config.connection.command) {
          throw new Error("Stdio transport requires command in connection config");
        }
        return new StdioClientTransport({
          command: config.connection.command,
          args: config.connection.args || [],
        });

      case "sse":
        if (!config.connection.url) {
          throw new Error("SSE transport requires url in connection config");
        }
        return new SSEClientTransport(new URL(config.connection.url));

      case "websocket":
        // Use Streamable HTTP (modern replacement for WebSocket)
        if (!config.connection.url) {
          throw new Error("Streamable HTTP transport requires url in connection config");
        }
        return new StreamableHTTPClientTransport(new URL(config.connection.url));

      default:
        throw new Error(`Unsupported MCP transport: ${config.transport}`);
    }
  }
}
