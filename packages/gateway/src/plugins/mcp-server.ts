/**
 * MCP Server Plugin
 *
 * Exposes session tools as a standard MCP server via Streamable HTTP.
 * Any MCP client (Claude Desktop, Cursor, etc.) can connect and call tools.
 *
 * Two modes:
 * - Static (default): Single McpServer, tools frozen at init. Zero overhead.
 * - Per-session (with `toolFilter`): Each MCP client handshake creates its own
 *   McpServer with tools filtered by a user-provided callback.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage } from "node:http";
import type { GatewayPlugin, PluginContext } from "../types.js";

export interface ToolEntry {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

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
  /**
   * Filter tools per MCP session. Called once when a client initializes.
   * Receives the pre-filtered tool catalog and the raw HTTP request.
   * Return the tools to expose for this session.
   */
  toolFilter?: (tools: ToolEntry[], req: IncomingMessage) => ToolEntry[] | Promise<ToolEntry[]>;
}

export function filterTools(
  tools: ToolEntry[],
  config: Pick<MCPServerPluginConfig, "include" | "exclude">,
): ToolEntry[] {
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
      return { type: "text" as const, text: JSON.stringify(block) };
    }),
  };
}

function createMcpServerWithTools(
  tools: ToolEntry[],
  ctx: PluginContext,
  sessionId: string,
): McpServer {
  const server = new McpServer(
    { name: "agentick-gateway", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.input as any,
      },
      async (args: Record<string, unknown>) => {
        const result = await ctx.invoke("tool-dispatch", {
          sessionId,
          tool: tool.name,
          input: args,
        });
        return toMCPResult(result as { content: unknown[] });
      },
    );
  }

  return server;
}

// ============================================================================
// Per-session mode — each MCP client gets its own McpServer with filtered tools
// ============================================================================

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export function mcpServerPlugin(config: MCPServerPluginConfig): GatewayPlugin {
  const pluginId = config.id ?? "mcp-server";
  const routePath = config.path ?? "/mcp";

  // Static mode state
  let staticServer: McpServer | undefined;

  // Per-session mode state
  const sessions = new Map<string, McpSession>();

  let ctx: PluginContext;

  return {
    id: pluginId,

    async initialize(pluginCtx) {
      ctx = pluginCtx;

      // Discover tools from the configured session
      const catalog = (await ctx.invoke("tool-catalog", {
        sessionId: config.sessionId,
      })) as { tools: ToolEntry[] };
      const allTools = filterTools(catalog.tools, config);

      if (config.toolFilter) {
        // Per-session mode: route handler creates McpServer per client
        const toolFilter = config.toolFilter;

        ctx.registerRoute(routePath, async (req, res) => {
          const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;

          if (mcpSessionId) {
            // Existing session — delegate to its transport
            const session = sessions.get(mcpSessionId);
            if (!session) {
              res.writeHead(404, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  error: { code: -32001, message: "Session not found" },
                }),
              );
              return;
            }
            return session.transport.handleRequest(req, res);
          }

          // New session — filter tools and create a dedicated McpServer
          const filtered = await toolFilter(allTools, req);
          const server = createMcpServerWithTools(filtered, ctx, config.sessionId);

          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              sessions.set(id, { server, transport });
            },
            onsessionclosed: (id) => {
              sessions.delete(id);
            },
          });

          await server.connect(transport);
          return transport.handleRequest(req, res);
        });
      } else {
        // Static mode: single McpServer, stateless transport
        staticServer = createMcpServerWithTools(allTools, ctx, config.sessionId);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        await staticServer.connect(transport);

        ctx.registerRoute(routePath, (req, res) => transport.handleRequest(req, res));
      }
    },

    async destroy() {
      ctx.unregisterRoute(routePath);

      if (staticServer) {
        await staticServer.close();
      }

      // Close all per-session servers
      const closePromises = [...sessions.values()].map((s) => s.server.close());
      await Promise.all(closePromises);
      sessions.clear();
    },
  };
}
