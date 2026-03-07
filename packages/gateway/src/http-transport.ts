/**
 * HTTP/SSE Transport
 *
 * Implements the Transport interface using HTTP requests and Server-Sent Events.
 * Also handles WebSocket upgrades on the same port, so a single server can
 * serve both browser clients (HTTP/SSE) and WS clients (TUI, native apps).
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, WebSocket } from "ws";
import { extractToken, validateAuth, setSSEHeaders, type AuthResult } from "@agentick/server";
import { isGuardError } from "@agentick/shared";
import type {
  GatewayMessage,
  ClientMessage,
  ConnectMessage,
  RequestMessage,
  EventMessage,
  GatewayEventType,
} from "./transport-protocol.js";
import type { ClientState } from "./types.js";
import type { Message, ToolConfirmationResponse } from "@agentick/shared";
import type { UserContext } from "./types.js";
import { BaseTransport, type TransportClient, type NetworkTransportConfig } from "./transport.js";

/**
 * Event types that are internal to the framework and should never be sent
 * to clients. These contain full prompts, model context, and provider details.
 * DevTools receives these separately via devToolsEmitter.
 */
const INTERNAL_EVENT_TYPES = new Set([
  "compiled",
  "model_request",
  "model_response",
  "provider_request",
  "provider_response",
]);

// ============================================================================
// HTTP Client (SSE connection)
// ============================================================================

class HTTPClientImpl implements TransportClient {
  readonly id: string;
  readonly state: ClientState;
  private response: ServerResponse | null = null;
  private _isConnected = false;

  constructor(id: string) {
    this.id = id;
    this.state = {
      id,
      connectedAt: new Date(),
      authenticated: false,
      subscriptions: new Set(),
    };
  }

  /** Set the SSE response object */
  setResponse(res: ServerResponse): void {
    this.response = res;
    this._isConnected = true;

    res.on("close", () => {
      this._isConnected = false;
      this.response = null;
    });
  }

  send(message: GatewayMessage): void {
    if (this.response && this._isConnected) {
      const data = JSON.stringify(message);
      this.response.write(`data: ${data}\n\n`);
    }
  }

  close(_code?: number, _reason?: string): void {
    if (this.response) {
      this.response.end();
      this.response = null;
    }
    this._isConnected = false;
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  isPressured(): boolean {
    return this.response?.writableNeedDrain ?? false;
  }

  onDrain(callback: () => void): void {
    this.response?.on("drain", callback);
  }
}

// ============================================================================
// WebSocket Client (for WS connections on the HTTP server)
// ============================================================================

class WSClientInHTTP implements TransportClient {
  readonly state: ClientState;
  private socket: WebSocket;

  constructor(
    public id: string,
    socket: WebSocket,
  ) {
    this.socket = socket;
    this.state = {
      id,
      connectedAt: new Date(),
      authenticated: false,
      subscriptions: new Set(),
    };
  }

  send(message: GatewayMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  get isConnected(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  isPressured(): boolean {
    return this.socket.bufferedAmount > 64 * 1024;
  }

  onDrain(callback: () => void): void {
    this.socket.on("drain", callback);
  }

  /** @internal — update client ID (for custom client IDs from connect message) */
  _setId(newId: string): void {
    this.id = newId;
    (this.state as { id: string }).id = newId;
  }
}

// ============================================================================
// HTTP/SSE Transport
// ============================================================================

export interface HTTPTransportConfig extends NetworkTransportConfig {
  /** CORS origin (default: "*") */
  corsOrigin?: string;

  /** Path prefix for all endpoints (default: "") */
  pathPrefix?: string;

  /** Direct send handler for streaming response.
   *  Accepts SendInput (messages array) — the standard client format. */
  onDirectSend?: (
    sessionId: string,
    input: { messages?: Message[]; metadata?: Record<string, unknown> },
    opts?: { excludeClientId?: string },
  ) => AsyncIterable<{ type: string; data?: unknown }>;

  /** Method invocation handler */
  onInvoke?: (
    method: string,
    params: Record<string, unknown>,
    user?: UserContext,
  ) => Promise<unknown>;

  /** Tool confirmation response handler */
  onToolResponse?: (
    sessionId: string,
    toolUseId: string,
    result: ToolConfirmationResponse,
  ) => Promise<void>;

  /** Abort session handler */
  onAbort?: (sessionId: string, reason?: string) => Promise<void>;

  /** Plugin route matcher — called before built-in routes.
   *  Returns true if the route was handled. */
  onRouteMatch?: (
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ) => boolean | Promise<boolean>;
}

export class HTTPTransport extends BaseTransport {
  readonly type = "http" as const;
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  protected override config: HTTPTransportConfig;

  constructor(config: HTTPTransportConfig) {
    super(config);
    this.config = config;
  }

  override start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.server = createServer((req, res) => {
          this.handleRequest(req, res).catch((error) => {
            console.error("Request error:", error);
            if (!res.headersSent) {
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Internal server error" }));
            }
          });
        });

        // WebSocket upgrades on the same port
        this.wss = new WebSocketServer({ noServer: true });
        this.server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
          this.wss!.handleUpgrade(req, socket, head, (ws) => {
            this.handleWSConnection(ws, req);
          });
        });

        this.server.on("error", (error) => {
          this.handlers.error?.(error);
          reject(error);
        });

        this.server.listen(this.config.port, this.config.host, () => {
          resolve();
        });
      } catch (error) {
        reject(error);
      }
    });
  }

  override stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }

      // Close all client connections (both HTTP/SSE and WebSocket)
      for (const client of this.clients.values()) {
        client.close(1001, "Server shutting down");
      }
      this.clients.clear();

      // Close WebSocket server (does not close the HTTP server)
      if (this.wss) {
        this.wss.close();
        this.wss = null;
      }

      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Set CORS headers
    const origin = this.config.corsOrigin ?? "*";
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

    const prefix = this.config.pathPrefix ?? "";
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname.replace(prefix, "");

    // Plugin routes — checked before built-in routes
    if (this.config.onRouteMatch) {
      const handled = await this.config.onRouteMatch(path, req, res);
      if (handled) return;
    }

    // Route requests - exact matches first
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
        return this.handleClose(req, res);
      case "/channel":
        return this.handleChannel(req, res);
      case "/tool-response":
        return this.handleToolResponse(req, res);
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  /**
   * SSE endpoint - establishes long-lived connection for events
   */
  private async handleSSE(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Get auth token from header or query
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const token = extractToken(req) ?? url.searchParams.get("token") ?? undefined;

    // Validate auth
    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    // Create client
    const clientId = url.searchParams.get("clientId") ?? this.generateClientId();
    let client = this.clients.get(clientId) as HTTPClientImpl | undefined;

    if (!client) {
      client = new HTTPClientImpl(clientId);
      client.state.authenticated = true;
      client.state.user = authResult.user;
      client.state.metadata = authResult.metadata;
      this.clients.set(clientId, client);

      // Notify connection handler
      this.handlers.connection?.(client);
    }

    // Setup SSE response
    setSSEHeaders(res);

    client.setResponse(res);

    // Send connection confirmation
    // Client expects type: "connection" to resolve the connection promise
    client.send({
      type: "connection" as any,
      connectionId: clientId,
      subscriptions: Array.from(client.state.subscriptions),
    } as any);

    // Handle disconnect
    res.on("close", () => {
      this.clients.delete(clientId);
      this.handlers.disconnect?.(clientId);
    });

    // Keep connection alive with periodic heartbeat
    const heartbeat = setInterval(() => {
      if (client?.isConnected) {
        res.write(":heartbeat\n\n");
      } else {
        clearInterval(heartbeat);
      }
    }, 30000);

    res.on("close", () => clearInterval(heartbeat));
  }

  /**
   * Send endpoint - receives messages and streams response
   */
  private async handleSend(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Get auth token
    const token = extractToken(req);
    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    // Parse body
    const body = await this.parseBody(req);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    const sessionId = ((body as any).sessionId as string) ?? "main";

    // Accept SendInput format: { messages: Message[], props?, metadata? }
    // Also accept legacy single-message format: { message: { role, content } }
    const rawMessages = (body as any).messages;
    const rawMessage = (body as any).message;

    let input: { messages?: Message[]; props?: unknown; metadata?: Record<string, unknown> };

    if (Array.isArray(rawMessages)) {
      input = { messages: rawMessages, metadata: (body as any).metadata };
    } else if (rawMessage && typeof rawMessage === "object" && rawMessage.role) {
      input = { messages: [rawMessage] };
    } else {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid send format. Expected { messages: Message[] } or { message: Message }",
        }),
      );
      return;
    }

    if (!this.config.onDirectSend) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Send not supported without onDirectSend handler" }));
      return;
    }

    setSSEHeaders(res);

    // Exclude sender's SSE connection from broadcast (they get events via this stream)
    const connectionId = (body as any).connectionId as string | undefined;

    try {
      const events = this.config.onDirectSend(sessionId, input, { excludeClientId: connectionId });

      for await (const event of events) {
        // Skip internal events — these contain full prompts, tools, context
        if (INTERNAL_EVENT_TYPES.has(event.type)) continue;

        const message: EventMessage = {
          type: "event",
          event: event.type as GatewayEventType,
          sessionId,
          data: event.data,
        };
        res.write(`data: ${JSON.stringify(message)}\n\n`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.write(
        `data: ${JSON.stringify({ type: "event", event: "error", sessionId, data: { error: errorMessage } } satisfies EventMessage)}\n\n`,
      );
    } finally {
      res.end();
    }
  }

  /**
   * Invoke endpoint - execute custom gateway methods
   * Returns JSON (not streaming) for simpler client handling
   */
  private async handleInvoke(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // Get auth token
    const token = extractToken(req);
    const authResult = await validateAuth(token, this.config.auth);
    if (!authResult.valid) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Authentication failed" }));
      return;
    }

    // Parse body
    const body = await this.parseBody(req);
    if (!body) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid request body" }));
      return;
    }

    const method = (body as { method?: string }).method;
    const params = ((body as { params?: Record<string, unknown> }).params ?? {}) as Record<
      string,
      unknown
    >;

    if (!method || typeof method !== "string") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "method is required" }));
      return;
    }

    // Check if we have an invoke handler
    if (!this.config.onInvoke) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method invocation not supported" }));
      return;
    }

    try {
      const result = await this.config.onInvoke(method, params, authResult.user);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const statusCode = isGuardError(error) ? 403 : 400;
      res.writeHead(statusCode, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: errorMessage }));
    }
  }

  /**
   * Subscribe endpoint - manage session subscriptions
   */
  private async handleSubscribe(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    const { connectionId, add, remove } = body as {
      connectionId: string;
      add?: string[];
      remove?: string[];
    };

    const client = this.clients.get(connectionId);
    if (!client) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Connection not found" }));
      return;
    }

    // Forward through gateway's RPC handler so SessionManager stays in sync.
    // Same pattern as handleAbort/handleClose.
    if (add) {
      for (const sessionId of add) {
        const requestMessage: RequestMessage = {
          type: "req",
          id: `req-sub-${Date.now().toString(36)}`,
          method: "subscribe",
          params: { sessionId },
        };
        this.handlers.message?.(client.id, requestMessage);
      }
    }
    if (remove) {
      for (const sessionId of remove) {
        const requestMessage: RequestMessage = {
          type: "req",
          id: `req-unsub-${Date.now().toString(36)}`,
          method: "unsubscribe",
          params: { sessionId },
        };
        this.handlers.message?.(client.id, requestMessage);
      }
    }

    // Wait a tick for async handlers to process
    await Promise.resolve();

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        subscriptions: Array.from(client.state.subscriptions),
      }),
    );
  }

  /**
   * Abort endpoint
   */
  private async handleAbort(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    const { sessionId, reason } = body as { sessionId?: string; reason?: string };
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId" }));
      return;
    }

    if (!this.config.onAbort) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Abort not supported" }));
      return;
    }

    try {
      await this.config.onAbort(sessionId, reason);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }));
    }
  }

  /**
   * Close endpoint
   */
  private async handleClose(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    // Forward as request message
    const requestId = `req-${Date.now().toString(36)}`;
    const requestMessage: RequestMessage = {
      type: "req",
      id: requestId,
      method: "close",
      params: body as Record<string, unknown>,
    };

    const client = this.getAuthenticatedClients()[0];
    if (client) {
      this.handlers.message?.(client.id, requestMessage);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  }

  /**
   * Channel endpoint
   */
  private async handleChannel(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

  private async handleToolResponse(req: IncomingMessage, res: ServerResponse): Promise<void> {
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

    const { sessionId, toolUseId, result } = body as {
      sessionId?: string;
      toolUseId?: string;
      result?: ToolConfirmationResponse;
    };

    if (!sessionId || !toolUseId || !result) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId, toolUseId, or result" }));
      return;
    }

    if (!this.config.onToolResponse) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Tool response not supported" }));
      return;
    }

    try {
      await this.config.onToolResponse(sessionId, toolUseId, result);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : "Unknown error" }));
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WebSocket Handling (upgrades on the HTTP server)
  // ══════════════════════════════════════════════════════════════════════════

  private handleWSConnection(socket: WebSocket, _request: IncomingMessage): void {
    const clientId = this.generateClientId();
    const client = new WSClientInHTTP(clientId, socket);
    this.clients.set(clientId, client);

    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString()) as ClientMessage;
        this.handleWSMessage(client, message);
      } catch {
        client.send({
          type: "error",
          code: "INVALID_MESSAGE",
          message: "Failed to parse message",
        });
      }
    });

    socket.on("close", () => {
      this.clients.delete(client.id);
      this.handlers.disconnect?.(client.id);
    });

    socket.on("error", (error) => {
      this.handlers.error?.(error);
    });

    // Notify handler of new connection (before auth)
    this.handlers.connection?.(client);
  }

  private async handleWSMessage(client: WSClientInHTTP, message: ClientMessage): Promise<void> {
    if (message.type === "connect") {
      await this.handleWSConnect(client, message);
      return;
    }

    if (message.type === "ping") {
      client.send({ type: "pong", timestamp: message.timestamp });
      return;
    }

    if (!client.state.authenticated) {
      client.send({
        type: "error",
        code: "UNAUTHORIZED",
        message: "Authentication required. Send connect message first.",
      });
      return;
    }

    this.handlers.message?.(client.id, message);
  }

  private async handleWSConnect(client: WSClientInHTTP, message: ConnectMessage): Promise<void> {
    const authResult = await this.validateAuth(message.token);

    if (!authResult.valid) {
      client.send({
        type: "error",
        code: "AUTH_FAILED",
        message: "Authentication failed",
      });
      client.close(4001, "Authentication failed");
      return;
    }

    client.state.authenticated = true;
    client.state.user = authResult.user;
    client.state.metadata = {
      ...client.state.metadata,
      ...authResult.metadata,
      ...message.metadata,
    };

    if (message.clientId) {
      this.clients.delete(client.id);
      client._setId(message.clientId);
      this.clients.set(message.clientId, client);
    }

    // Gateway sends ConnectedMessage via this callback
    this.config.onAuthenticated?.(client);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Express Integration
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Handle a request from Express middleware.
   * This allows the gateway to be mounted in an existing Express app.
   */
  handleExpressRequest(
    req: IncomingMessage & { path?: string },
    res: ServerResponse & { status?: (code: number) => any; json?: (body: unknown) => void },
    next: (err?: unknown) => void,
  ): void {
    this.handleRequest(req, res).catch((error) => {
      console.error("Request error:", error);
      if (!res.headersSent) {
        if (res.status && res.json) {
          res.status(500).json({ error: "Internal server error" });
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      }
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Utilities
  // ══════════════════════════════════════════════════════════════════════════

  private parseBody(
    req: IncomingMessage & { body?: unknown },
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
}

// ============================================================================
// Factory Function
// ============================================================================

export function createHTTPTransport(config: HTTPTransportConfig): HTTPTransport {
  return new HTTPTransport(config);
}
