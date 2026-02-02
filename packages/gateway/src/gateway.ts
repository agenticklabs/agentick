/**
 * Gateway
 *
 * Standalone daemon for multi-client, multi-agent access.
 * Transport-agnostic: supports both WebSocket and HTTP/SSE.
 */

import { EventEmitter } from "events";
import type { Message } from "@tentickle/shared";
import { AgentRegistry } from "./agent-registry.js";
import { SessionManager } from "./session-manager.js";
import { WSTransport } from "./ws-transport.js";
import { HTTPTransport } from "./http-transport.js";
import type { Transport, TransportClient } from "./transport.js";
import type { GatewayConfig, GatewayEvents, GatewayContext, SessionEvent } from "./types.js";
import type {
  RequestMessage,
  GatewayMethod,
  GatewayEventType,
  SendParams,
  StatusParams,
  HistoryParams,
  SubscribeParams,
  StatusPayload,
  AgentsPayload,
  SessionsPayload,
} from "./protocol.js";

const DEFAULT_PORT = 18789;
const DEFAULT_HOST = "127.0.0.1";

// ============================================================================
// Gateway Class
// ============================================================================

export class Gateway extends EventEmitter {
  private config: Required<
    Pick<GatewayConfig, "port" | "host" | "id" | "defaultAgent" | "transport">
  > &
    GatewayConfig;
  private registry: AgentRegistry;
  private sessions: SessionManager;
  private transports: Transport[] = [];
  private startTime: Date | null = null;
  private isRunning = false;

  constructor(config: GatewayConfig) {
    super();

    // Validate config
    if (!config.agents || Object.keys(config.agents).length === 0) {
      throw new Error("At least one agent is required");
    }
    if (!config.defaultAgent) {
      throw new Error("defaultAgent is required");
    }

    // Set defaults
    this.config = {
      ...config,
      port: config.port ?? DEFAULT_PORT,
      host: config.host ?? DEFAULT_HOST,
      id: config.id ?? `gw-${Date.now().toString(36)}`,
      transport: config.transport ?? "websocket",
    };

    // Initialize components
    this.registry = new AgentRegistry(config.agents, config.defaultAgent);
    this.sessions = new SessionManager(this.registry);

    // Create transports based on mode
    this.initializeTransports();
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
      });
      this.setupTransportHandlers(httpTransportInstance);
      this.transports.push(httpTransportInstance);
    }
  }

  private setupTransportHandlers(transport: Transport): void {
    transport.on("connection", (client) => {
      this.emit("client:connected", {
        clientId: client.id,
      });
    });

    transport.on("disconnect", (clientId, reason) => {
      // Clean up subscriptions
      this.sessions.unsubscribeAll(clientId);

      this.emit("client:disconnected", {
        clientId,
        reason,
      });
    });

    transport.on("message", async (clientId, message) => {
      if (message.type === "req") {
        await this.handleRequest(transport, clientId, message);
      }
    });

    transport.on("error", (error) => {
      this.emit("error", error);
    });
  }

  /**
   * Start the gateway
   */
  async start(): Promise<void> {
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
    if (!this.isRunning) return;

    // Destroy channel adapters
    if (this.config.channels) {
      for (const channel of this.config.channels) {
        await channel.destroy();
      }
    }

    // Stop all transports
    await Promise.all(this.transports.map((t) => t.stop()));

    this.isRunning = false;
    this.startTime = null;

    this.emit("stopped", {});
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
      agents: this.registry.ids(),
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

  private async handleRequest(
    transport: Transport,
    clientId: string,
    request: RequestMessage,
  ): Promise<void> {
    const client = transport.getClient(clientId);
    if (!client) return;

    try {
      const result = await this.executeMethod(transport, clientId, request.method, request.params);

      client.send({
        type: "res",
        id: request.id,
        ok: true,
        payload: result,
      });
    } catch (error) {
      client.send({
        type: "res",
        id: request.id,
        ok: false,
        error: {
          code: "METHOD_ERROR",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async executeMethod(
    transport: Transport,
    clientId: string,
    method: GatewayMethod,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    switch (method) {
      case "send":
        return this.handleSend(transport, clientId, params as unknown as SendParams);

      case "abort":
        return this.handleAbort(params as unknown as { sessionId: string });

      case "status":
        return this.handleStatus(params as unknown as StatusParams);

      case "history":
        return this.handleHistory(params as unknown as HistoryParams);

      case "reset":
        return this.handleReset(params as unknown as { sessionId: string });

      case "close":
        return this.handleClose(params as unknown as { sessionId: string });

      case "agents":
        return this.handleAgents();

      case "sessions":
        return this.handleSessions();

      case "subscribe":
        return this.handleSubscribe(transport, clientId, params as unknown as SubscribeParams);

      case "unsubscribe":
        return this.handleUnsubscribe(transport, clientId, params as unknown as SubscribeParams);

      default:
        throw new Error(`Unknown method: ${method}`);
    }
  }

  private async handleSend(
    transport: Transport,
    clientId: string,
    params: SendParams,
  ): Promise<{ messageId: string }> {
    const { sessionId, message } = params;

    // Get or create managed session
    const managedSession = await this.sessions.getOrCreate(sessionId);

    // Auto-subscribe sender to session events
    const client = transport.getClient(clientId);
    if (client) {
      client.state.subscriptions.add(managedSession.state.id);
      this.sessions.subscribe(managedSession.state.id, clientId);
    }

    // Mark session as active
    this.sessions.setActive(managedSession.state.id, true);

    // Get or create core session from agent app
    if (!managedSession.coreSession) {
      managedSession.coreSession = managedSession.agent.app.session({
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

    // Increment message count
    this.sessions.incrementMessageCount(managedSession.state.id);

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

    // Get or create core session from agent app
    if (!managedSession.coreSession) {
      managedSession.coreSession = managedSession.agent.app.session({
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

  private async handleAbort(params: { sessionId: string }): Promise<void> {
    const session = this.sessions.get(params.sessionId);
    if (!session) {
      throw new Error(`Session not found: ${params.sessionId}`);
    }

    // TODO: Implement execution abortion
  }

  private handleStatus(params: StatusParams): StatusPayload {
    const result: StatusPayload = {
      gateway: this.status,
    };

    if (params.sessionId) {
      const session = this.sessions.get(params.sessionId);
      if (session) {
        result.session = {
          id: session.state.id,
          agentId: session.state.agentId,
          messageCount: session.state.messageCount,
          createdAt: session.state.createdAt.toISOString(),
          lastActivityAt: session.state.lastActivityAt.toISOString(),
          isActive: session.state.isActive,
        };
      }
    }

    return result;
  }

  private async handleHistory(
    params: HistoryParams,
  ): Promise<{ messages: unknown[]; hasMore: boolean }> {
    // TODO: Implement history retrieval from persistence
    return { messages: [], hasMore: false };
  }

  private async handleReset(params: { sessionId: string }): Promise<void> {
    await this.sessions.reset(params.sessionId);

    this.emit("session:closed", { sessionId: params.sessionId });
  }

  private async handleClose(params: { sessionId: string }): Promise<void> {
    await this.sessions.close(params.sessionId);

    this.emit("session:closed", { sessionId: params.sessionId });
  }

  private handleAgents(): AgentsPayload {
    return {
      agents: this.registry.all().map((agent) => ({
        id: agent.id,
        name: agent.name ?? agent.id,
        description: agent.description,
        isDefault: agent.isDefault,
      })),
    };
  }

  private handleSessions(): SessionsPayload {
    return {
      sessions: this.sessions.all().map((s) => ({
        id: s.state.id,
        agentId: s.state.agentId,
        createdAt: s.state.createdAt.toISOString(),
        lastActivityAt: s.state.lastActivityAt.toISOString(),
        messageCount: s.state.messageCount,
      })),
    };
  }

  private handleSubscribe(transport: Transport, clientId: string, params: SubscribeParams): void {
    const client = transport.getClient(clientId);
    if (client) {
      client.state.subscriptions.add(params.sessionId);
      this.sessions.subscribe(params.sessionId, clientId);
    }
  }

  private handleUnsubscribe(transport: Transport, clientId: string, params: SubscribeParams): void {
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
          managedSession.coreSession = managedSession.agent.app.session({
            sessionId: managedSession.state.id,
          });
        }

        await this.executeAndStream(managedSession.state.id, managedSession.coreSession, message);
      },

      getAgents: () => this.registry.ids(),

      getSession: (sessionId) => {
        const managedSession = this.sessions.get(sessionId);
        if (!managedSession) {
          throw new Error(`Session not found: ${sessionId}`);
        }

        return {
          id: managedSession.state.id,
          agentId: managedSession.state.agentId,
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
