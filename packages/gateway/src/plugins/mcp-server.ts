/**
 * MCP Server Plugin
 *
 * Exposes gateway capabilities as a standard MCP server via Streamable HTTP.
 * Any MCP client (Claude Desktop, Cursor, Claude Code, etc.) can connect and
 * use tools and resources.
 *
 * Three modes:
 * - Resources-only: No sessionId — serves MCP resources without tools.
 * - Static tools (default with sessionId): Single McpServer, tools frozen at init.
 * - Per-session tools (with `toolFilter`): Each MCP client handshake creates its
 *   own McpServer with tools filtered by a user-provided callback.
 *
 * Auth is handled by the gateway — the plugin itself is auth-agnostic. The
 * gateway's 401 response includes `WWW-Authenticate: Bearer` per RFC 6750,
 * which triggers MCP clients' OAuth discovery flow.
 *
 * Body parsing: when running behind Express or middleware that pre-parses
 * request bodies, `req.body` is passed to the MCP transport automatically.
 * This prevents stream-already-consumed issues.
 */

import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { IncomingMessage } from "node:http";
import type { GatewayPlugin, PluginContext } from "../types.js";

// ============================================================================
// Types
// ============================================================================

export interface ToolEntry {
  name: string;
  description: string;
  input: Record<string, unknown>;
  /** MCP tool annotations (readOnlyHint, destructiveHint, openWorldHint) */
  annotations?: Record<string, unknown>;
}

/** Static MCP resource — fixed URI, returns content when read. */
export interface MCPStaticResource {
  name: string;
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
  read: () => { text: string } | Promise<{ text: string }>;
}

/** Templated MCP resource — parameterized URI, lists instances and reads by variable. */
export interface MCPResourceTemplate {
  name: string;
  uriTemplate: string;
  title?: string;
  description?: string;
  mimeType?: string;
  /** List all available instances of this template. */
  list: () =>
    | Array<{ uri: string; title?: string; description?: string }>
    | Promise<Array<{ uri: string; title?: string; description?: string }>>;
  /** Read a specific instance by its resolved variables. */
  read: (variables: Record<string, string>) => { text: string } | Promise<{ text: string }>;
  /** Optional autocomplete for template variables. */
  complete?: Record<string, (value: string) => string[] | Promise<string[]>>;
}

export interface MCPServerPluginConfig {
  /** Plugin ID (default: "mcp-server") */
  id?: string;
  /** Route path (default: "/mcp") */
  path?: string;
  /** MCP server name (default: "agentick-gateway") */
  serverName?: string;
  /** MCP server version (default: "1.0.0") */
  serverVersion?: string;
  /**
   * Session whose tools to expose. Optional — omit for resources-only mode.
   */
  sessionId?: string;
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
  /** Static MCP resources to register. */
  resources?: MCPStaticResource[];
  /** Templated MCP resources to register. */
  resourceTemplates?: MCPResourceTemplate[];
}

// ============================================================================
// Helpers
// ============================================================================

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

// ============================================================================
// Server builder
// ============================================================================

function registerResources(server: McpServer, config: MCPServerPluginConfig): void {
  // Static resources
  if (config.resources) {
    for (const res of config.resources) {
      server.registerResource(
        res.name,
        res.uri,
        {
          title: res.title,
          description: res.description,
          mimeType: res.mimeType ?? "text/markdown",
        },
        async () => {
          const content = await res.read();
          return {
            contents: [
              {
                uri: res.uri,
                mimeType: res.mimeType ?? "text/markdown",
                text: content.text,
              },
            ],
          };
        },
      );
    }
  }

  // Resource templates
  if (config.resourceTemplates) {
    for (const tmpl of config.resourceTemplates) {
      server.registerResource(
        tmpl.name,
        new ResourceTemplate(tmpl.uriTemplate, {
          list: async () => ({
            resources: (await tmpl.list()).map((r) => ({
              uri: r.uri,
              name: r.title ?? tmpl.name,
              title: r.title,
              description: r.description,
              mimeType: tmpl.mimeType ?? "text/markdown",
            })),
          }),
          complete: tmpl.complete,
        }),
        {
          title: tmpl.title,
          description: tmpl.description,
          mimeType: tmpl.mimeType ?? "text/markdown",
        },
        async (_uri, variables) => {
          const content = await tmpl.read(variables as Record<string, string>);
          const resolvedUri = tmpl.uriTemplate.replace(
            /\{(\w+)\}/g,
            (_, key) => (variables as Record<string, string>)[key] ?? "",
          );
          return {
            contents: [
              {
                uri: resolvedUri,
                mimeType: tmpl.mimeType ?? "text/markdown",
                text: content.text,
              },
            ],
          };
        },
      );
    }
  }
}

function createMcpServer(
  config: MCPServerPluginConfig,
  tools: ToolEntry[],
  ctx: PluginContext,
): McpServer {
  const capabilities: Record<string, Record<string, unknown>> = {};
  if (tools.length > 0) capabilities.tools = {};
  if (config.resources?.length || config.resourceTemplates?.length) {
    capabilities.resources = {};
  }

  const server = new McpServer(
    {
      name: config.serverName ?? "agentick-gateway",
      version: config.serverVersion ?? "1.0.0",
    },
    { capabilities },
  );

  // Register tools (only if sessionId is configured)
  if (config.sessionId) {
    for (const tool of tools) {
      server.registerTool(
        tool.name,
        {
          description: tool.description,
          inputSchema: tool.input as any,
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
        },
        async (args: Record<string, unknown>) => {
          const result = await ctx.invoke("tool-dispatch", {
            sessionId: config.sessionId,
            tool: tool.name,
            input: args,
          });
          return toMCPResult(result as { content: unknown[] });
        },
      );
    }
  }

  // Register resources
  registerResources(server, config);

  return server;
}

// ============================================================================
// Plugin
// ============================================================================

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export function mcpServerPlugin(config: MCPServerPluginConfig): GatewayPlugin {
  const pluginId = config.id ?? "mcp-server";
  const routePath = config.path ?? "/mcp";
  // Per-session mode state
  const sessions = new Map<string, McpSession>();

  let ctx: PluginContext;

  return {
    id: pluginId,

    async initialize(pluginCtx) {
      ctx = pluginCtx;

      // Discover tools from the configured session (if any)
      let allTools: ToolEntry[] = [];
      if (config.sessionId) {
        const catalog = (await ctx.invoke("tool-catalog", {
          sessionId: config.sessionId,
        })) as { tools: ToolEntry[] };
        allTools = filterTools(catalog.tools, config);
      }

      if (config.toolFilter && config.sessionId) {
        // Per-session mode: route handler creates McpServer per client
        const toolFilter = config.toolFilter;

        ctx.registerRoute(routePath, async (req, res) => {
          const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;

          if (mcpSessionId) {
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
            return session.transport.handleRequest(req, res, (req as any).body);
          }

          // New session — filter tools and create a dedicated McpServer
          const filtered = await toolFilter(allTools, req);
          const server = createMcpServer(config, filtered, ctx);

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
          return transport.handleRequest(req, res, (req as any).body);
        });
      } else {
        // Static mode: single McpServer
        const server = createMcpServer(config, allTools, ctx);

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await server.connect(transport);

        ctx.registerRoute(routePath, (req, res) =>
          // Pass pre-parsed body — upstream middleware (Express body-parser)
          // may have already consumed the request stream.
          transport.handleRequest(req, res, (req as any).body),
        );
      }
    },

    async destroy() {
      ctx.unregisterRoute(routePath);

      const closePromises = [...sessions.values()].map((s) => s.server.close());
      await Promise.all(closePromises);
      sessions.clear();
    },
  };
}
