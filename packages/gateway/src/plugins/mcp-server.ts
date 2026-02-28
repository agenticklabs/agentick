/**
 * MCP Server Plugin
 *
 * Exposes session tools as a standard MCP server via Streamable HTTP.
 * Any MCP client (Claude Desktop, Cursor, etc.) can connect and call tools.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GatewayPlugin, PluginContext } from "../types.js";

export interface MCPServerPluginConfig {
  /** Plugin ID (default: "mcp-server") */
  id?: string;
  /** Route path (default: "/mcp") */
  path?: string;
  /** Session whose tools to expose */
  sessionId: string;
  /** Only expose tools matching these names */
  include?: string[];
  /** Exclude tools matching these names */
  exclude?: string[];
}

interface ToolEntry {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

function filterTools(tools: ToolEntry[], config: MCPServerPluginConfig): ToolEntry[] {
  let filtered = tools;
  if (config.include?.length) {
    const set = new Set(config.include);
    filtered = filtered.filter((t) => set.has(t.name));
  }
  if (config.exclude?.length) {
    const set = new Set(config.exclude);
    filtered = filtered.filter((t) => !set.has(t.name));
  }
  return filtered;
}

function toMCPResult(result: { content: unknown[] }): CallToolResult {
  return {
    content: result.content.map((block) => {
      const b = block as Record<string, unknown>;
      if (b.type === "text") return { type: "text" as const, text: String(b.text ?? "") };
      if (b.type === "image") {
        return {
          type: "image" as const,
          data: String(b.data ?? ""),
          mimeType: String(b.mediaType ?? "image/png"),
        };
      }
      // Fallback: serialize as text
      return { type: "text" as const, text: JSON.stringify(block) };
    }),
  };
}

export function mcpServerPlugin(config: MCPServerPluginConfig): GatewayPlugin {
  const pluginId = config.id ?? "mcp-server";
  const routePath = config.path ?? "/mcp";

  let ctx: PluginContext;
  let mcpServer: McpServer;
  let transport: StreamableHTTPServerTransport;

  return {
    id: pluginId,

    async initialize(pluginCtx) {
      ctx = pluginCtx;

      // 1. Create MCP server
      mcpServer = new McpServer(
        { name: "agentick-gateway", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );

      // 2. Discover tools from the configured session
      const catalog = (await ctx.invoke("tool-catalog", {
        sessionId: config.sessionId,
      })) as { tools: ToolEntry[] };
      const tools = filterTools(catalog.tools, config);

      // 3. Register each tool on the MCP server
      for (const tool of tools) {
        mcpServer.registerTool(tool.name, {
          description: tool.description,
          // MCP SDK expects a Zod-derived JSON Schema type; our Record<string, unknown> is wire-equivalent
          inputSchema: tool.input as any,
        }, async (args: Record<string, unknown>) => {
          const result = await ctx.invoke("tool-dispatch", {
            sessionId: config.sessionId,
            tool: tool.name,
            input: args,
          });
          return toMCPResult(result as { content: unknown[] });
        });
      }

      // 4. Create transport and mount route
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless — tools are shared
      });
      await mcpServer.connect(transport);

      ctx.registerRoute(routePath, (req, res) => transport.handleRequest(req, res));
    },

    async destroy() {
      ctx.unregisterRoute(routePath);
      await mcpServer.close();
    },
  };
}
