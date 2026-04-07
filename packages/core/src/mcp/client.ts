/**
 * MCP Client
 *
 * Wraps the official @modelcontextprotocol/sdk Client to manage connections
 * to multiple MCP servers. Supports tool discovery/execution and resource
 * discovery/reading.
 */

import { Client } from "@modelcontextprotocol/sdk/client";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  type MCPConfig,
  type MCPToolDefinition,
  type MCPResource,
  type MCPResourceTemplate,
  type MCPResourceContent,
} from "./types.js";
import { Logger } from "../index.js";

/**
 * Wrapper around official MCP SDK Client.
 * Manages connections to multiple MCP servers and provides
 * unified access to tools and resources.
 */
export class MCPClient {
  private logger = Logger.for(this);
  private clients = new Map<string, Client>();
  private tools = new Map<string, MCPToolDefinition[]>();
  private resources = new Map<string, MCPResource[]>();
  private resourceTemplates = new Map<string, MCPResourceTemplate[]>();

  // ── Connection ──────────────────────────────────────────────────────

  async connect(config: MCPConfig): Promise<Client> {
    const existing = this.getClient(config.serverName);
    if (existing) {
      return existing;
    }

    const client = new Client({ name: "@agentick/engine", version: "1.0.0" }, {});

    const transport = this.createTransport(config);
    await client.connect(transport);

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

  getClient(serverName: string): Client | undefined {
    return this.clients.get(serverName);
  }

  async disconnect(serverName: string): Promise<void> {
    this.clients.delete(serverName);
    this.tools.delete(serverName);
    this.resources.delete(serverName);
    this.resourceTemplates.delete(serverName);
  }

  async disconnectAll(): Promise<void> {
    const names = Array.from(this.clients.keys());
    await Promise.all(names.map((name) => this.disconnect(name)));
  }

  // ── Tools ───────────────────────────────────────────────────────────

  async listTools(serverName: string): Promise<MCPToolDefinition[]> {
    const cached = this.tools.get(serverName);
    if (cached) return cached;

    const client = this.requireClient(serverName);
    const response = await client.listTools();

    const mcpTools = response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      inputSchema: tool.inputSchema as MCPToolDefinition["inputSchema"],
    }));

    this.tools.set(serverName, mcpTools);
    return mcpTools;
  }

  async callTool(serverName: string, toolName: string, input: any): Promise<any> {
    const client = this.requireClient(serverName);
    return await client.callTool({ name: toolName, arguments: input });
  }

  // ── Resources ───────────────────────────────────────────────────────

  /**
   * Discover resources from a single server.
   * Results are cached — call `invalidateResources` to force refresh.
   */
  async listResources(serverName: string): Promise<MCPResource[]> {
    const cached = this.resources.get(serverName);
    if (cached) return cached;

    const client = this.requireClient(serverName);
    const response = await client.listResources();

    const resources: MCPResource[] = response.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
      serverName,
    }));

    this.resources.set(serverName, resources);
    return resources;
  }

  /**
   * Discover resource templates from a single server.
   * Templates have parameterized URIs like `db://schema/{table}`.
   */
  async listResourceTemplates(serverName: string): Promise<MCPResourceTemplate[]> {
    const cached = this.resourceTemplates.get(serverName);
    if (cached) return cached;

    const client = this.requireClient(serverName);
    const response = await client.listResourceTemplates();

    const templates: MCPResourceTemplate[] = response.resourceTemplates.map((t) => ({
      uriTemplate: t.uriTemplate,
      name: t.name,
      description: t.description,
      mimeType: t.mimeType,
      serverName,
    }));

    this.resourceTemplates.set(serverName, templates);
    return templates;
  }

  /**
   * Read a resource by URI from a specific server.
   */
  async readResource(serverName: string, uri: string): Promise<MCPResourceContent[]> {
    const client = this.requireClient(serverName);
    const response = await client.readResource({ uri });

    return response.contents.map((c) => ({
      uri: c.uri,
      text: "text" in c ? c.text : undefined,
      blob: "blob" in c ? c.blob : undefined,
      mimeType: c.mimeType,
    }));
  }

  /**
   * Clear cached resources for a server (or all servers).
   * Next `listResources` / `listResourceTemplates` call will re-fetch.
   */
  invalidateResources(serverName?: string): void {
    if (serverName) {
      this.resources.delete(serverName);
      this.resourceTemplates.delete(serverName);
    } else {
      this.resources.clear();
      this.resourceTemplates.clear();
    }
  }

  // ── Aggregate queries ───────────────────────────────────────────────

  /**
   * List resources across all connected servers.
   */
  async listAllResources(): Promise<MCPResource[]> {
    const names = Array.from(this.clients.keys());
    const results = await Promise.all(names.map((name) => this.listResources(name)));
    return results.flat();
  }

  /**
   * List resource templates across all connected servers.
   */
  async listAllResourceTemplates(): Promise<MCPResourceTemplate[]> {
    const names = Array.from(this.clients.keys());
    const results = await Promise.all(names.map((name) => this.listResourceTemplates(name)));
    return results.flat();
  }

  /**
   * Read a resource by URI, routing to the correct server.
   * Looks up which server owns the URI from cached resource listings.
   * Throws if the URI isn't found in any server's resources.
   */
  async readResourceByURI(uri: string): Promise<MCPResourceContent[]> {
    // Check cached resources for a direct URI match
    for (const [serverName, resources] of this.resources) {
      if (resources.some((r) => r.uri === uri)) {
        return this.readResource(serverName, uri);
      }
    }

    // Check templates — a URI like `db://schema/users` might match
    // template `db://schema/{table}`. Try each server that has templates.
    for (const [serverName, templates] of this.resourceTemplates) {
      if (templates.some((t) => uriMatchesTemplate(uri, t.uriTemplate))) {
        return this.readResource(serverName, uri);
      }
    }

    throw new Error(
      `No MCP server found for resource URI: ${uri}. ` +
        `Known servers: ${Array.from(this.clients.keys()).join(", ")}`,
    );
  }

  // ── Internal ────────────────────────────────────────────────────────

  private requireClient(serverName: string): Client {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }
    return client;
  }

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
        if (!config.connection.url) {
          throw new Error("Streamable HTTP transport requires url in connection config");
        }
        return new StreamableHTTPClientTransport(new URL(config.connection.url));

      default:
        throw new Error(`Unsupported MCP transport: ${config.transport}`);
    }
  }
}

// ============================================================================
// URI Template Matching
// ============================================================================

/**
 * Check if a concrete URI matches an RFC 6570 Level 1 template.
 * Example: "db://schema/users" matches "db://schema/{table}"
 */
export function uriMatchesTemplate(uri: string, template: string): boolean {
  // Convert template to regex: replace {param} with a non-greedy capture
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, (ch) => {
    // Don't escape { and } — we handle them below
    if (ch === "{" || ch === "}") return ch;
    return `\\${ch}`;
  });
  const pattern = escaped.replace(/\{[^}]+\}/g, "([^/]+)");

  try {
    return new RegExp(`^${pattern}$`).test(uri);
  } catch {
    return false;
  }
}
