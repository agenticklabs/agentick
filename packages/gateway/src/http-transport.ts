/**
 * HTTP/SSE Transport
 *
 * Implements the Transport interface using HTTP requests and Server-Sent Events.
 * This enables web browser clients to connect to the gateway without WebSocket support.
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "http";
import { extractToken, validateAuth, setSSEHeaders, type AuthResult } from "@agentick/server";
import { isGuardError } from "@agentick/shared";
import type { GatewayMessage, RequestMessage } from "./transport-protocol.js";
import type { ClientState } from "./types.js";
import { BaseTransport, type TransportClient, type TransportConfig } from "./transport.js";

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
}

// ============================================================================
// HTTP/SSE Transport
// ============================================================================

export interface HTTPTransportConfig extends TransportConfig {
  /** CORS origin (default: "*") */
  corsOrigin?: string;

  /** Path prefix for all endpoints (default: "") */
  pathPrefix?: string;
}

export class HTTPTransport extends BaseTransport {
  readonly type = "http" as const;
  private server: Server | null = null;
  private httpConfig: HTTPTransportConfig;

  constructor(config: HTTPTransportConfig) {
    super(config);
    this.httpConfig = config;
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

      // Close all client connections
      for (const client of this.clients.values()) {
        client.close(1001, "Server shutting down");
      }
      this.clients.clear();

      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Set CORS headers
    const origin = this.httpConfig.corsOrigin ?? "*";
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

    const prefix = this.httpConfig.pathPrefix ?? "";
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const path = url.pathname.replace(prefix, "");

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
    const rawMessage = (body as any).message;

    // Validate and sanitize the message to ensure it's a proper Message object
    // This prevents any unexpected properties from being passed through
    if (
      !rawMessage ||
      typeof rawMessage !== "object" ||
      !rawMessage.role ||
      !Array.isArray(rawMessage.content)
    ) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Invalid message format. Expected { role, content: ContentBlock[] }",
        }),
      );
      return;
    }

    // Create a clean Message object with only expected properties
    const message = {
      role: rawMessage.role as "user" | "assistant" | "system" | "tool" | "event",
      content: rawMessage.content,
      ...(rawMessage.id && { id: rawMessage.id }),
      ...(rawMessage.metadata && { metadata: rawMessage.metadata }),
    };

    // Check if we have a direct send handler
    if (!this.config.onDirectSend) {
      res.writeHead(501, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Send not supported without onDirectSend handler" }));
      return;
    }

    // Setup streaming response
    setSSEHeaders(res);

    try {
      // Use the direct send handler to stream events
      const events = this.config.onDirectSend(sessionId, message);

      for await (const event of events) {
        const sseData = {
          type: event.type,
          sessionId,
          ...(event.data && typeof event.data === "object" ? event.data : {}),
        };
        res.write(`data: ${JSON.stringify(sseData)}\n\n`);
      }

      // Send execution_end
      res.write(`data: ${JSON.stringify({ type: "execution_end", sessionId })}\n\n`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      res.write(`data: ${JSON.stringify({ type: "error", error: errorMessage, sessionId })}\n\n`);
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

    // Update subscriptions
    if (add) {
      for (const sessionId of add) {
        client.state.subscriptions.add(sessionId);
      }
    }
    if (remove) {
      for (const sessionId of remove) {
        client.state.subscriptions.delete(sessionId);
      }
    }

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

    // Forward as request message
    const requestId = `req-${Date.now().toString(36)}`;
    const requestMessage: RequestMessage = {
      type: "req",
      id: requestId,
      method: "abort",
      params: body as Record<string, unknown>,
    };

    // Find any authenticated client to use
    const client = this.getAuthenticatedClients()[0];
    if (client) {
      this.handlers.message?.(client.id, requestMessage);
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
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
