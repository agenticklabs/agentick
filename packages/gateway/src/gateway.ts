/**
 * Gateway
 *
 * Standalone daemon for multi-client, multi-app access.
 * Transport-agnostic: supports both WebSocket and HTTP/SSE.
 *
 * Can run standalone or embedded in an external framework.
 */

import { EventEmitter } from "events";
import type { IncomingMessage as NodeRequest, ServerResponse as NodeResponse } from "http";
import type { Message } from "@tentickle/shared";
import {
  devToolsEmitter,
  type DTClientConnectedEvent,
  type DTClientDisconnectedEvent,
  type DTGatewayRequestEvent,
  type DTGatewayResponseEvent,
} from "@tentickle/shared";
import {
  Context,
  createProcedure,
  Logger,
  type KernelContext,
  type Procedure,
  type Middleware,
  type UserContext,
} from "@tentickle/kernel";

const log = Logger.for("Gateway");
import { extractToken, validateAuth, setSSEHeaders, type AuthResult } from "@tentickle/server";
import { AppRegistry } from "./app-registry.js";
import { SessionManager } from "./session-manager.js";
import { WSTransport } from "./ws-transport.js";
import { HTTPTransport } from "./http-transport.js";
import type { Transport, TransportClient } from "./transport.js";
import type {
  GatewayConfig,
  GatewayEvents,
  GatewayContext,
  SessionEvent,
  MethodNamespace,
} from "./types.js";
import { isMethodDefinition } from "./types.js";
import type {
  RequestMessage,
  GatewayMethod,
  GatewayEventType,
  SendParams,
  StatusParams,
  HistoryParams,
  SubscribeParams,
  StatusPayload,
  AppsPayload,
  SessionsPayload,
} from "./protocol.js";

const DEFAULT_PORT = 18789;
const DEFAULT_HOST = "127.0.0.1";

// ============================================================================
// Guard Middleware
// ============================================================================

/** Guard middleware that checks user roles */
function createRoleGuardMiddleware(roles: string[]): Middleware<any[]> {
  return async (_args: any[], _envelope: any, next: () => Promise<any>) => {
    const kernelCtx = Context.get();
    const userRoles = kernelCtx.user?.roles ?? [];

    if (!roles.some((r) => userRoles.includes(r))) {
      throw new Error(`Forbidden: requires one of roles [${roles.join(", ")}]`);
    }

    return next();
  };
}

/** Guard middleware that runs custom guard function */
function createCustomGuardMiddleware(
  guard: (ctx: KernelContext) => boolean | Promise<boolean>,
): Middleware<any[]> {
  return async (_args: any[], _envelope: any, next: () => Promise<any>) => {
    const kernelCtx = Context.get();
    const allowed = await guard(kernelCtx);

    if (!allowed) {
      throw new Error("Forbidden: guard check failed");
    }

    return next();
  };
}

// ============================================================================
// Gateway Class
// ============================================================================

/** Built-in methods that cannot be overridden */
const BUILT_IN_METHODS: Set<string> = new Set([
  "send",
  "abort",
  "status",
  "history",
  "reset",
  "close",
  "apps",
  "sessions",
  "subscribe",
  "unsubscribe",
]);

export class Gateway extends EventEmitter {
  private config: Required<
    Pick<GatewayConfig, "port" | "host" | "id" | "defaultApp" | "transport">
  > &
    GatewayConfig;
  private registry: AppRegistry;
  private sessions: SessionManager;
  private transports: Transport[] = [];
  private startTime: Date | null = null;
  private isRunning = false;
  private embedded: boolean;

  /** Pre-compiled map of method paths to procedures */
  private methodProcedures = new Map<string, Procedure<any>>();

  /** Track open SSE connections for embedded mode */
  private sseClients = new Map<string, NodeResponse>();

  /** Track channel subscriptions: "sessionId:channelName" -> Set of clientIds */
  private channelSubscriptions = new Map<string, Set<string>>();

  /** Track unsubscribe functions for core session channels */
  private coreChannelUnsubscribes = new Map<string, () => void>();

  /** Track client connection times for duration calculation */
  private clientConnectedAt = new Map<string, number>();

  /** Sequence counter for DevTools events */
  private devToolsSequence = 0;

  constructor(config: GatewayConfig) {
    super();

    // Validate config
    if (!config.apps || Object.keys(config.apps).length === 0) {
      throw new Error("At least one app is required");
    }
    if (!config.defaultApp) {
      throw new Error("defaultApp is required");
    }

    this.embedded = config.embedded ?? false;

    // Set defaults
    this.config = {
      ...config,
      port: config.port ?? DEFAULT_PORT,
      host: config.host ?? DEFAULT_HOST,
      id: config.id ?? `gw-${Date.now().toString(36)}`,
      transport: config.transport ?? "websocket",
    };

    // Initialize components
    this.registry = new AppRegistry(config.apps, config.defaultApp);
    this.sessions = new SessionManager(this.registry, { gatewayId: this.config.id });

    // Initialize all methods as procedures
    if (config.methods) {
      this.initializeMethods(config.methods, []);
    }

    // Create transports only in standalone mode
    if (!this.embedded) {
      this.initializeTransports();
    }
  }

  /**
   * Walk the methods tree and wrap all handlers as procedures.
   * Infers full path name (e.g., "tasks:admin:archive") automatically.
   */
  private initializeMethods(methods: MethodNamespace, path: string[]): void {
    for (const [key, value] of Object.entries(methods)) {
      const fullPath = [...path, key];
      const methodName = fullPath.join(":"); // e.g., "tasks:admin:archive"

      if (typeof value === "function") {
        // Simple function -> wrap in procedure automatically
        this.methodProcedures.set(
          methodName,
          createProcedure(
            {
              name: `gateway:${methodName}`,
              executionBoundary: "auto",
              metadata: { gatewayId: this.config.id, method: methodName },
            },
            value as (...args: any[]) => any,
          ),
        );
      } else if (isMethodDefinition(value)) {
        // method() definition -> create procedure with guards/schema as middleware
        const middleware: Middleware<any[]>[] = [];

        if (value.roles?.length) {
          middleware.push(createRoleGuardMiddleware(value.roles));
        }
        if (value.guard) {
          middleware.push(createCustomGuardMiddleware(value.guard));
        }

        this.methodProcedures.set(
          methodName,
          createProcedure(
            {
              name: `gateway:${methodName}`,
              executionBoundary: "auto",
              // Cast to any for Zod 3/4 compatibility - runtime uses .parse() only
              schema: value.schema as any,
              middleware,
              metadata: {
                gatewayId: this.config.id,
                method: methodName,
                description: value.description,
                roles: value.roles,
              },
            },
            value.handler as (...args: any[]) => any,
          ),
        );
      } else {
        // Plain object -> namespace, recurse
        this.initializeMethods(value as MethodNamespace, fullPath);
      }
    }
  }

  /**
   * Get a method's procedure by path (supports both ":" and "." separators)
   */
  private getMethodProcedure(path: string): Procedure<any> | undefined {
    // Normalize separators to ":"
    const normalized = path.replace(/\./g, ":");
    return this.methodProcedures.get(normalized);
  }

  private initializeTransports(): void {
    const { transport, port, host, auth, httpPort } = this.config;

    if (transport === "websocket" || transport === "both") {
      const wsTransport = new WSTransport({ port, host, auth });
      this.setupTransportHandlers(wsTransport);
      this.transports.push(wsTransport);
    }

    if (transport === "http" || transport === "both") {
      const httpTransportPort = transport === "both" ? (httpPort ?? port + 1) : port;
      const httpTransportInstance = new HTTPTransport({
        port: httpTransportPort,
        host,
        auth,
        pathPrefix: this.config.httpPathPrefix,
        corsOrigin: this.config.httpCorsOrigin,
        onDirectSend: this.directSend.bind(this),
        onInvoke: this.invokeMethod.bind(this),
      });
      this.setupTransportHandlers(httpTransportInstance);
      this.transports.push(httpTransportInstance);
    }
  }

  private setupTransportHandlers(transport: Transport): void {
    transport.on("connection", (client) => {
      // Track connection time for duration calculation
      const connectTime = Date.now();
      this.clientConnectedAt.set(client.id, connectTime);

      this.emit("client:connected", {
        clientId: client.id,
      });

      // Emit DevTools event
      if (devToolsEmitter.hasSubscribers()) {
        devToolsEmitter.emitEvent({
          type: "client_connected",
          executionId: this.config.id,
          clientId: client.id,
          transport: transport.type as "websocket" | "sse" | "http",
          sequence: this.devToolsSequence++,
          timestamp: connectTime,
        } as DTClientConnectedEvent);
      }
    });

    transport.on("disconnect", (clientId, reason) => {
      // Calculate connection duration
      const connectedAt = this.clientConnectedAt.get(clientId);
      const durationMs = connectedAt ? Date.now() - connectedAt : 0;
      this.clientConnectedAt.delete(clientId);

      // Clean up subscriptions
      this.sessions.unsubscribeAll(clientId);

      this.emit("client:disconnected", {
        clientId,
        reason,
      });

      // Emit DevTools event
      if (devToolsEmitter.hasSubscribers()) {
        devToolsEmitter.emitEvent({
          type: "client_disconnected",
          executionId: this.config.id,
          clientId,
          reason,
          durationMs,
          sequence: this.devToolsSequence++,
          timestamp: Date.now(),
        } as DTClientDisconnectedEvent);
      }
    });

    transport.on("message", async (clientId, message) => {
      if (message.type === "req") {
        await this.handleTransportRequest(transport, clientId, message);
      }
    });

    transport.on("error", (error) => {
      this.emit("error", error);
    });
  }

  /**
   * Start the gateway (standalone mode only)
   */
  async start(): Promise<void> {
    if (this.embedded) {
      throw new Error("Cannot call start() in embedded mode - use handleRequest() instead");
    }

    if (this.isRunning) {
      throw new Error("Gateway is already running");
    }

    // Initialize channel adapters
    if (this.config.channels) {
      const context = this.createGatewayContext();
      for (const channel of this.config.channels) {
        await channel.initialize(context);
      }
    }

    // Start all transports
    await Promise.all(this.transports.map((t) => t.start()));

    this.startTime = new Date();
    this.isRunning = true;

    this.emit("started", {
      port: this.config.port,
      host: this.config.host,
    });
  }

  /**
   * Stop the gateway
   */
  async stop(): Promise<void> {
    if (!this.isRunning && !this.embedded) return;

    // Destroy channel adapters
    if (this.config.channels) {
      for (const channel of this.config.channels) {
        await channel.destroy();
      }
    }

    // Stop all transports (if any)
    await Promise.all(this.transports.map((t) => t.stop()));

    this.isRunning = false;
    this.startTime = null;

    this.emit("stopped", {});
  }

  /**
   * Alias for stop() - useful for embedded mode cleanup
   */
  async close(): Promise<void> {
    return this.stop();
  }

  /**
   * Get gateway status
   */
  get status(): StatusPayload["gateway"] {
    return {
      id: this.config.id,
      uptime: this.startTime ? Math.floor((Date.now() - this.startTime.getTime()) / 1000) : 0,
      clients: this.transports.reduce((sum, t) => sum + t.clientCount, 0),
      sessions: this.sessions.size,
      apps: this.registry.ids(),
    };
  }

  /**
   * Check if running
   */
  get running(): boolean {
    return this.isRunning;
  }

  /**
   * Get the gateway ID
   */
  get id(): string {
    return this.config.id;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Embedded Mode: handleRequest()
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Handle an HTTP request (embedded mode).
   * This is the main entry point when Gateway is embedded in an external framework.
   *
   * @param req - Node.js IncomingMessage (or Express/Koa/etc request)
   * @param res - Node.js ServerResponse (or Express/Koa/etc response)
   * @returns Promise that resolves when request is handled (may reject on error)
   *
   * @example
   * ```typescript
   * // Express middleware
   * app.use("/api", (req, res, next) => {
   *   gateway.handleRequest(req, res).catch(next);
   * });
   * ```
   */
  async handleRequest(req: NodeRequest, res: NodeResponse): Promise<void> {
    // Set CORS headers
    const origin = this.config.httpCorsOrigin ?? "*";
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    // Handle preflight
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Extract path (handle Express mounting where path is already stripped)
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const prefix = this.config.httpPathPrefix ?? "";
    const path = url.pathname.replace(prefix, "") || "/";

    log.debug({ method: req.method, url: req.url, path }, "handleRequest");

    // Route requests - all framework-level endpoints
    switch (path) {
      case "/events":
        return this.handleSSE(req, res);
      case "/send":
        return this.handleSend(req, res);
      case "/invoke":
        return this.handleInvoke(req, res);
      case "/subscribe":
        return this.handleSubscribe(req, res);
      case "/abort":
        return this.handleAbort(req, res);
      case "/close":
        return this.handleCloseEndpoint(req, res);
      case "/channel":
      case "/channel/subscribe":
      case "/channel/publish":
        return this.handleChannel(req, res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HTTP Handlers (used by both handleRequest and HTTPTransport)
  // ══════════════════════════════════════════════════════════════════════════

  private async handleSSE(req: NodeRequest, res: NodeResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const token = extractToken(req) ?? url.searchParams.get("token") ?? undefined;

    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    // Setup SSE response
    setSSEHeaders(res);

    const clientId = url.searchParams.get("clientId") ?? `client-${Date.now().toString(36)}`;

    // Register SSE client for channel forwarding
    this.sseClients.set(clientId, res);

    // Send connection confirmation
    // Client expects type: "connection" to resolve the connection promise
    const connectData = JSON.stringify({
      type: "connection",
      connectionId: clientId,
      subscriptions: [],
    });
    res.write(`data: ${connectData}\n\n`);

    // Keep connection alive with periodic heartbeat
    const heartbeat = setInterval(() => {
      res.write(":heartbeat\n\n");
    }, 30000);

    res.on("close", () => {
      clearInterval(heartbeat);
      this.sessions.unsubscribeAll(clientId);
      this.sseClients.delete(clientId);
      this.cleanupClientChannelSubscriptions(clientId);
    });
  }

  /**
   * Clean up channel subscriptions for a disconnected client.
   */
  private cleanupClientChannelSubscriptions(clientId: string): void {
    for (const [key, clientIds] of this.channelSubscriptions.entries()) {
      clientIds.delete(clientId);
      // If no more subscribers for this session:channel, unsubscribe from core channel
      if (clientIds.size === 0) {
        this.channelSubscriptions.delete(key);
        const unsubscribe = this.coreChannelUnsubscribes.get(key);
        if (unsubscribe) {
          unsubscribe();
          this.coreChannelUnsubscribes.delete(key);
        }
      }
    }
  }

  private async handleSend(req: NodeRequest, res: NodeResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const token = extractToken(req);
    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    const body = await this.parseBody(req);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    const sessionId = (body.sessionId as string) ?? "main";
    const rawMessage = body.message;

    if (
      !rawMessage ||
      typeof rawMessage !== "object" ||
      !(rawMessage as any).role ||
      !Array.isArray((rawMessage as any).content)
    ) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid message format. Expected { role, content: ContentBlock[] }",
        }),
      );
      return;
    }

    const message = {
      role: (rawMessage as any).role as "user" | "assistant" | "system" | "tool" | "event",
      content: (rawMessage as any).content,
      ...((rawMessage as any).id && { id: (rawMessage as any).id }),
      ...((rawMessage as any).metadata && { metadata: (rawMessage as any).metadata }),
    };

    // Setup streaming response
    setSSEHeaders(res);

    try {
      const events = this.directSend(sessionId, message as Message);

      for await (const event of events) {
        const sseData = {
          type: event.type,
          sessionId,
          ...(event.data && typeof event.data === "object" ? event.data : {}),
        };
        res.write(`data: ${JSON.stringify(sseData)}\n\n`);
      }

      res.write(`data: ${JSON.stringify({ type: "execution_end", sessionId })}\n\n`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.write(`data: ${JSON.stringify({ type: "error", error: errorMessage, sessionId })}\n\n`);
    } finally {
      res.end();
    }
  }

  private async handleInvoke(req: NodeRequest, res: NodeResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const token = extractToken(req);
    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    const body = await this.parseBody(req);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    const method = body.method as string | undefined;
    const params = (body.params ?? {}) as Record<string, unknown>;

    if (!method || typeof method !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method is required" }));
      return;
    }

    log.debug({ method, params }, "handleInvoke");

    try {
      const result = await this.invokeMethod(method, params, authResult.user);
      log.debug({ method, result }, "handleInvoke: completed");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error({ method, error }, "handleInvoke: failed");
      const errorMessage = error instanceof Error ? error.message : String(error);
      const statusCode = errorMessage.includes("Forbidden") ? 403 : 400;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errorMessage }));
    }
  }

  private async handleSubscribe(req: NodeRequest, res: NodeResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const token = extractToken(req);
    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    const body = await this.parseBody(req);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    // For now just acknowledge - subscriptions are managed per-connection
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleAbort(req: NodeRequest, res: NodeResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const token = extractToken(req);
    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    const body = await this.parseBody(req);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    // TODO: Implement abort
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  private async handleCloseEndpoint(req: NodeRequest, res: NodeResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const token = extractToken(req);
    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    const body = await this.parseBody(req);
    if (!body?.sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "sessionId is required" }));
      return;
    }

    await this.sessions.close(body.sessionId as string);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  /**
   * Channel endpoint - handles channel pub/sub operations.
   */
  private async handleChannel(req: NodeRequest, res: NodeResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    const token = extractToken(req);
    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const prefix = this.config.httpPathPrefix ?? "";
    const path = url.pathname.replace(prefix, "") || "/";

    const body = await this.parseBody(req);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    const sessionId = body.sessionId as string | undefined;
    const channelName = body.channel as string | undefined;
    const clientId = body.clientId as string | undefined;

    if (!sessionId || !channelName) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "sessionId and channel are required" }));
      return;
    }

    if (path === "/channel/subscribe" || path === "/channel") {
      await this.subscribeToChannel(sessionId, channelName, clientId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else if (path === "/channel/publish") {
      const payload = body.payload;
      await this.publishToChannel(sessionId, channelName, payload);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unknown channel operation" }));
    }
  }

  /**
   * Subscribe a client to a session's channel.
   * Sets up forwarding from core session channel to SSE clients.
   */
  private async subscribeToChannel(
    sessionId: string,
    channelName: string,
    clientId?: string,
  ): Promise<void> {
    const subscriptionKey = `${sessionId}:${channelName}`;

    // Add client to subscription list (if provided)
    if (clientId) {
      let clientIds = this.channelSubscriptions.get(subscriptionKey);
      if (!clientIds) {
        clientIds = new Set();
        this.channelSubscriptions.set(subscriptionKey, clientIds);
      }
      clientIds.add(clientId);
    }

    // If we already have a core channel subscription for this session:channel, we're done
    if (this.coreChannelUnsubscribes.has(subscriptionKey)) {
      return;
    }

    // Get or create the managed session and core session
    const managedSession = await this.sessions.getOrCreate(sessionId);
    if (!managedSession.coreSession) {
      managedSession.coreSession = managedSession.appInfo.app.session({
        sessionId: managedSession.state.id,
      });
    }

    // Subscribe to the core session's channel
    const coreChannel = managedSession.coreSession.channel(channelName);
    const unsubscribe = coreChannel.subscribe((event) => {
      // Forward channel event to all subscribed SSE clients
      this.forwardChannelEvent(subscriptionKey, event);
    });

    this.coreChannelUnsubscribes.set(subscriptionKey, unsubscribe);
    log.debug({ sessionId, channelName }, "Subscribed to core session channel");
  }

  /**
   * Forward a channel event to all subscribed SSE clients.
   */
  private forwardChannelEvent(
    subscriptionKey: string,
    event: { type: string; channel: string; payload: unknown; metadata?: unknown },
  ): void {
    const clientIds = this.channelSubscriptions.get(subscriptionKey);
    if (!clientIds || clientIds.size === 0) {
      return;
    }

    const [sessionId] = subscriptionKey.split(":");
    const sseData = JSON.stringify({
      type: "channel",
      sessionId,
      channel: event.channel,
      event: {
        type: event.type,
        payload: event.payload,
        metadata: event.metadata,
      },
    });

    for (const clientId of clientIds) {
      const res = this.sseClients.get(clientId);
      if (res && !res.writableEnded) {
        res.write(`data: ${sseData}\n\n`);
      }
    }
  }

  /**
   * Publish an event to a session's channel.
   */
  private async publishToChannel(
    sessionId: string,
    channelName: string,
    payload: unknown,
  ): Promise<void> {
    const managedSession = await this.sessions.getOrCreate(sessionId);
    if (!managedSession.coreSession) {
      managedSession.coreSession = managedSession.appInfo.app.session({
        sessionId: managedSession.state.id,
      });
    }

    const coreChannel = managedSession.coreSession.channel(channelName);
    coreChannel.publish({
      type: "message",
      channel: channelName,
      payload,
    });
  }

  private parseBody(
    req: NodeRequest & { body?: unknown },
  ): Promise<Record<string, unknown> | null> {
    // If body already parsed by Express middleware, use it
    if (req.body && typeof req.body === "object") {
      return Promise.resolve(req.body as Record<string, unknown>);
    }

    // Otherwise, read from stream
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
      req.on("error", () => {
        resolve(null);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Transport Request Handling (standalone mode)
  // ══════════════════════════════════════════════════════════════════════════

  private async handleTransportRequest(
    transport: Transport,
    clientId: string,
    request: RequestMessage,
  ): Promise<void> {
    const client = transport.getClient(clientId);
    if (!client) return;

    const startTime = Date.now();
    const requestId = request.id;
    const sessionKey = (request.params as Record<string, unknown>)?.sessionId as string | undefined;

    // Emit DevTools request event
    if (devToolsEmitter.hasSubscribers()) {
      devToolsEmitter.emitEvent({
        type: "gateway_request",
        executionId: this.config.id,
        requestId,
        method: request.method,
        sessionKey,
        params: request.params as Record<string, unknown>,
        clientId,
        sequence: this.devToolsSequence++,
        timestamp: startTime,
      } as DTGatewayRequestEvent);
    }

    try {
      const result = await this.executeMethod(transport, clientId, request.method, request.params);

      client.send({
        type: "res",
        id: request.id,
        ok: true,
        payload: result,
      });

      // Emit DevTools response event
      if (devToolsEmitter.hasSubscribers()) {
        devToolsEmitter.emitEvent({
          type: "gateway_response",
          executionId: this.config.id,
          requestId,
          ok: true,
          latencyMs: Date.now() - startTime,
          sequence: this.devToolsSequence++,
          timestamp: Date.now(),
        } as DTGatewayResponseEvent);
      }
    } catch (error) {
      const errorCode = "METHOD_ERROR";
      const errorMessage = error instanceof Error ? error.message : String(error);

      client.send({
        type: "res",
        id: request.id,
        ok: false,
        error: {
          code: errorCode,
          message: errorMessage,
        },
      });

      // Emit DevTools response event with error
      if (devToolsEmitter.hasSubscribers()) {
        devToolsEmitter.emitEvent({
          type: "gateway_response",
          executionId: this.config.id,
          requestId,
          ok: false,
          latencyMs: Date.now() - startTime,
          error: {
            code: errorCode,
            message: errorMessage,
          },
          sequence: this.devToolsSequence++,
          timestamp: Date.now(),
        } as DTGatewayResponseEvent);
      }
    }
  }

  private async executeMethod(
    transport: Transport,
    clientId: string,
    method: GatewayMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // Built-in methods first
    switch (method) {
      case "send":
        return this.handleSendMethod(transport, clientId, params as unknown as SendParams);

      case "abort":
        return this.handleAbortMethod(params as unknown as { sessionId: string });

      case "status":
        return this.handleStatusMethod(params as unknown as StatusParams);

      case "history":
        return this.handleHistoryMethod(params as unknown as HistoryParams);

      case "reset":
        return this.handleResetMethod(params as unknown as { sessionId: string });

      case "close":
        return this.handleCloseMethod(params as unknown as { sessionId: string });

      case "apps":
        return this.handleAppsMethod();

      case "sessions":
        return this.handleSessionsMethod();

      case "subscribe":
        return this.handleSubscribeMethod(
          transport,
          clientId,
          params as unknown as SubscribeParams,
        );

      case "unsubscribe":
        return this.handleUnsubscribeMethod(
          transport,
          clientId,
          params as unknown as SubscribeParams,
        );
    }

    // Check custom methods
    const procedure = this.getMethodProcedure(method);
    if (procedure) {
      return this.executeCustomMethod(transport, clientId, method, params);
    }

    throw new Error(`Unknown method: ${method}`);
  }

  /**
   * Execute a custom method within Tentickle ALS context.
   */
  private async executeCustomMethod(
    transport: Transport,
    clientId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const client = transport.getClient(clientId);
    const sessionId = params.sessionId as string | undefined;

    // Build metadata: gateway fields + client auth metadata + per-request metadata
    const metadata = {
      sessionId,
      clientId,
      gatewayId: this.config.id,
      method,
      ...client?.state.metadata,
      ...(params.metadata as Record<string, unknown> | undefined),
    };

    // Create kernel context
    const ctx = Context.create({
      user: client?.state.user,
      metadata,
    });

    // Get the procedure
    const procedure = this.getMethodProcedure(method);
    if (!procedure) {
      throw new Error(`Unknown method: ${method}`);
    }

    // Execute within context
    // Procedure handles: context forking, middleware (guards), schema validation, metrics
    const result = await Context.run(ctx, async () => {
      const handle = await procedure(params);
      return handle.result;
    });

    // Handle streaming results
    if (result && typeof result === "object" && Symbol.asyncIterator in result) {
      const generator = result as AsyncGenerator<unknown>;
      const chunks: unknown[] = [];

      for await (const chunk of generator) {
        // Emit chunk to subscribers
        if (sessionId) {
          this.sendEventToSubscribers(sessionId, "method:chunk", {
            method,
            chunk,
          });
        }
        chunks.push(chunk);
      }

      // Emit end event
      if (sessionId) {
        this.sendEventToSubscribers(sessionId, "method:end", { method });
      }

      return { streaming: true, chunks };
    }

    return result;
  }

  private async handleSendMethod(
    transport: Transport,
    clientId: string,
    params: SendParams,
  ): Promise<{ messageId: string }> {
    const { sessionId, message } = params;

    // Get or create managed session (SessionManager emits DevTools event if new)
    const managedSession = await this.sessions.getOrCreate(sessionId, clientId);

    // Auto-subscribe sender to session events
    const client = transport.getClient(clientId);
    if (client) {
      client.state.subscriptions.add(managedSession.state.id);
      this.sessions.subscribe(managedSession.state.id, clientId);
    }

    // Mark session as active
    this.sessions.setActive(managedSession.state.id, true);

    // Get or create core session from app
    if (!managedSession.coreSession) {
      managedSession.coreSession = managedSession.appInfo.app.session({
        sessionId: managedSession.state.id,
      });
    }

    // Stream execution to subscribers
    const messageId = `msg-${Date.now().toString(36)}`;

    // Execute in background and stream events
    this.executeAndStream(managedSession.state.id, managedSession.coreSession, message).catch(
      (error) => {
        this.sendEventToSubscribers(managedSession.state.id, "error", {
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );

    // Increment message count (SessionManager emits DevTools event)
    this.sessions.incrementMessageCount(managedSession.state.id, clientId);

    this.emit("session:message", {
      sessionId: managedSession.state.id,
      role: "user",
      content: message,
    });

    return { messageId };
  }

  private async executeAndStream(
    sessionId: string,
    coreSession: import("@tentickle/core").Session,
    messageText: string,
  ): Promise<void> {
    try {
      // Construct a proper Message object from the string
      const message = {
        role: "user" as const,
        content: [{ type: "text" as const, text: messageText }],
      };

      const execution = coreSession.send({ message });

      for await (const event of execution) {
        // Map core events to gateway events
        this.sendEventToSubscribers(sessionId, event.type, event);
      }

      // Send execution_end event
      this.sendEventToSubscribers(sessionId, "execution_end", {});
    } finally {
      this.sessions.setActive(sessionId, false);
    }
  }

  private sendEventToSubscribers(sessionId: string, eventType: string, data: unknown): void {
    const subscribers = this.sessions.getSubscribers(sessionId);

    // Send to all clients across all transports
    for (const transport of this.transports) {
      for (const clientId of subscribers) {
        const client = transport.getClient(clientId);
        if (client) {
          client.send({
            type: "event",
            event: eventType as GatewayEventType,
            sessionId,
            data,
          });
        }
      }
    }
  }

  /**
   * Direct send handler for HTTP transport.
   * Returns an async generator that yields events for streaming.
   * Accepts full Message object to support multimodal content (images, audio, video, docs).
   */
  private async *directSend(
    sessionId: string,
    message: Message,
  ): AsyncGenerator<{ type: string; data?: unknown }> {
    // Get or create managed session
    const managedSession = await this.sessions.getOrCreate(sessionId);

    // Mark session as active
    this.sessions.setActive(managedSession.state.id, true);

    // Get or create core session from app
    if (!managedSession.coreSession) {
      managedSession.coreSession = managedSession.appInfo.app.session({
        sessionId: managedSession.state.id,
      });
    }

    try {
      const execution = managedSession.coreSession.send({ message });

      // Increment message count
      this.sessions.incrementMessageCount(managedSession.state.id);

      // Extract text content for logging (first text block if any)
      const textContent = message.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join(" ");

      this.emit("session:message", {
        sessionId: managedSession.state.id,
        role: "user",
        content: textContent || "[multimodal content]",
      });

      for await (const event of execution) {
        // Also send to WebSocket subscribers
        this.sendEventToSubscribers(managedSession.state.id, event.type, event);

        // Yield event for HTTP streaming
        yield { type: event.type, data: event };
      }
    } finally {
      this.sessions.setActive(managedSession.state.id, false);
    }
  }

  /**
   * Invoke a custom method directly (for HTTP transport).
   * Called with pre-authenticated user context.
   */
  private async invokeMethod(
    method: string,
    params: Record<string, unknown>,
    user?: UserContext,
  ): Promise<unknown> {
    const procedure = this.getMethodProcedure(method);
    if (!procedure) {
      throw new Error(`Unknown method: ${method}`);
    }

    const sessionId = params.sessionId as string | undefined;

    // Build metadata
    const metadata = {
      sessionId,
      gatewayId: this.config.id,
      method,
      ...(params.metadata as Record<string, unknown> | undefined),
    };

    // Create kernel context
    const ctx = Context.create({
      user,
      metadata,
    });

    // Execute within context
    // Procedures return ExecutionHandle by default - access .result to get the handler's return value
    const result = await Context.run(ctx, async () => {
      const handle = await procedure(params);
      return handle.result;
    });

    // Handle streaming results (collect all chunks)
    if (result && typeof result === "object" && Symbol.asyncIterator in result) {
      const iterable = result as AsyncIterable<unknown>;
      const chunks: unknown[] = [];

      for await (const chunk of iterable) {
        chunks.push(chunk);
      }

      return { streaming: true, chunks };
    }

    return result;
  }

  private async handleAbortMethod(params: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    // TODO: Implement execution abortion
  }

  private handleStatusMethod(params: StatusParams): StatusPayload {
    const result: StatusPayload = {
      gateway: this.status,
    };

    if (params.sessionId) {
      const session = this.sessions.get(params.sessionId);
      if (session) {
        result.session = {
          id: session.state.id,
          appId: session.state.appId,
          messageCount: session.state.messageCount,
          createdAt: session.state.createdAt.toISOString(),
          lastActivityAt: session.state.lastActivityAt.toISOString(),
          isActive: session.state.isActive,
        };
      }
    }

    return result;
  }

  private async handleHistoryMethod(
    params: HistoryParams,
  ): Promise<{ messages: unknown[]; hasMore: boolean }> {
    // TODO: Implement history retrieval from persistence
    return { messages: [], hasMore: false };
  }

  private async handleResetMethod(params: { sessionId: string }): Promise<void> {
    // SessionManager.reset() emits DevTools event
    await this.sessions.reset(params.sessionId);
    this.emit("session:closed", { sessionId: params.sessionId });
  }

  private async handleCloseMethod(params: { sessionId: string }): Promise<void> {
    // SessionManager.close() emits DevTools event
    await this.sessions.close(params.sessionId);
    this.emit("session:closed", { sessionId: params.sessionId });
  }

  private handleAppsMethod(): AppsPayload {
    return {
      apps: this.registry.all().map((appInfo) => ({
        id: appInfo.id,
        name: appInfo.name ?? appInfo.id,
        description: appInfo.description,
        isDefault: appInfo.isDefault,
      })),
    };
  }

  private handleSessionsMethod(): SessionsPayload {
    return {
      sessions: this.sessions.all().map((s) => ({
        id: s.state.id,
        appId: s.state.appId,
        createdAt: s.state.createdAt.toISOString(),
        lastActivityAt: s.state.lastActivityAt.toISOString(),
        messageCount: s.state.messageCount,
      })),
    };
  }

  private handleSubscribeMethod(
    transport: Transport,
    clientId: string,
    params: SubscribeParams,
  ): void {
    const client = transport.getClient(clientId);
    if (client) {
      client.state.subscriptions.add(params.sessionId);
      this.sessions.subscribe(params.sessionId, clientId);
    }
  }

  private handleUnsubscribeMethod(
    transport: Transport,
    clientId: string,
    params: SubscribeParams,
  ): void {
    const client = transport.getClient(clientId);
    if (client) {
      client.state.subscriptions.delete(params.sessionId);
      this.sessions.unsubscribe(params.sessionId, clientId);
    }
  }

  private createGatewayContext(): GatewayContext {
    return {
      sendToSession: async (sessionId, message) => {
        // Internal send (from channels)
        const managedSession = await this.sessions.getOrCreate(sessionId);

        if (!managedSession.coreSession) {
          managedSession.coreSession = managedSession.appInfo.app.session({
            sessionId: managedSession.state.id,
          });
        }

        await this.executeAndStream(managedSession.state.id, managedSession.coreSession, message);
      },

      getApps: () => this.registry.ids(),

      getSession: (sessionId) => {
        const managedSession = this.sessions.get(sessionId);
        if (!managedSession) {
          throw new Error(`Session not found: ${sessionId}`);
        }

        return {
          id: managedSession.state.id,
          appId: managedSession.state.appId,
          send: async function* (message: string): AsyncGenerator<SessionEvent> {
            // TODO: Implement session send for channel context
            yield { type: "message_end", data: {} };
          },
        };
      },
    };
  }
}

// Type declaration for EventEmitter
export interface Gateway {
  on<K extends keyof GatewayEvents>(event: K, listener: (payload: GatewayEvents[K]) => void): this;
  emit<K extends keyof GatewayEvents>(event: K, payload: GatewayEvents[K]): boolean;
}

/**
 * Create a gateway instance
 */
export function createGateway(config: GatewayConfig): Gateway {
  return new Gateway(config);
}
