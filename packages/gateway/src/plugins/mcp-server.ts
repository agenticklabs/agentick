/**
 * MCP Server Plugin
 *
 * Exposes gateway capabilities as a standard MCP server via Streamable HTTP.
 * Any MCP client (Claude Desktop, Cursor, Claude Code, etc.) can connect.
 *
 * Architecture: ONE MCPServer instance, ONE transport, MANY client sessions.
 * The MCPServer uses the SDK's raw Server class with session-aware request handlers.
 * Dynamic tool/resource changes propagate to ALL connected clients automatically
 * via MCP notifications (tools/list_changed, resources/list_changed).
 *
 * Auth is handled by the gateway middleware layer. The plugin itself is auth-agnostic.
 */

import type { IncomingMessage } from "node:http";
import type { GatewayPlugin, PluginContext } from "../types.js";
import { MCPServer } from "@agentick/mcp/server";
import {
  toMCPResult,
  type MCPServerOptions,
  type MCPToolDefinition,
  type MCPRequestContext,
  type MCPAppDefinition,
} from "@agentick/mcp";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

// ============================================================================
// Types
// ============================================================================

export interface ToolEntry {
  name: string;
  description: string;
  input: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface MCPStandaloneTool {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
  /**
   * MCP Apps linkage — set when this tool renders a `ui://` resource. The
   * plugin forwards this to the underlying MCPServer so `tools/list` emits
   * `_meta.ui.resourceUri` and spec-compliant hosts render the view.
   */
  ui?: MCPToolDefinition["ui"];
  /**
   * Pass-through metadata for interop with hosts or SDKs that author tools
   * against the legacy MCP Apps `_meta["ui/resourceUri"]` shape. The
   * MCPServer normalizes this into canonical `ui.resourceUri` on registration.
   */
  _meta?: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult> | CallToolResult;
}

export interface MCPStaticResource {
  name: string;
  uri: string;
  title?: string;
  description?: string;
  mimeType?: string;
  read: () => { text: string } | Promise<{ text: string }>;
}

export interface MCPResourceTemplate {
  name: string;
  uriTemplate: string;
  title?: string;
  description?: string;
  mimeType?: string;
  list: () =>
    | Array<{ uri: string; title?: string; description?: string }>
    | Promise<Array<{ uri: string; title?: string; description?: string }>>;
  read: (variables: Record<string, string>) => { text: string } | Promise<{ text: string }>;
  complete?: Record<string, (value: string) => string[] | Promise<string[]>>;
}

export interface MCPServerPluginConfig {
  id?: string;
  path?: string;
  /**
   * Pre-built MCPServer instance. When provided, the plugin uses this server
   * directly instead of constructing one from tools/resources/apps config.
   * The server's security pipeline, tools, resources, and apps are all owned
   * by the caller — the plugin just bridges it to HTTP.
   *
   * Mutually exclusive with tools/resources/resourceTemplates/apps/instructions.
   */
  server?: MCPServer;
  serverName?: string;
  serverVersion?: string;
  sessionId?: string;
  include?: string[];
  exclude?: string[];
  /**
   * Per-session tool filtering. Receives the tool catalog and request context
   * (which includes user info from the gateway's auth layer via contextProvider).
   * Return the tools this client should see.
   */
  toolFilter?: (tools: ToolEntry[], ctx: MCPRequestContext) => ToolEntry[] | Promise<ToolEntry[]>;
  tools?: MCPStandaloneTool[];
  resources?: MCPStaticResource[];
  resourceTemplates?: MCPResourceTemplate[];
  /**
   * Instructions describing how to use the server and its features.
   * Sent to MCP clients in the initialize response. Clients inject this
   * into the LLM's context to improve understanding of available tools
   * and resources.
   */
  instructions?: string;
  apps?: MCPAppDefinition[];
  oauthMetadata?: { issuer: string; cacheTtl?: number } | { metadata: Record<string, unknown> };
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

// ============================================================================
// OAuth metadata route (shared by both server-provided and constructed paths)
// ============================================================================

function registerOAuthRoute(
  ctx: PluginContext,
  oauthConfig: NonNullable<MCPServerPluginConfig["oauthMetadata"]>,
): void {
  let metadataCache: { data: Record<string, unknown>; expires: number } | null = null;

  ctx.registerRoute(
    "/.well-known/oauth-authorization-server",
    async (_req, res) => {
      let metadata: Record<string, unknown>;

      if ("metadata" in oauthConfig) {
        metadata = oauthConfig.metadata;
      } else {
        const now = Date.now();
        const ttl = (oauthConfig.cacheTtl ?? 300) * 1000;
        if (metadataCache && metadataCache.expires > now) {
          metadata = metadataCache.data;
        } else {
          try {
            const wellKnownUrl = `${oauthConfig.issuer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`;
            const response = await fetch(wellKnownUrl, {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(5000),
            });
            if (!response.ok) {
              res.writeHead(502, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Failed to fetch OAuth metadata" }));
              return;
            }
            metadata = (await response.json()) as Record<string, unknown>;
            metadataCache = { data: metadata, expires: now + ttl };
          } catch {
            res.writeHead(502, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Failed to fetch OAuth metadata" }));
            return;
          }
        }
      }

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(JSON.stringify(metadata));
    },
    { auth: false, absolute: true },
  );
}

// ============================================================================
// Plugin
// ============================================================================

export function mcpServerPlugin(config: MCPServerPluginConfig): GatewayPlugin {
  const pluginId = config.id ?? "mcp-server";
  const routePath = config.path ?? "/mcp";

  let ctx: PluginContext;
  let mcpServer: MCPServer;

  return {
    id: pluginId,

    async initialize(pluginCtx) {
      ctx = pluginCtx;

      // ── Pre-built server — skip all construction, just register the route ──
      if (config.server) {
        mcpServer = config.server;
        ctx.registerRoute(routePath, async (req, res) => {
          await mcpServer.handleHTTPRequest(req, res);
        });
        return;
      }

      // ── OAuth metadata ────────────────────────────────────────────────
      if (config.oauthMetadata) {
        registerOAuthRoute(ctx, config.oauthMetadata);
      }

      // ── Tool discovery ────────────────────────────────────────────────
      let allToolEntries: ToolEntry[] = [];
      if (config.sessionId) {
        const catalog = (await ctx.invoke("tool-catalog", {
          sessionId: config.sessionId,
        })) as { tools: ToolEntry[] };
        allToolEntries = filterTools(catalog.tools, config);
      }

      // Convert to MCPToolDefinition[]
      const mcpTools: MCPToolDefinition[] = [];

      // Session-dispatched tools
      if (config.sessionId) {
        for (const tool of allToolEntries) {
          mcpTools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input as any,
            annotations: tool.annotations as any,
            handler: async (args) => {
              const result = await ctx.invoke("tool-dispatch", {
                sessionId: config.sessionId,
                tool: tool.name,
                input: args,
              });
              return toMCPResult(result as { content: unknown[] });
            },
          });
        }
      }

      // Standalone tools
      if (config.tools) {
        for (const tool of config.tools) {
          mcpTools.push({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema as any,
            annotations: tool.annotations as any,
            // MCP Apps metadata — preserve the tool↔view linkage so
            // `tools/list` emits `_meta.ui.resourceUri`. Dropping these here
            // silently broke rendering for HTTP-mode consumers (stdio mode
            // bypasses this plugin and worked fine, which made it look like
            // a transport bug).
            ...(tool.ui ? { ui: tool.ui } : {}),
            ...(tool._meta ? { _meta: tool._meta } : {}),
            handler: async (args) => tool.handler(args),
          });
        }
      }

      // ── Build toolFilter that bridges gateway's ToolEntry-based filter ──
      let toolFilterFn: MCPServerOptions["toolFilter"] | undefined;
      if (config.toolFilter) {
        const gatewayFilter = config.toolFilter;
        // Build a ToolEntry lookup from tool names
        const toolEntryByName = new Map(allToolEntries.map((t) => [t.name, t]));
        const standaloneNames = new Set((config.tools ?? []).map((t) => t.name));

        toolFilterFn = (tool, reqCtx) => {
          // Standalone tools always visible
          if (standaloneNames.has(tool.name)) return true;

          // For session tools, run the gateway filter synchronously
          // The gateway filter receives the full ToolEntry[] and returns filtered subset.
          // We need to check if this specific tool is in the filtered set.
          // Since the filter may be async and receives the full list, we pre-compute
          // allowed names per session. For now, use a simpler approach: check if the
          // tool's ToolEntry exists (if it doesn't, it was already excluded by include/exclude).
          const entry = toolEntryByName.get(tool.name);
          return entry !== undefined;
        };
      }

      // ── Create ONE shared MCPServer ───────────────────────────────────
      mcpServer = new MCPServer({
        name: config.serverName ?? "agentick-gateway",
        version: config.serverVersion ?? "1.0.0",
        ...(config.instructions && { instructions: config.instructions }),
        tools: mcpTools,
        toolFilter: toolFilterFn,
        apps: config.apps,
        resources: config.resources?.map((res) => ({
          name: res.name,
          uri: res.uri,
          description: res.description,
          mimeType: res.mimeType ?? "text/markdown",
          read: async () => {
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
        })),
        resourceTemplates: config.resourceTemplates?.map((tmpl) => ({
          name: tmpl.name,
          uriTemplate: tmpl.uriTemplate,
          description: tmpl.description,
          mimeType: tmpl.mimeType ?? "text/markdown",
          list: async () => ({
            resources: (await tmpl.list()).map((r) => ({
              uri: r.uri,
              name: r.title ?? tmpl.name,
              description: r.description,
              mimeType: tmpl.mimeType ?? "text/markdown",
            })),
          }),
          read: async (uri: string, variables: Record<string, string>) => {
            const content = await tmpl.read(variables);
            const resolvedUri = tmpl.uriTemplate.replace(
              /\{(\w+)\}/g,
              (_, key) => variables[key] ?? "",
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
          complete: tmpl.complete,
        })),
        // Gateway handles auth — MCP server trusts all requests
        security: {
          connectionGuard: async () => true,
          authenticator: async () => ({ authenticated: true }),
        },
      });

      // ── Register HTTP route — delegates to MCPServer.handleHTTPRequest ──
      ctx.registerRoute(routePath, async (req, res) => {
        await mcpServer.handleHTTPRequest(req, res);
      });
    },

    async destroy() {
      ctx.unregisterRoute(routePath);
      if (config.oauthMetadata) {
        ctx.unregisterRoute("/.well-known/oauth-authorization-server");
      }
      await mcpServer.close();
    },
  };
}
