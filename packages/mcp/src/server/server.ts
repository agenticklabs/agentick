import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { UriTemplate } from "@modelcontextprotocol/sdk/shared/uriTemplate.js";
import { Context, createProcedure } from "@agentick/kernel";
import type {
  MCPServerOptions,
  MCPServerEvents,
  MCPSessionInfo,
  MCPToolDefinition,
  MCPStaticResource,
  MCPResourceTemplateDefinition,
  MCPAppDefinition,
  MCPPromptDefinition,
  ConnectionInfo,
  OperationInfo,
  MCPHandlerExtra,
  MCPHandlerContext,
} from "../protocol/types.js";
import { resolveSecurityDefaults, type ResolvedSecurity } from "./security/defaults.js";
import {
  SecurityError,
  evaluateConnectionGuard,
  evaluateRequestPipeline,
  buildRequestContext,
} from "./security/pipeline.js";
import { toolError } from "../protocol/errors.js";
// Use the SDK's own Zod → JSON Schema conversion (handles Zod v4)
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { normalizeObjectSchema } from "@modelcontextprotocol/sdk/server/zod-compat.js";

// ============================================================================
// Internal State
// ============================================================================

/** A live client session — one SDK Server + one Transport per MCP client. */
interface ManagedSession {
  sessionId: string;
  sdkServer: Server;
  transport: Transport;
  createdAt: number;
  lastActivityAt: number;
  transportType: ConnectionInfo["transport"];
}

/** Pre-computed JSON Schema for tool list responses. */
interface RegisteredTool {
  definition: MCPToolDefinition;
  jsonSchema: Record<string, unknown>;
}

interface RegisteredTemplate {
  definition: MCPResourceTemplateDefinition;
  uriTemplate: UriTemplate;
}

// ============================================================================
// MCP Apps — metadata helpers
// ============================================================================

/**
 * Legacy `_meta` key for a tool's UI resource URI.
 *
 * Pre-spec hosts look for `_meta["ui/resourceUri"]`; spec-compliant hosts use
 * `_meta.ui.resourceUri`. We emit both on `tools/list` so the server works
 * across the full range of client versions in the wild.
 *
 * See @modelcontextprotocol/ext-apps for the official reference implementation
 * which also emits both.
 */
const LEGACY_UI_RESOURCE_URI_KEY = "ui/resourceUri";

/**
 * Build the `_meta.ui` block for an MCP App, per the MCP Apps spec (2026-01-26).
 *
 * Included on both `resources/list` entries and `resources/read` content items
 * for `ui://` resources. Returns `undefined` when the app declares no UI
 * metadata — in that case, callers should omit `_meta` entirely rather than
 * emit an empty object.
 *
 * Permissions are converted from our array shape (`["camera", "microphone"]`)
 * to the spec's object shape (`{ camera: {}, microphone: {} }`).
 */
function buildAppResourceMeta(app: MCPAppDefinition):
  | {
      ui: {
        csp?: MCPAppDefinition["csp"];
        permissions?: Record<string, Record<string, never>>;
        prefersBorder?: boolean;
        domain?: string;
      };
    }
  | undefined {
  const ui: {
    csp?: MCPAppDefinition["csp"];
    permissions?: Record<string, Record<string, never>>;
    prefersBorder?: boolean;
    domain?: string;
  } = {};

  if (app.csp) ui.csp = app.csp;
  if (app.permissions?.length) {
    ui.permissions = app.permissions.reduce(
      (acc, perm) => ({ ...acc, [perm]: {} }),
      {} as Record<string, Record<string, never>>,
    );
  }
  if (app.prefersBorder !== undefined) ui.prefersBorder = app.prefersBorder;
  if (app.domain) ui.domain = app.domain;

  return Object.keys(ui).length > 0 ? { ui } : undefined;
}

/**
 * Normalize a tool definition against the legacy MCP Apps `_meta` shape.
 *
 * If the caller supplied `_meta["ui/resourceUri"]` (pre-spec form) but no
 * `ui.resourceUri`, hydrate the canonical field so downstream code only has
 * to look in one place. Leaves the original `_meta` intact — extra keys are
 * preserved and re-emitted on `tools/list` verbatim.
 *
 * Pure function; always returns a new object when normalization applies so
 * callers cannot observe internal mutation of the input.
 */
function normalizeLegacyToolUi(tool: MCPToolDefinition): MCPToolDefinition {
  const legacyUri = tool._meta?.[LEGACY_UI_RESOURCE_URI_KEY];
  if (typeof legacyUri !== "string") return tool;
  if (tool.ui?.resourceUri) return tool;

  return {
    ...tool,
    ui: { ...(tool.ui ?? {}), resourceUri: legacyUri },
  };
}

// ============================================================================
// MCPServer
// ============================================================================

export class MCPServer {
  private readonly options: MCPServerOptions;
  private readonly emitter = new EventEmitter();

  // ── Registry — the source of truth, shared across all sessions ──
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly resources = new Map<string, MCPStaticResource>();
  private readonly templates = new Map<string, RegisteredTemplate>();
  private readonly apps = new Map<string, MCPAppDefinition>();
  private readonly prompts = new Map<string, MCPPromptDefinition>();

  // ── Sessions — one SDK Server + Transport per MCP client ──
  private readonly sessions = new Map<string, ManagedSession>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(options: MCPServerOptions) {
    this.options = options;

    // Populate the registry from config
    for (const tool of options.tools ?? []) this.addToolToRegistry(tool);
    for (const res of options.resources ?? []) this.resources.set(res.uri, res);
    for (const tmpl of options.resourceTemplates ?? []) {
      this.templates.set(tmpl.uriTemplate, {
        definition: tmpl,
        uriTemplate: new UriTemplate(tmpl.uriTemplate),
      });
    }
    for (const app of options.apps ?? []) this.apps.set(app.uri, app);
    for (const prompt of options.prompts ?? []) this.prompts.set(prompt.name, prompt);

    this.startSessionCleanup();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Transport — single transport mode (in-process, stdio)
  // ══════════════════════════════════════════════════════════════════════════

  async connect(transport: Transport): Promise<void> {
    this.ensureNotClosed();

    const transportType = this.detectTransportType(transport);
    const security = resolveSecurityDefaults(transportType, this.options.security);
    await evaluateConnectionGuard(security, { transport: transportType });

    const sdkServer = this.createSDKServer();
    await sdkServer.connect(transport);

    const sessionId = transport.sessionId ?? crypto.randomUUID();
    this.sessions.set(sessionId, {
      sessionId,
      sdkServer,
      transport,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      transportType,
    });

    this.emit("mcp:session:created", { sessionId });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Transport — HTTP multi-session mode
  // Each new client gets its own SDK Server + StreamableHTTPServerTransport.
  // This is the SDK's official pattern (see typescript-sdk/examples/server).
  // ══════════════════════════════════════════════════════════════════════════

  async handleHTTPRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.ensureNotClosed();

    const sessionId = this.extractSessionId(req);

    // ── Existing session — route to its transport ──
    if (sessionId) {
      const session = this.sessions.get(sessionId);
      if (session) {
        session.lastActivityAt = Date.now();
        const httpTransport = session.transport as StreamableHTTPServerTransport;
        await httpTransport.handleRequest(req, res, await this.parsedBody(req));
        return;
      }

      // Stale/unknown session ID — the server restarted or the session expired.
      // GET requests (SSE streams) with stale sessions always get 404.
      // POST requests: check if it's an initialize — if so, create new session.
      // Otherwise, 404 per MCP spec so the client re-initializes.
      const body = req.method === "GET" ? null : await this.parsedBody(req);
      const isInit = body != null && this.isInitializeRequest(body);

      if (!isInit) {
        this.emit("mcp:session:stale", { sessionId, method: req.method });
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: {
              code: -32001,
              message: "Session not found. The server may have restarted. Please re-initialize.",
            },
            id: (body as any)?.id ?? null,
          }),
        );
        return;
      }
      // Fall through to create new session (initialize request)
    }

    // ── Connection guard ──
    const security = resolveSecurityDefaults("streamable-http", this.options.security);
    const connectionInfo: ConnectionInfo = {
      transport: "streamable-http",
      origin: req.headers.origin,
      remoteAddress: req.socket.remoteAddress,
      headers: this.flattenHeaders(req.headers),
      sessionId: sessionId ?? undefined,
    };

    try {
      await evaluateConnectionGuard(security, connectionInfo);
    } catch (err) {
      if (err instanceof SecurityError) {
        this.emit("mcp:security:connection-rejected", {
          origin: connectionInfo.origin,
          transport: "streamable-http",
          reason: err.message,
        });
        res.writeHead(err.code, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
      throw err;
    }

    // ── New session — create SDK Server + Transport (one per client) ──
    const sdkServer = this.createSDKServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (newSessionId) => {
        this.sessions.set(newSessionId, {
          sessionId: newSessionId,
          sdkServer,
          transport,
          createdAt: Date.now(),
          lastActivityAt: Date.now(),
          transportType: "streamable-http",
        });
        this.emit("mcp:session:created", { sessionId: newSessionId });
      },
    });

    transport.onclose = () => {
      const sid = transport.sessionId;
      if (sid) {
        this.sessions.delete(sid);
        this.emit("mcp:session:closed", { sessionId: sid, reason: "transport closed" });
      }
    };

    await sdkServer.connect(transport);
    await transport.handleRequest(req, res, await this.parsedBody(req));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Dynamic Registration — updates registry + propagates to all sessions
  // ══════════════════════════════════════════════════════════════════════════

  registerTool(definition: MCPToolDefinition): void {
    this.addToolToRegistry(definition);
    // Propagate to all active sessions
    for (const session of this.sessions.values()) {
      session.sdkServer.sendToolListChanged();
    }
    this.emit("mcp:tools:changed", {} as Record<string, never>);
  }

  unregisterTool(name: string): void {
    if (this.tools.delete(name)) {
      for (const session of this.sessions.values()) {
        session.sdkServer.sendToolListChanged();
      }
      this.emit("mcp:tools:changed", {} as Record<string, never>);
    }
  }

  registerResource(definition: MCPStaticResource | MCPResourceTemplateDefinition): void {
    if ("uri" in definition) {
      this.resources.set(definition.uri, definition);
    } else {
      this.templates.set(definition.uriTemplate, {
        definition,
        uriTemplate: new UriTemplate(definition.uriTemplate),
      });
    }
    for (const session of this.sessions.values()) {
      session.sdkServer.sendResourceListChanged();
    }
    this.emit("mcp:resources:changed", {} as Record<string, never>);
  }

  unregisterResource(uriOrTemplate: string): void {
    const deleted = this.resources.delete(uriOrTemplate) || this.templates.delete(uriOrTemplate);
    if (deleted) {
      for (const session of this.sessions.values()) {
        session.sdkServer.sendResourceListChanged();
      }
      this.emit("mcp:resources:changed", {} as Record<string, never>);
    }
  }

  registerApp(definition: MCPAppDefinition): void {
    this.apps.set(definition.uri, definition);
    for (const session of this.sessions.values()) {
      session.sdkServer.sendResourceListChanged();
    }
    this.emit("mcp:resources:changed", {} as Record<string, never>);
  }

  unregisterApp(uri: string): void {
    if (this.apps.delete(uri)) {
      for (const session of this.sessions.values()) {
        session.sdkServer.sendResourceListChanged();
      }
      this.emit("mcp:resources:changed", {} as Record<string, never>);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Events — local EventEmitter + optional Context.emit bridge
  // ══════════════════════════════════════════════════════════════════════════

  on<E extends keyof MCPServerEvents>(event: E, handler: (data: MCPServerEvents[E]) => void): void {
    this.emitter.on(event, handler);
  }

  off<E extends keyof MCPServerEvents>(
    event: E,
    handler: (data: MCPServerEvents[E]) => void,
  ): void {
    this.emitter.off(event, handler);
  }

  private emit<E extends keyof MCPServerEvents>(event: E, data: MCPServerEvents[E]): void {
    this.emitter.emit(event, data);
    try {
      const ctx = Context.tryGet();
      if (ctx) Context.emit(event, data);
    } catch {
      // No ALS context — standalone mode
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }

    const closePromises: Promise<void>[] = [];
    for (const [sessionId, session] of this.sessions) {
      closePromises.push(session.sdkServer.close().catch(() => {}));
      this.emit("mcp:session:closed", { sessionId, reason: "server closing" });
    }
    await Promise.all(closePromises);
    this.sessions.clear();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Introspection
  // ══════════════════════════════════════════════════════════════════════════

  getActiveSessions(): MCPSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      transport: s.transportType,
    }));
  }

  getRegisteredTools(): MCPToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Create a fresh SDK Server for a new session
  //
  // Each client session gets its own Server instance with request handlers
  // that read from the shared registry. This is the SDK's official pattern.
  // The handlers close over `this` (the MCPServer) to access the live
  // registry — so dynamic registration is immediately visible.
  // ══════════════════════════════════════════════════════════════════════════

  private createSDKServer(): Server {
    const sdkServer = new Server(
      { name: this.options.name, version: this.options.version },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { listChanged: true },
          prompts: { listChanged: true },
          logging: {},
        },
        ...(this.options.instructions && { instructions: this.options.instructions }),
      },
    );

    // ── tools/list — reads from shared registry, applies toolFilter ──
    sdkServer.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      const handlerCtx = await this.buildHandlerContext(extra);
      let visibleTools = Array.from(this.tools.values());

      if (this.options.toolFilter) {
        visibleTools = visibleTools.filter((t) =>
          this.options.toolFilter!(t.definition, handlerCtx.request),
        );
      }

      return {
        tools: visibleTools.map((t) => {
          const ui = t.definition.ui;
          // Emit both the modern (_meta.ui.resourceUri) and legacy
          // (_meta["ui/resourceUri"]) keys when a resourceUri is set, matching
          // the reference ext-apps implementation so older hosts still resolve
          // the UI resource. Pass through any other caller-supplied _meta keys
          // verbatim (e.g. experimental host-specific metadata).
          const passthroughMeta = { ...(t.definition._meta ?? {}) };
          delete passthroughMeta.ui;
          delete passthroughMeta[LEGACY_UI_RESOURCE_URI_KEY];

          const meta: Record<string, unknown> = { ...passthroughMeta };
          if (ui) meta.ui = ui;
          if (ui?.resourceUri) meta[LEGACY_UI_RESOURCE_URI_KEY] = ui.resourceUri;

          return {
            name: t.definition.name,
            description: t.definition.description,
            inputSchema: t.jsonSchema,
            annotations: t.definition.annotations,
            ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
          };
        }),
      };
    });

    // ── tools/call — reads from shared registry, runs security pipeline ──
    sdkServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const toolName = request.params.name;
      const toolEntry = this.tools.get(toolName);
      if (!toolEntry) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} not found`);
      }

      const handlerCtx = await this.buildHandlerContext(extra);

      if (
        this.options.toolFilter &&
        !this.options.toolFilter(toolEntry.definition, handlerCtx.request)
      ) {
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${toolName} not found`);
      }

      const sessionId = handlerCtx.sessionId;
      const requestId = String(extra.requestId ?? "");
      this.emit("mcp:tool:start", { sessionId, tool: toolName, requestId });
      const startTime = Date.now();

      try {
        const security = this.resolveSecurityForSession(sessionId);
        const operation: OperationInfo = { type: "tool_call", name: toolName, sessionId };
        const sanitizedInput = await evaluateRequestPipeline(
          security,
          handlerCtx.request,
          operation,
          request.params.arguments ?? {},
        );

        const toolProc = createProcedure(
          {
            name: `mcp:tool:call:${toolName}`,
            metadata: { tool: toolName, server: this.options.name },
          },
          async (input: Record<string, unknown>, ctx: MCPHandlerContext) =>
            toolEntry.definition.handler(input, ctx),
        );

        const result = await toolProc(sanitizedInput ?? request.params.arguments ?? {}, handlerCtx)
          .result;
        const durationMs = Date.now() - startTime;

        this.emit("mcp:tool:end", {
          sessionId,
          tool: toolName,
          requestId,
          durationMs,
          isError: result.isError ?? false,
        });
        return result;
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const message = err instanceof Error ? err.message : String(err);
        this.emit("mcp:tool:error", { sessionId, tool: toolName, requestId, error: message });
        this.emit("mcp:tool:end", {
          sessionId,
          tool: toolName,
          requestId,
          durationMs,
          isError: true,
        });
        if (err instanceof SecurityError) this.emitSecurityEvent(err, sessionId, toolName);
        if (err instanceof McpError) throw err;
        return toolError(message);
      }
    });

    // ── resources/list ──
    sdkServer.setRequestHandler(ListResourcesRequestSchema, async (_request, extra) => {
      const handlerCtx = await this.buildHandlerContext(extra);
      const resources = [
        ...Array.from(this.resources.values()).map((r) => ({
          uri: r.uri,
          name: r.name,
          description: r.description,
          mimeType: r.mimeType,
        })),
        ...Array.from(this.apps.values()).map((a) => {
          const meta = buildAppResourceMeta(a);
          return {
            uri: a.uri,
            name: a.name,
            description: a.description,
            mimeType: "text/html;profile=mcp-app" as string,
            // _meta.ui on list entries is a fallback for hosts that pre-fetch
            // UI metadata at connection time; read-side metadata overrides.
            ...(meta ? { _meta: meta } : {}),
          };
        }),
      ];

      for (const tmpl of this.templates.values()) {
        if (tmpl.definition.list) {
          try {
            const listed = await tmpl.definition.list(handlerCtx);
            resources.push(...(listed.resources as typeof resources));
          } catch {
            /* skip */
          }
        }
      }
      return { resources } as any;
    });

    // ── resources/templates/list ──
    sdkServer.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
      resourceTemplates: Array.from(this.templates.values()).map((t) => ({
        uriTemplate: t.definition.uriTemplate,
        name: t.definition.name,
        description: t.definition.description,
        mimeType: t.definition.mimeType,
      })),
    }));

    // ── resources/read ──
    sdkServer.setRequestHandler(ReadResourceRequestSchema, async (request, extra): Promise<any> => {
      const uri = request.params.uri;
      const handlerCtx = await this.buildHandlerContext(extra);
      this.emit("mcp:resource:read", { sessionId: handlerCtx.sessionId, uri });

      try {
        const resource = this.resources.get(uri);
        if (resource) return await resource.read(handlerCtx);

        const app = this.apps.get(uri);
        if (app) {
          const content = typeof app.content === "function" ? await app.content() : app.content;
          const meta = buildAppResourceMeta(app);
          return {
            contents: [
              {
                uri,
                text: content,
                mimeType: "text/html;profile=mcp-app",
                // CSP, permissions, prefersBorder, domain — required by the
                // host to configure the iframe sandbox. Without _meta.ui the
                // host applies secure defaults (deny-all) and the view stays
                // blank even though the HTML loaded.
                ...(meta ? { _meta: meta } : {}),
              },
            ],
          };
        }

        for (const tmpl of this.templates.values()) {
          const match = tmpl.uriTemplate.match(uri);
          if (match)
            return await tmpl.definition.read(uri, match as Record<string, string>, handlerCtx);
        }
      } catch (err) {
        if (err instanceof McpError) throw err;
        // Never leak handler error details to the client
        throw new McpError(ErrorCode.InternalError, "Resource read failed");
      }

      throw new McpError(ErrorCode.InvalidParams, `Resource not found: ${uri}`);
    });

    // ── prompts/list ──
    sdkServer.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: Array.from(this.prompts.values()).map((p) => ({
        name: p.name,
        description: p.description,
        arguments: p.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        })),
      })),
    }));

    // ── prompts/get ──
    sdkServer.setRequestHandler(GetPromptRequestSchema, async (request, extra): Promise<any> => {
      const prompt = this.prompts.get(request.params.name);
      if (!prompt)
        throw new McpError(ErrorCode.InvalidParams, `Prompt not found: ${request.params.name}`);
      const handlerCtx = await this.buildHandlerContext(extra);
      try {
        return await prompt.handler(request.params.arguments ?? {}, handlerCtx);
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError(ErrorCode.InternalError, "Prompt execution failed");
      }
    });

    return sdkServer;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Registry
  // ══════════════════════════════════════════════════════════════════════════

  private addToolToRegistry(tool: MCPToolDefinition): void {
    let jsonSchema: Record<string, unknown>;
    // Use the same Zod → JSON Schema conversion the SDK's McpServer uses internally
    const normalized = normalizeObjectSchema(tool.inputSchema as any);
    if (normalized) {
      jsonSchema = toJsonSchemaCompat(normalized, {
        strictUnions: true,
        pipeStrategy: "input",
      }) as Record<string, unknown>;
    } else if (typeof tool.inputSchema === "object" && "type" in tool.inputSchema) {
      // Already JSON Schema
      jsonSchema = tool.inputSchema as Record<string, unknown>;
    } else {
      jsonSchema = { type: "object" };
    }
    // Hydrate ui.resourceUri from the legacy _meta["ui/resourceUri"] key so
    // tools authored against the pre-spec MCP Apps shape route through the
    // canonical code paths (visibility filtering, tool→app resolution, etc.).
    const definition = normalizeLegacyToolUi(tool);
    this.tools.set(definition.name, { definition, jsonSchema });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Context Building
  // ══════════════════════════════════════════════════════════════════════════

  private async buildHandlerContext(extra: MCPHandlerExtra): Promise<MCPHandlerContext> {
    const request = await buildRequestContext(extra, this.options.contextProvider);
    return { request, extra, sessionId: extra.sessionId ?? "unknown" };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Session Management
  // ══════════════════════════════════════════════════════════════════════════

  private startSessionCleanup(): void {
    const intervalMs = this.options.sessions?.cleanupIntervalMs ?? 60_000;
    const ttlMs = this.options.sessions?.idleTtlMs ?? 30 * 60_000;

    this.cleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [sessionId, session] of this.sessions) {
        if (now - session.lastActivityAt > ttlMs) {
          this.sessions.delete(sessionId);
          session.sdkServer.close().catch(() => {});
          this.emit("mcp:session:idle-timeout", {
            sessionId,
            idleMs: now - session.lastActivityAt,
          });
          this.emit("mcp:session:closed", { sessionId, reason: "idle timeout" });
        }
      }
    }, intervalMs);

    if (this.cleanupTimer.unref) this.cleanupTimer.unref();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Internal: Helpers
  // ══════════════════════════════════════════════════════════════════════════

  private resolveSecurityForSession(sessionId: string): ResolvedSecurity {
    const session = this.sessions.get(sessionId);
    return resolveSecurityDefaults(session?.transportType ?? "in-process", this.options.security);
  }

  private detectTransportType(transport: Transport): ConnectionInfo["transport"] {
    const name = transport.constructor.name;
    if (name === "InMemoryTransport") return "in-process";
    if (name === "StdioServerTransport") return "stdio";
    if (name === "SSEServerTransport") return "sse";
    if (name === "StreamableHTTPServerTransport") return "streamable-http";
    return "in-process";
  }

  private extractSessionId(req: IncomingMessage): string | undefined {
    const header = req.headers["mcp-session-id"];
    return typeof header === "string" ? header : undefined;
  }

  private isInitializeRequest(body: any): boolean {
    if (!body) return false;
    const parsed =
      typeof body === "string"
        ? (() => {
            try {
              return JSON.parse(body);
            } catch {
              return null;
            }
          })()
        : body;
    return parsed?.method === "initialize";
  }

  private flattenHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") flat[key] = value;
      else if (Array.isArray(value)) flat[key] = value.join(", ");
    }
    return flat;
  }

  private async parsedBody(req: IncomingMessage): Promise<any> {
    // Pre-parsed by Express/middleware
    if ((req as any).body !== undefined) return (req as any).body;
    // Only read the stream if req is actually a readable stream
    if (!req.readable) return undefined;
    // Raw HTTP — read and parse the stream (cache on req for re-reads)
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (chunks.length === 0) {
          resolve(undefined);
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          (req as any).body = parsed; // cache for subsequent reads
          resolve(parsed);
        } catch {
          resolve(undefined);
        }
      });
      req.on("error", () => resolve(undefined));
    });
  }

  private emitSecurityEvent(err: SecurityError, sessionId: string, toolName?: string): void {
    if (err.code === 401) {
      this.emit("mcp:security:auth-failed", { sessionId, reason: err.message });
    } else if (err.code === 403) {
      this.emit("mcp:security:authz-denied", { sessionId, tool: toolName, reason: err.message });
    } else if (err.code === 429) {
      this.emit("mcp:security:rate-limit", {
        sessionId,
        tool: toolName,
        retryAfterMs: err.retryAfterMs ?? 0,
      });
    }
  }

  private ensureNotClosed(): void {
    if (this.closed) throw new Error("MCPServer is closed");
  }
}
