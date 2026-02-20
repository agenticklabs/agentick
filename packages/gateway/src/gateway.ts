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
import type { Message } from "@agentick/shared";
import { GuardError, isGuardError, extractText } from "@agentick/shared";
import {
  devToolsEmitter,
  type DTClientConnectedEvent,
  type DTClientDisconnectedEvent,
  type DTGatewayRequestEvent,
  type DTGatewayResponseEvent,
} from "@agentick/shared";
import {
  Context,
  createProcedure,
  createGuard,
  Logger,
  type KernelContext,
  type Procedure,
  type Middleware,
  type UserContext,
  type ChannelServiceInterface,
  type ChannelEvent,
} from "@agentick/kernel";
import type { Session } from "@agentick/core";

const log = Logger.for("Gateway");
import { extractToken, validateAuth, setSSEHeaders, type AuthResult } from "@agentick/server";
import { AppRegistry } from "./app-registry.js";
import { SessionManager } from "./session-manager.js";
import { WSTransport } from "./ws-transport.js";
import { HTTPTransport } from "./http-transport.js";
import { EmbeddedSSETransport } from "./sse-transport.js";
import type { ClientTransport, SendInput, StreamEvent } from "@agentick/shared";
import type { Transport, TransportClient } from "./transport.js";
import { LocalGatewayTransport } from "./local-transport.js";
import { UnixSocketTransport } from "./unix-socket-transport.js";
import { ClientEventBuffer } from "./client-event-buffer.js";
import type {
  GatewayConfig,
  GatewayEvents,
  GatewayHandle,
  GatewayPlugin,
  PluginContext,
  MethodNamespace,
  MethodDefinition,
  SimpleMethodHandler,
} from "./types.js";
import { isMethodDefinition } from "./types.js";
import type {
  RequestMessage,
  GatewayMethod,
  GatewayEventType,
  GatewayMessage,
  EventMessage,
  SendParams,
  StatusParams,
  HistoryParams,
  SubscribeParams,
  StatusPayload,
  AppsPayload,
  SessionsPayload,
} from "./transport-protocol.js";

const DEFAULT_PORT = 18789;
const DEFAULT_HOST = "127.0.0.1";

// ============================================================================
// Guard Middleware
// ============================================================================

/** Guard middleware that checks user roles */
function createRoleGuardMiddleware(roles: string[]): Middleware<any[]> {
  return createGuard({ name: "gateway-role", guardType: "role" }, () => {
    const userRoles = Context.get().user?.roles ?? [];
    if (!roles.some((r) => userRoles.includes(r))) {
      throw GuardError.role(roles);
    }
    return true;
  });
}

/** Guard middleware that runs custom guard function */
function createCustomGuardMiddleware(
  guard: (ctx: KernelContext) => boolean | Promise<boolean>,
): Middleware<any[]> {
  return createGuard({ name: "gateway-custom", reason: "Guard check failed" }, () =>
    guard(Context.get()),
  );
}

// ============================================================================
// Channel Service Helpers
// ============================================================================

/**
 * Create a ChannelServiceInterface that wraps a Session's channel() method.
 * This allows gateway methods to access session channels via Context.
 */
function createChannelServiceFromSession(
  session: Session,
  _gatewayId: string,
): ChannelServiceInterface {
  return {
    getChannel: (_ctx: KernelContext, channelName: string) => session.channel(channelName),
    publish: (_ctx: KernelContext, channelName: string, event: Omit<ChannelEvent, "channel">) => {
      session.channel(channelName).publish({ ...event, channel: channelName } as ChannelEvent);
    },
    subscribe: (
      _ctx: KernelContext,
      channelName: string,
      handler: (event: ChannelEvent) => void,
    ) => {
      return session.channel(channelName).subscribe(handler);
    },
    waitForResponse: (
      _ctx: KernelContext,
      channelName: string,
      requestId: string,
      timeoutMs?: number,
    ) => {
      return session.channel(channelName).waitForResponse(requestId, timeoutMs);
    },
  };
}

// ============================================================================
// Gateway Class
// ============================================================================

// ============================================================================
// Helpers
// ============================================================================

/** Extract first text content from SendInput for logging */
function extractTextFromInput(input: SendInput): string {
  if (!input.messages?.length) return "[no content]";
  const texts = input.messages.map((msg) => extractText(msg.content, " ")).filter(Boolean);
  return texts.join(" ") || "[multimodal content]";
}

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

  /** SSE transport for embedded mode (initialized in constructor when embedded: true) */
  private sseTransport: EmbeddedSSETransport | null = null;

  /** Track channel subscriptions: "sessionId:channelName" -> Set of clientIds */
  private channelSubscriptions = new Map<string, Set<string>>();

  /** Track unsubscribe functions for core session channels */
  private coreChannelUnsubscribes = new Map<string, () => void>();

  /** Track client connection times for duration calculation */
  private clientConnectedAt = new Map<string, number>();

  /** Shared local transport instance (created lazily) */
  private _localTransport: LocalGatewayTransport | null = null;

  /** Per-client event buffers for backpressure */
  private clientBuffers = new Map<string, ClientEventBuffer>();

  /** Sequence counter for DevTools events */
  private devToolsSequence = 0;

  /** Registered plugins: id -> { plugin, ctx } */
  private plugins = new Map<string, { plugin: GatewayPlugin; ctx: PluginContext }>();

  /** Track which plugin owns which method: method path -> pluginId */
  private pluginMethodOwnership = new Map<string, string>();

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

    // Create transports
    if (this.embedded) {
      // Embedded mode: SSE transport for handleRequest() path
      this.sseTransport = new EmbeddedSSETransport();
      this.setupTransportHandlers(this.sseTransport);
      this.transports.push(this.sseTransport);
    } else {
      // Standalone mode: WS and/or HTTP transports
      this.initializeTransports();
    }

    // Initialize plugins from config (fire-and-forget — errors logged, not thrown)
    if (config.plugins) {
      for (const plugin of config.plugins) {
        this.use(plugin).catch((err) => console.error(`Plugin ${plugin.id} init failed:`, err));
      }
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

    // Unix socket — orthogonal to WS/HTTP, can run alongside them
    if (this.config.socketPath) {
      const unixTransport = new UnixSocketTransport({
        socketPath: this.config.socketPath,
        auth,
      });
      this.setupTransportHandlers(unixTransport);
      this.transports.push(unixTransport);
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
          transport: transport.type as "websocket" | "sse" | "http" | "local",
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

      // Clean up subscriptions and buffer
      this.sessions.unsubscribeAll(clientId);
      this.cleanupClientChannelSubscriptions(clientId);
      const buffer = this.clientBuffers.get(clientId);
      if (buffer) {
        buffer.clear();
        this.clientBuffers.delete(clientId);
      }

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

    // Destroy plugins in reverse registration order
    const entries = [...this.plugins.values()].reverse();
    for (const { plugin } of entries) {
      await plugin
        .destroy()
        .catch((err) => console.error(`Plugin ${plugin.id} destroy failed:`, err));
    }
    this.plugins.clear();

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

  // ══════════════════════════════════════════════════════════════════════════
  // Public Session API (used by local transport and external callers)
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get or create a session with multi-app routing.
   * Parses session key (e.g., "coding:main") and routes to the correct app.
   */
  async session(sessionKey: string): Promise<Session> {
    const managedSession = await this.sessions.getOrCreate(sessionKey);
    if (!managedSession.coreSession || managedSession.coreSession.isTerminal) {
      // Inject gateway handle into ALS context before session creation.
      // Session captures this in _capturedContext. All subsequent tick
      // executions merge it via runWithContext.
      const gatewayHandle: GatewayHandle = {
        invoke: (method: string, params: unknown) =>
          this.invokeMethod(method, params as Record<string, unknown>),
        use: (plugin: GatewayPlugin) => this.use(plugin),
        remove: (pluginId: string) => this.remove(pluginId),
      };

      const ctx = Context.create({
        metadata: { gateway: gatewayHandle },
      });

      managedSession.coreSession = await Context.run(ctx, () =>
        managedSession.appInfo.app.session(managedSession.sessionName),
      );
    }
    return managedSession.coreSession;
  }

  /**
   * Close a session and clean up managed state.
   */
  async closeSession(sessionKey: string): Promise<void> {
    await this.sessions.close(sessionKey);
    this.emit("session:closed", { sessionId: sessionKey });
  }

  /**
   * Subscribe a client to session events.
   */
  async subscribe(sessionKey: string, clientId: string): Promise<void> {
    await this.sessions.subscribe(sessionKey, clientId);
  }

  /**
   * Unsubscribe a client from session events.
   */
  unsubscribe(sessionKey: string, clientId: string): void {
    this.sessions.unsubscribe(sessionKey, clientId);
  }

  /**
   * Send a message to a session and stream events.
   * Broadcasts events to all subscribers (cross-client push), excluding
   * the sender who iterates the handle directly.
   *
   * @param senderClientId - If provided, this client is excluded from
   *   push broadcasts (they get events through direct handle iteration).
   */
  async sendToSession(sessionKey: string, input: SendInput, senderClientId?: string) {
    const session = await this.session(sessionKey);
    const handle = await session.send(input);

    // Broadcast events to OTHER subscribers in background.
    // The sender iterates the handle directly — excluding them from
    // broadcast prevents double-dispatch. handle.events creates an
    // independent iterator (EventBuffer supports dual consumption).
    const broadcast = this.iterateWithBroadcast(sessionKey, handle.events, input, {
      excludeClientId: senderClientId,
    });
    (async () => {
      for await (const _ of broadcast) {
      }
    })().catch((error) => {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
    });

    return handle;
  }

  /**
   * Unified execution path: get session, send, iterate events, broadcast.
   * Used by WS, HTTP, and channel adapter paths.
   */
  private async *executeSession(
    sessionKey: string,
    input: SendInput,
    opts?: { excludeClientId?: string; clientId?: string },
  ): AsyncGenerator<StreamEvent> {
    const session = await this.session(sessionKey);
    const handle = await session.send(input);
    yield* this.iterateWithBroadcast(sessionKey, handle, input, opts);
  }

  /**
   * Core state management loop: activate session, track message,
   * iterate events with broadcast, deactivate on completion.
   *
   * Both executeSession (yields to caller) and sendToSession
   * (broadcasts in background) delegate here. The source is any
   * AsyncIterable<StreamEvent> — a handle or handle.events.
   */
  private async *iterateWithBroadcast(
    sessionKey: string,
    source: AsyncIterable<StreamEvent>,
    input: SendInput,
    opts?: { excludeClientId?: string; clientId?: string },
  ): AsyncGenerator<StreamEvent> {
    this.sessions.setActive(sessionKey, true);
    try {
      this.trackMessage(sessionKey, input, opts?.clientId);
      for await (const event of source) {
        this.sendEventToSubscribers(sessionKey, event.type, event, opts?.excludeClientId);
        yield event;
      }
      this.sendEventToSubscribers(sessionKey, "execution_end", {}, opts?.excludeClientId);
    } finally {
      this.sessions.setActive(sessionKey, false);
    }
  }

  /**
   * Track a user message for state management.
   * Increments message count and emits session:message event.
   */
  private trackMessage(sessionKey: string, input: SendInput, clientId?: string): void {
    this.sessions.incrementMessageCount(sessionKey, clientId);
    this.emit("session:message", {
      sessionId: sessionKey,
      role: "user",
      content: extractTextFromInput(input),
    });
  }

  /**
   * Create an in-process ClientTransport connected to this gateway.
   * Returns a ClientTransport for use with createClient().
   *
   * Multiple calls create independent clients sharing the same
   * underlying LocalGatewayTransport.
   */
  createLocalTransport(): ClientTransport {
    if (!this._localTransport) {
      this._localTransport = new LocalGatewayTransport();
      this.setupTransportHandlers(this._localTransport);
      this.transports.push(this._localTransport);
    }
    return this._localTransport.createClientTransport(this);
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

    // Register as a real transport client — gets backpressure, DevTools,
    // appears in gateway.status.clients, cleaned up on disconnect
    this.sseTransport!.registerClient(clientId, res);

    // Connection confirmation is written directly to the response rather than
    // going through client.send() because it's a handshake message — not a
    // GatewayMessage variant. The client resolves its connection promise on
    // receiving { type: "connection" }. This is the same pattern HTTP and WS
    // transports use for their initial handshake.
    res.write(
      `data: ${JSON.stringify({ type: "connection", connectionId: clientId, subscriptions: [] })}\n\n`,
    );
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
    log.debug({ method: req.method, url: req.url }, "handleSend: START");

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
    log.debug({ body }, "handleSend: parsed body");
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    const sessionId = (body.sessionId as string) ?? "main";
    const rawMessages = body.messages;
    log.debug({ sessionId, hasMessages: !!rawMessages }, "handleSend: extracted params");

    if (!Array.isArray(rawMessages) || rawMessages.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid message format. Expected { messages: Message[] }",
        }),
      );
      return;
    }

    // Use the first message for the directSend path (single-message execution)
    const rawMessage = rawMessages[0] as any;
    const message = {
      role: rawMessage.role as "user" | "assistant" | "system" | "tool" | "event",
      content: rawMessage.content,
      ...(rawMessage.id && { id: rawMessage.id }),
      ...(rawMessage.metadata && { metadata: rawMessage.metadata }),
    };

    // Setup streaming response
    setSSEHeaders(res);

    try {
      log.debug({ sessionId }, "handleSend: calling directSend");
      const events = this.directSend(sessionId, message as Message);

      for await (const event of events) {
        log.debug({ eventType: event.type }, "handleSend: got event from directSend");
        const message: EventMessage = {
          type: "event",
          event: event.type as GatewayEventType,
          sessionId,
          data: event.data,
        };
        res.write(`data: ${JSON.stringify(message)}\n\n`);
      }

      log.debug({ sessionId }, "handleSend: directSend complete, sending execution_end");
      res.write(
        `data: ${JSON.stringify({ type: "event", event: "execution_end", sessionId, data: {} } satisfies EventMessage)}\n\n`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error("[Gateway handleSend ERROR]", errorMessage, "\n", errorStack);
      log.error({ errorMessage, errorStack, sessionId }, "handleSend: ERROR in directSend");
      res.write(
        `data: ${JSON.stringify({ type: "event", event: "error", sessionId, data: { error: errorMessage } } satisfies EventMessage)}\n\n`,
      );
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

    const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const startTime = Date.now();
    const sessionKey = params.sessionId as string | undefined;

    // Emit DevTools request event
    if (devToolsEmitter.hasSubscribers()) {
      devToolsEmitter.emitEvent({
        type: "gateway_request",
        executionId: this.config.id,
        requestId,
        method,
        sessionKey,
        params,
        sequence: this.devToolsSequence++,
        timestamp: startTime,
      } as DTGatewayRequestEvent);
    }

    try {
      const result = await this.invokeMethod(method, params, authResult.user);
      log.debug({ method, result }, "handleInvoke: completed");

      // Emit DevTools response event
      if (devToolsEmitter.hasSubscribers()) {
        devToolsEmitter.emitEvent({
          type: "gateway_response",
          executionId: this.config.id,
          requestId,
          method,
          ok: true,
          latencyMs: Date.now() - startTime,
          sequence: this.devToolsSequence++,
          timestamp: Date.now(),
        } as DTGatewayResponseEvent);
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      log.error({ method, error }, "handleInvoke: failed");
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Emit DevTools response event for error
      if (devToolsEmitter.hasSubscribers()) {
        devToolsEmitter.emitEvent({
          type: "gateway_response",
          executionId: this.config.id,
          requestId,
          method,
          ok: false,
          error: { code: "INVOKE_ERROR", message: errorMessage },
          latencyMs: Date.now() - startTime,
          sequence: this.devToolsSequence++,
          timestamp: Date.now(),
        } as DTGatewayResponseEvent);
      }

      const statusCode = isGuardError(error) ? 403 : 400;
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

    // Support both formats:
    // - { sessionId, clientId } - simple format
    // - { connectionId, add: [...], remove: [...] } - client format
    const clientId = (body.clientId ?? body.connectionId) as string | undefined;

    if (!clientId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "clientId or connectionId is required" }));
      return;
    }

    // Handle additions
    const addSessionIds: string[] = [];
    if (body.sessionId) {
      addSessionIds.push(body.sessionId as string);
    }
    if (Array.isArray(body.add)) {
      addSessionIds.push(...(body.add as string[]));
    }

    // Handle removals
    const removeSessionIds: string[] = [];
    if (Array.isArray(body.remove)) {
      removeSessionIds.push(...(body.remove as string[]));
    }

    if (addSessionIds.length === 0 && removeSessionIds.length === 0) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "sessionId, add[], or remove[] is required" }));
      return;
    }

    // Process subscriptions
    for (const sessionId of addSessionIds) {
      await this.sessions.subscribe(sessionId, clientId);
    }
    for (const sessionId of removeSessionIds) {
      this.sessions.unsubscribe(sessionId, clientId);
    }

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
    if (!managedSession.coreSession || managedSession.coreSession.isTerminal) {
      // Use sessionName (without app prefix) for App - Gateway handles routing
      managedSession.coreSession = await managedSession.appInfo.app.session(
        managedSession.sessionName,
      );
    }

    // Subscribe to the core session's channel and forward events to SSE clients
    const coreChannel = managedSession.coreSession.channel(channelName);
    const unsubscribe = coreChannel.subscribe((event) => {
      this.forwardChannelEvent(subscriptionKey, event);
    });

    this.coreChannelUnsubscribes.set(subscriptionKey, unsubscribe);
    log.debug({ sessionId, channelName }, "Channel forwarding established");
  }

  /**
   * Forward a channel event to all subscribed clients.
   */
  private forwardChannelEvent(
    subscriptionKey: string,
    event: { type: string; channel: string; payload: unknown; metadata?: unknown },
  ): void {
    const clientIds = this.channelSubscriptions.get(subscriptionKey);
    if (!clientIds || clientIds.size === 0) {
      return;
    }

    // subscriptionKey format is "sessionId:channelName" where sessionId can contain ":"
    // e.g., "assistant:default:todo-list" → sessionId="assistant:default", channel="todo-list"
    // Extract sessionId by removing the last segment (channelName)
    const lastColonIndex = subscriptionKey.lastIndexOf(":");
    const sessionId = subscriptionKey.substring(0, lastColonIndex);

    const message: EventMessage = {
      type: "event",
      event: "channel" as GatewayEventType,
      sessionId,
      data: {
        channel: event.channel,
        event: {
          type: event.type,
          payload: event.payload,
          metadata: event.metadata,
        },
      },
    };

    for (const clientId of clientIds) {
      this.deliverToClient(clientId, message);
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
    if (!managedSession.coreSession || managedSession.coreSession.isTerminal) {
      // Use sessionName (without app prefix) for App - Gateway handles routing
      managedSession.coreSession = await managedSession.appInfo.app.session(
        managedSession.sessionName,
      );
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

      case "channel-subscribe": {
        const { sessionId, channel } = params as { sessionId: string; channel: string };
        if (!sessionId || !channel) throw new Error("sessionId and channel are required");
        await this.subscribeToChannel(sessionId, channel, clientId);
        return { ok: true };
      }

      case "channel": {
        const { sessionId, channel, payload } = params as {
          sessionId: string;
          channel: string;
          payload?: unknown;
        };
        if (!sessionId || !channel) throw new Error("sessionId and channel are required");
        await this.publishToChannel(sessionId, channel, payload);
        return { ok: true };
      }
    }

    // Check custom methods
    const procedure = this.getMethodProcedure(method);
    if (procedure) {
      return this.executeCustomMethod(transport, clientId, method, params);
    }

    throw new Error(`Unknown method: ${method}`);
  }

  /**
   * Execute a custom method within Agentick ALS context.
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

    // Auto-subscribe sender to session events (transport concern)
    const client = transport.getClient(clientId);
    if (client) {
      client.state.subscriptions.add(sessionId);
      await this.sessions.subscribe(sessionId, clientId);
    }

    const input: SendInput = {
      messages: [{ role: "user", content: [{ type: "text", text: message }] }],
    };

    const messageId = `msg-${Date.now().toString(36)}`;

    // Execute in background — executeSession handles state management
    const gen = this.executeSession(sessionId, input, { clientId });
    (async () => {
      for await (const _ of gen) {
        /* drain */
      }
    })().catch((error) => {
      this.sendEventToSubscribers(sessionId, "error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });

    return { messageId };
  }

  private deliverToClient(clientId: string, message: GatewayMessage): void {
    for (const transport of this.transports) {
      const client = transport.getClient(clientId);
      if (client) {
        this.getOrCreateBuffer(client).push(message);
        return;
      }
    }
  }

  private getOrCreateBuffer(client: TransportClient): ClientEventBuffer {
    let buffer = this.clientBuffers.get(client.id);
    if (!buffer) {
      buffer = new ClientEventBuffer(client);
      this.clientBuffers.set(client.id, buffer);
    }
    return buffer;
  }

  private sendEventToSubscribers(
    sessionId: string,
    eventType: string,
    data: unknown,
    excludeClientId?: string,
  ): void {
    const subscribers = this.sessions.getSubscribers(sessionId);
    const message: EventMessage = {
      type: "event",
      event: eventType as GatewayEventType,
      sessionId,
      data,
    };

    for (const clientId of subscribers) {
      if (clientId === excludeClientId) continue;
      this.deliverToClient(clientId, message);
    }
  }

  /**
   * Direct send handler for HTTP transport.
   * Returns an async generator that yields events for streaming.
   * Accepts full Message object to support multimodal content (images, audio, video, docs).
   *
   * IMPORTANT: Uses the original sessionId (as provided by client) for events,
   * not the normalized internal ID. This ensures clients can match events to their sessions.
   */
  private async *directSend(
    sessionId: string,
    message: Message,
  ): AsyncGenerator<{ type: string; data?: unknown }> {
    const input: SendInput = { messages: [message] };
    for await (const event of this.executeSession(sessionId, input)) {
      yield { type: event.type, data: event };
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

    // Get or create session to access channels (if sessionId provided)
    let channels: ChannelServiceInterface | undefined = undefined;
    if (sessionId) {
      const managedSession = await this.sessions.getOrCreate(sessionId);
      if (!managedSession.coreSession || managedSession.coreSession.isTerminal) {
        // Use sessionName (without app prefix) for App - Gateway handles routing
        managedSession.coreSession = await managedSession.appInfo.app.session(
          managedSession.sessionName,
        );
      }
      channels = createChannelServiceFromSession(managedSession.coreSession, this.config.id);
    }

    // Build metadata
    const metadata = {
      sessionId,
      gatewayId: this.config.id,
      method,
      ...(params.metadata as Record<string, unknown> | undefined),
    };

    // Create kernel context with channels for pub/sub
    const ctx = Context.create({
      user,
      metadata,
      channels,
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

  private async handleSubscribeMethod(
    transport: Transport,
    clientId: string,
    params: SubscribeParams,
  ): Promise<void> {
    const client = transport.getClient(clientId);
    if (client) {
      client.state.subscriptions.add(params.sessionId);
      await this.sessions.subscribe(params.sessionId, clientId);
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

  // ══════════════════════════════════════════════════════════════════════════
  // Plugin System
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Register a plugin. Calls plugin.initialize() with a PluginContext.
   * Throws if a plugin with the same id is already registered.
   */
  async use(plugin: GatewayPlugin): Promise<void> {
    if (this.plugins.has(plugin.id)) {
      throw new Error(`Plugin "${plugin.id}" is already registered`);
    }

    const ctx = this.createPluginContext(plugin.id);
    try {
      await plugin.initialize(ctx);
    } catch (err) {
      // Clean up any methods registered during partial init
      for (const [path, owner] of this.pluginMethodOwnership.entries()) {
        if (owner === plugin.id) {
          this.methodProcedures.delete(path);
          this.pluginMethodOwnership.delete(path);
        }
      }
      throw err;
    }
    this.plugins.set(plugin.id, { plugin, ctx });
    this.emit("plugin:registered", { pluginId: plugin.id });
  }

  /**
   * Remove a plugin by id. Calls plugin.destroy() and cleans up its methods.
   * No-op if plugin id is not found.
   */
  async remove(pluginId: string): Promise<void> {
    const entry = this.plugins.get(pluginId);
    if (!entry) return;

    await entry.plugin.destroy();

    // Remove all methods this plugin registered
    for (const [path, owner] of this.pluginMethodOwnership.entries()) {
      if (owner === pluginId) {
        this.methodProcedures.delete(path);
        this.pluginMethodOwnership.delete(path);
      }
    }

    this.plugins.delete(pluginId);
    this.emit("plugin:removed", { pluginId });
  }

  /**
   * Get a registered plugin by id.
   */
  getPlugin<T extends GatewayPlugin = GatewayPlugin>(id: string): T | undefined {
    return this.plugins.get(id)?.plugin as T | undefined;
  }

  /**
   * Create a PluginContext scoped to a specific plugin.
   */
  private createPluginContext(pluginId: string): PluginContext {
    return {
      gatewayId: this.config.id,

      sendToSession: async (sessionKey: string, input: SendInput) => {
        return this.sendToSession(sessionKey, input);
      },

      respondToConfirmation: async (sessionKey: string, callId: string, response) => {
        await this.publishToChannel(sessionKey, "tool_confirmation", {
          type: "response",
          channel: "tool_confirmation",
          id: callId,
          payload: response,
        });
      },

      registerMethod: (path: string, handler: SimpleMethodHandler | MethodDefinition) => {
        if (BUILT_IN_METHODS.has(path)) {
          throw new Error(`Cannot override built-in method: ${path}`);
        }
        if (this.methodProcedures.has(path)) {
          throw new Error(`Method "${path}" is already registered`);
        }

        const isDefinition = isMethodDefinition(handler);
        const actualHandler = isDefinition ? (handler as MethodDefinition).handler : handler;

        const middleware: Middleware<any[]>[] = [];
        if (isDefinition) {
          const def = handler as MethodDefinition;
          if (def.roles?.length) {
            middleware.push(createRoleGuardMiddleware(def.roles));
          }
          if (def.guard) {
            middleware.push(createCustomGuardMiddleware(def.guard));
          }
        }

        this.methodProcedures.set(
          path,
          createProcedure(
            {
              name: `gateway:${path}`,
              executionBoundary: "auto",
              schema: isDefinition ? ((handler as MethodDefinition).schema as any) : undefined,
              middleware: middleware.length > 0 ? middleware : undefined,
              metadata: {
                gatewayId: this.config.id,
                method: path,
                pluginId,
                ...(isDefinition && { description: (handler as MethodDefinition).description }),
              },
            },
            actualHandler as (...args: any[]) => any,
          ),
        );
        this.pluginMethodOwnership.set(path, pluginId);
      },

      unregisterMethod: (path: string) => {
        // Only allow unregistering own methods
        if (this.pluginMethodOwnership.get(path) !== pluginId) return;
        this.methodProcedures.delete(path);
        this.pluginMethodOwnership.delete(path);
      },

      invoke: (method: string, params: unknown) =>
        this.invokeMethod(method, params as Record<string, unknown>),

      on: (event, handler) => this.on(event, handler),
      off: (event, handler) => this.off(event, handler),
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
