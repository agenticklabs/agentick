/**
 * MCP Client — Full-featured MCP client for connecting to MCP servers.
 *
 * Capabilities:
 * - Multi-server connection management with health tracking
 * - Tools: list, call, cache, auto-invalidation on list_changed
 * - Resources: list, templates, read, URI routing, cache, auto-invalidation
 * - Prompts: list, get, cache, auto-invalidation on list_changed
 * - Progress: progressToken in tool calls, progress notifications
 * - Sampling: handle server createMessage requests (bidirectional)
 * - Roots: provide filesystem roots to server on request
 * - Logging: receive and forward server log messages
 * - Completions: argument completions for tools and resource templates
 * - Cancellation: abort in-progress requests via AbortSignal
 * - Reconnection: auto-reconnect with exponential backoff
 */

import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ToolListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  PromptListChangedNotificationSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
  CreateMessageRequestSchema,
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Logger } from "@agentick/kernel";
import type {
  MCPConnectionConfig,
  MCPClientOptions,
  DiscoveredTool,
  DiscoveredResource,
  DiscoveredResourceTemplate,
  DiscoveredPrompt,
  ResourceContent,
  PromptResult,
  ConnectionState,
  ServerHealth,
  ProgressCallback,
  LogMessage,
} from "./types.js";

const log = Logger.for("mcp:client");

// ============================================================================
// URI Template Matching
// ============================================================================

export function uriMatchesTemplate(uri: string, template: string): boolean {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, (ch) => {
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

// ============================================================================
// MCPClient
// ============================================================================

interface ManagedConnection {
  client: Client;
  config: MCPConnectionConfig;
  state: ConnectionState;
  lastConnectedAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

export class MCPClient {
  private readonly options: MCPClientOptions;
  private readonly emitter = new EventEmitter();

  private readonly connections = new Map<string, ManagedConnection>();
  private readonly toolCache = new Map<string, DiscoveredTool[]>();
  private readonly resourceCache = new Map<string, DiscoveredResource[]>();
  private readonly templateCache = new Map<string, DiscoveredResourceTemplate[]>();
  private readonly promptCache = new Map<string, DiscoveredPrompt[]>();

  // Progress callbacks keyed by progressToken
  private readonly progressCallbacks = new Map<string | number, ProgressCallback>();

  constructor(options?: MCPClientOptions) {
    this.options = options ?? {};
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Connection Management
  // ══════════════════════════════════════════════════════════════════════════

  async connect(config: MCPConnectionConfig): Promise<void> {
    const { serverName } = config;
    const existing = this.connections.get(serverName);
    if (existing?.state === "connected") return;

    const capabilities: Record<string, unknown> = {};
    if (this.options.samplingHandler) capabilities.sampling = {};
    if (this.options.roots) capabilities.roots = { listChanged: true };

    // MCP Apps extension — advertise support so spec-compliant servers emit
    // UI metadata (tools with `_meta.ui.resourceUri`, resources with
    // `text/html;profile=mcp-app` mimeType). Per the 2026-01-26 spec, servers
    // SHOULD check this capability via `getUiCapability()` before registering
    // UI-enabled tools; without it, strict servers downgrade to text-only.
    // Declared by default — opt out by setting `mcpApps: false` in options.
    if (this.options.mcpApps !== false) {
      capabilities.extensions = {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      };
    }

    const client = new Client(
      {
        name: this.options.name ?? "@agentick/mcp-client",
        version: this.options.version ?? "1.0.0",
      },
      { capabilities },
    );

    this.setupNotificationHandlers(client, serverName);
    this.setupRequestHandlers(client, serverName);

    const transport = this.createTransport(config);
    await client.connect(transport);

    client.onclose = () => {
      const conn = this.connections.get(serverName);
      if (conn && conn.state === "connected") {
        conn.state = "disconnected";
        this.emitter.emit("connection:state", { serverName, state: "disconnected" });
        log.warn({ serverName }, "MCP client disconnected");

        // Auto-reconnect for non-in-process transports
        if (config.transport !== "in-process" && config.transport !== "stdio") {
          this.scheduleReconnect(config);
        }
      }
    };

    client.onerror = (error) => {
      const conn = this.connections.get(serverName);
      if (conn) {
        conn.state = "degraded";
        conn.lastErrorAt = Date.now();
        conn.lastError = error instanceof Error ? error.message : String(error);
        this.emitter.emit("connection:state", { serverName, state: "degraded" });
      }
      log.error({ err: error, serverName }, "MCP client error");
    };

    this.connections.set(serverName, {
      client,
      config,
      state: "connected",
      lastConnectedAt: Date.now(),
      reconnectAttempts: 0,
    });

    this.emitter.emit("connection:state", { serverName, state: "connected" });
  }

  async disconnect(serverName: string): Promise<void> {
    const conn = this.connections.get(serverName);
    if (!conn) return;

    // Cancel any pending reconnect
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);

    // Prevent onclose from triggering reconnect
    conn.state = "disconnected";

    try {
      await conn.client.close();
    } catch {
      /* best-effort */
    }

    this.connections.delete(serverName);
    this.clearCaches(serverName);
    this.emitter.emit("connection:state", { serverName, state: "disconnected" });
  }

  async disconnectAll(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.all(names.map((name) => this.disconnect(name)));
  }

  getHealth(serverName: string): ServerHealth | undefined {
    const conn = this.connections.get(serverName);
    if (!conn) return undefined;
    return {
      serverName,
      state: conn.state,
      lastConnectedAt: conn.lastConnectedAt,
      lastErrorAt: conn.lastErrorAt,
      lastError: conn.lastError,
    };
  }

  getAllHealth(): ServerHealth[] {
    return Array.from(this.connections.keys())
      .map((name) => this.getHealth(name)!)
      .filter(Boolean);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Capability introspection
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Returns the MCP Apps capability declared by a connected server, or `undefined`
   * if the server didn't advertise the extension. The returned object lists the
   * MIME types the server supports for UI resources (typically
   * `["text/html;profile=mcp-app"]`).
   *
   * Host code should check this before mounting iframes — a server with no apps
   * (or a server whose host declines to serve UI resources) won't declare the
   * capability, and the host should render tool results as plain content.
   */
  getMcpAppsCapability(serverName: string): { mimeTypes: string[] } | undefined {
    const conn = this.connections.get(serverName);
    if (!conn) return undefined;
    const caps = conn.client.getServerCapabilities() as any;
    const ext = caps?.extensions?.["io.modelcontextprotocol/ui"];
    if (!ext || !Array.isArray(ext.mimeTypes)) return undefined;
    return { mimeTypes: ext.mimeTypes };
  }

  /**
   * Convenience: does the connected server support MCP Apps rendering for at
   * least the standard `text/html;profile=mcp-app` MIME type?
   */
  supportsMcpApps(serverName: string): boolean {
    const cap = this.getMcpAppsCapability(serverName);
    return !!cap?.mimeTypes.includes("text/html;profile=mcp-app");
  }

  /**
   * Get server info (name, version, description) from a connected server.
   * Available after initialize handshake completes.
   */
  getServerInfo(
    serverName: string,
  ): { name: string; version: string; description?: string } | undefined {
    const conn = this.connections.get(serverName);
    if (!conn) return undefined;
    // SDK Client stores serverInfo as "serverVersion" (legacy naming)
    const info = conn.client.getServerVersion() as any;
    if (!info) return undefined;
    return { name: info.name, version: info.version, description: info.description };
  }

  /**
   * Get instructions from a connected server.
   * Instructions describe how to use the server's tools and resources —
   * intended for injection into the LLM's system prompt.
   */
  getInstructions(serverName: string): string | undefined {
    const conn = this.connections.get(serverName);
    if (!conn) return undefined;
    return conn.client.getInstructions?.();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Tools
  // ══════════════════════════════════════════════════════════════════════════

  async listTools(serverName: string): Promise<DiscoveredTool[]> {
    const cached = this.toolCache.get(serverName);
    if (cached) return cached;

    const client = this.requireClient(serverName);
    const response = await client.listTools();
    const tools: DiscoveredTool[] = response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Record<string, unknown>,
      annotations: tool.annotations as Record<string, unknown> | undefined,
      _meta: (tool as any)._meta as Record<string, unknown> | undefined,
      serverName,
    }));

    this.toolCache.set(serverName, tools);
    return tools;
  }

  async callTool(
    serverName: string,
    toolName: string,
    input: Record<string, unknown>,
    options?: { onProgress?: ProgressCallback; signal?: AbortSignal },
  ): Promise<any> {
    const client = this.requireClient(serverName);

    const params: any = { name: toolName, arguments: input };

    // Progress support — register callback before call
    if (options?.onProgress) {
      const token = crypto.randomUUID();
      params._meta = { progressToken: token };
      this.progressCallbacks.set(token, options.onProgress);

      try {
        return await client.callTool(params, undefined, {
          signal: options?.signal,
        });
      } finally {
        this.progressCallbacks.delete(token);
      }
    }

    return client.callTool(params, undefined, {
      signal: options?.signal,
    });
  }

  invalidateTools(serverName?: string): void {
    if (serverName) this.toolCache.delete(serverName);
    else this.toolCache.clear();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Resources
  // ══════════════════════════════════════════════════════════════════════════

  async listResources(serverName: string): Promise<DiscoveredResource[]> {
    const cached = this.resourceCache.get(serverName);
    if (cached) return cached;

    const client = this.requireClient(serverName);
    const response = await client.listResources();
    const resources: DiscoveredResource[] = response.resources.map((r) => ({
      uri: r.uri,
      name: r.name,
      description: r.description,
      mimeType: r.mimeType,
      serverName,
    }));

    this.resourceCache.set(serverName, resources);
    return resources;
  }

  async listResourceTemplates(serverName: string): Promise<DiscoveredResourceTemplate[]> {
    const cached = this.templateCache.get(serverName);
    if (cached) return cached;

    const client = this.requireClient(serverName);
    const response = await client.listResourceTemplates();
    const templates: DiscoveredResourceTemplate[] = response.resourceTemplates.map((t) => ({
      uriTemplate: t.uriTemplate,
      name: t.name,
      description: t.description,
      mimeType: t.mimeType,
      serverName,
    }));

    this.templateCache.set(serverName, templates);
    return templates;
  }

  async readResource(serverName: string, uri: string): Promise<ResourceContent[]> {
    const client = this.requireClient(serverName);
    const response = await client.readResource({ uri });
    return response.contents.map((c) => ({
      uri: c.uri,
      text: "text" in c ? c.text : undefined,
      blob: "blob" in c ? c.blob : undefined,
      mimeType: c.mimeType,
    }));
  }

  invalidateResources(serverName?: string): void {
    if (serverName) {
      this.resourceCache.delete(serverName);
      this.templateCache.delete(serverName);
    } else {
      this.resourceCache.clear();
      this.templateCache.clear();
    }
  }

  async listAllResources(): Promise<DiscoveredResource[]> {
    const results = await Promise.allSettled(
      Array.from(this.connections.keys()).map((name) => this.listResources(name)),
    );
    return results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => (r as PromiseFulfilledResult<DiscoveredResource[]>).value);
  }

  async listAllResourceTemplates(): Promise<DiscoveredResourceTemplate[]> {
    const results = await Promise.allSettled(
      Array.from(this.connections.keys()).map((name) => this.listResourceTemplates(name)),
    );
    return results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => (r as PromiseFulfilledResult<DiscoveredResourceTemplate[]>).value);
  }

  async readResourceByURI(uri: string): Promise<ResourceContent[]> {
    for (const [serverName, resources] of this.resourceCache) {
      if (resources.some((r) => r.uri === uri)) return this.readResource(serverName, uri);
    }
    for (const [serverName, templates] of this.templateCache) {
      if (templates.some((t) => uriMatchesTemplate(uri, t.uriTemplate))) {
        return this.readResource(serverName, uri);
      }
    }
    throw new Error(
      `No MCP server found for resource URI: ${uri}. ` +
        `Known servers: ${Array.from(this.connections.keys()).join(", ")}`,
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Prompts
  // ══════════════════════════════════════════════════════════════════════════

  async listPrompts(serverName: string): Promise<DiscoveredPrompt[]> {
    const cached = this.promptCache.get(serverName);
    if (cached) return cached;

    const client = this.requireClient(serverName);
    const response = await client.listPrompts();
    const prompts: DiscoveredPrompt[] = response.prompts.map((p) => ({
      name: p.name,
      description: p.description,
      arguments: p.arguments?.map((a) => ({
        name: a.name,
        description: a.description,
        required: a.required,
      })),
      serverName,
    }));

    this.promptCache.set(serverName, prompts);
    return prompts;
  }

  async getPrompt(
    serverName: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<PromptResult> {
    const client = this.requireClient(serverName);
    const response = await client.getPrompt({ name, arguments: args });
    return {
      description: response.description,
      messages: response.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };
  }

  invalidatePrompts(serverName?: string): void {
    if (serverName) this.promptCache.delete(serverName);
    else this.promptCache.clear();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Completions
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Request argument completions for a prompt.
   * MCP spec supports completions for ref/prompt and ref/resource.
   */
  async completePromptArgument(
    serverName: string,
    promptName: string,
    argumentName: string,
    value: string,
  ): Promise<string[]> {
    const client = this.requireClient(serverName);
    const response = await client.complete({
      ref: { type: "ref/prompt", name: promptName },
      argument: { name: argumentName, value },
    });
    return response.completion.values;
  }

  /**
   * Request argument completions for a resource template variable.
   */
  async completeResourceTemplate(
    serverName: string,
    uriTemplate: string,
    argumentName: string,
    value: string,
  ): Promise<string[]> {
    const client = this.requireClient(serverName);
    const response = await client.complete({
      ref: { type: "ref/resource", uri: uriTemplate },
      argument: { name: argumentName, value },
    });
    return response.completion.values;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Logging
  // ══════════════════════════════════════════════════════════════════════════

  async setLoggingLevel(serverName: string, level: string): Promise<void> {
    const client = this.requireClient(serverName);
    await client.setLoggingLevel(level as any);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Roots
  // ══════════════════════════════════════════════════════════════════════════

  async sendRootsChanged(serverName: string): Promise<void> {
    const client = this.requireClient(serverName);
    await client.sendRootsListChanged();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Events
  // ══════════════════════════════════════════════════════════════════════════

  on(event: string, handler: (...args: any[]) => void): void {
    this.emitter.on(event, handler);
  }

  off(event: string, handler: (...args: any[]) => void): void {
    this.emitter.off(event, handler);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Notification Handlers
  // ══════════════════════════════════════════════════════════════════════════

  private setupNotificationHandlers(client: Client, serverName: string): void {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      this.toolCache.delete(serverName);
      this.emitter.emit("tools:changed", { serverName });
    });

    client.setNotificationHandler(ResourceListChangedNotificationSchema, async () => {
      this.resourceCache.delete(serverName);
      this.templateCache.delete(serverName);
      this.emitter.emit("resources:changed", { serverName });
    });

    client.setNotificationHandler(PromptListChangedNotificationSchema, async () => {
      this.promptCache.delete(serverName);
      this.emitter.emit("prompts:changed", { serverName });
    });

    client.setNotificationHandler(LoggingMessageNotificationSchema, async (notification) => {
      const msg: LogMessage = {
        level: notification.params.level as any,
        logger: notification.params.logger,
        data: notification.params.data,
      };
      this.emitter.emit("log", { serverName, message: msg });
      this.options.logHandler?.(msg, serverName);
    });

    client.setNotificationHandler(ProgressNotificationSchema, async (notification) => {
      const token = notification.params.progressToken;
      const callback = this.progressCallbacks.get(token);
      if (callback) {
        callback({
          progress: notification.params.progress,
          total: notification.params.total,
        });
      }
      this.emitter.emit("progress", {
        serverName,
        token,
        progress: notification.params.progress,
        total: notification.params.total,
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Request Handlers (server → client)
  // ══════════════════════════════════════════════════════════════════════════

  private setupRequestHandlers(client: Client, _serverName: string): void {
    // Sampling — server asks client's model to generate
    if (this.options.samplingHandler) {
      const handler = this.options.samplingHandler;
      client.setRequestHandler(CreateMessageRequestSchema, async (request) => {
        const result = await handler({
          messages: request.params.messages as any,
          modelPreferences: request.params.modelPreferences as any,
          systemPrompt: request.params.systemPrompt,
          includeContext: request.params.includeContext as any,
          temperature: request.params.temperature,
          maxTokens: request.params.maxTokens,
          stopSequences: request.params.stopSequences,
          metadata: request.params.metadata as Record<string, unknown> | undefined,
        });
        return result as any;
      });
    }

    // Roots — server asks client for filesystem roots
    if (this.options.roots) {
      const roots = this.options.roots;
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: roots.map((r) => ({ uri: r.uri, name: r.name })),
      }));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Reconnection
  // ══════════════════════════════════════════════════════════════════════════

  private scheduleReconnect(config: MCPConnectionConfig): void {
    const conn = this.connections.get(config.serverName);
    if (!conn || conn.state === "connected") return;

    const maxAttempts = 10;
    if (conn.reconnectAttempts >= maxAttempts) {
      conn.state = "degraded";
      this.emitter.emit("connection:state", {
        serverName: config.serverName,
        state: "degraded",
      });
      log.error({ serverName: config.serverName }, "Max reconnect attempts reached");
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, conn.reconnectAttempts), 30000);
    conn.state = "reconnecting";
    conn.reconnectAttempts++;
    this.emitter.emit("connection:state", {
      serverName: config.serverName,
      state: "reconnecting",
    });

    conn.reconnectTimer = setTimeout(async () => {
      try {
        // Remove old connection state
        this.connections.delete(config.serverName);
        this.clearCaches(config.serverName);

        // Reconnect
        await this.connect(config);
        log.info({ serverName: config.serverName }, "Reconnected to MCP server");
      } catch (err) {
        log.warn({ serverName: config.serverName, err }, "Reconnect attempt failed");
        this.scheduleReconnect(config);
      }
    }, delay);

    // Don't block process exit
    if (conn.reconnectTimer.unref) conn.reconnectTimer.unref();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Helpers
  // ══════════════════════════════════════════════════════════════════════════

  private requireClient(serverName: string): Client {
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP server "${serverName}" is not connected`);
    return conn.client;
  }

  private clearCaches(serverName: string): void {
    this.toolCache.delete(serverName);
    this.resourceCache.delete(serverName);
    this.templateCache.delete(serverName);
    this.promptCache.delete(serverName);
  }

  private createTransport(config: MCPConnectionConfig): Transport {
    switch (config.transport) {
      case "stdio":
        if (!config.connection.command) throw new Error("Stdio transport requires command");
        return new StdioClientTransport({
          command: config.connection.command,
          args: config.connection.args ?? [],
        });
      case "sse":
        if (!config.connection.url) throw new Error("SSE transport requires url");
        return new SSEClientTransport(new URL(config.connection.url));
      case "streamable-http":
        if (!config.connection.url) throw new Error("Streamable HTTP transport requires url");
        return new StreamableHTTPClientTransport(new URL(config.connection.url));
      case "in-process":
        if (!config.connection.transport)
          throw new Error("In-process transport requires transport");
        return config.connection.transport;
      default:
        throw new Error(`Unsupported MCP transport: ${config.transport}`);
    }
  }
}
