/**
 * Event Bridge - Routes events between transport and sessions.
 *
 * The bridge has two modes:
 * 1. With transport adapter (e.g., Socket.IO): Delegates connection management to the adapter
 * 2. Without transport adapter (HTTP/SSE): Manages connections internally
 *
 * @module @tentickle/server/event-bridge
 */

import type { Message, StreamEvent, ProtocolError, SessionMessagePayload } from "@tentickle/shared";
import { FrameworkChannels, ErrorCodes } from "@tentickle/shared";
import { Logger } from "@tentickle/core/core";
import type {
  EventBridge,
  EventBridgeConfig,
  SessionHandler,
  ServerConnection,
  ServerTransportAdapter,
  SessionResultPayload,
} from "./types.js";

/**
 * Event Bridge implementation.
 *
 * @example With HTTP/SSE (manages connections internally)
 * ```typescript
 * const bridge = createEventBridge({ sessionHandler });
 *
 * // Register connections from SSE endpoint
 * bridge.registerConnection(connection);
 *
 * // Handle events from POST endpoint
 * await bridge.handleEvent(connectionId, event);
 * ```
 *
 * @example With Socket.IO (delegates to adapter)
 * ```typescript
 * const adapter = createSocketIOAdapter({
 *   io,
 *   onEvent: (connection, event) => bridge.handleEvent(connection, event),
 * });
 *
 * const bridge = createEventBridge({
 *   sessionHandler,
 *   transport: adapter,
 * });
 * // No need to call registerConnection - adapter handles it
 * ```
 */
export class EventBridgeImpl implements EventBridge {
  private readonly logger = Logger.for("EventBridge");
  private readonly sessionHandler: SessionHandler;
  private readonly transport?: ServerTransportAdapter;
  private readonly validateEvent?: EventBridgeConfig["validateEvent"];

  // Internal connection tracking - only used when no transport adapter
  private readonly connections = new Map<string, ServerConnection>();
  private readonly sessionConnections = new Map<string, Set<string>>();

  // Active streams for abort handling
  private readonly activeStreams = new Map<string, () => void>();

  constructor(config: EventBridgeConfig) {
    this.sessionHandler = config.sessionHandler;
    this.transport = config.transport;
    this.validateEvent = config.validateEvent;
  }

  /**
   * Whether this bridge manages connections internally.
   * False when a transport adapter handles connection management.
   */
  private get managesConnections(): boolean {
    return !this.transport;
  }

  /**
   * Register a connection.
   * Only needed when NOT using a transport adapter.
   */
  registerConnection(connection: ServerConnection): void {
    if (!this.managesConnections) {
      // Transport adapter handles connection tracking
      return;
    }

    this.connections.set(connection.id, connection);

    let sessionConns = this.sessionConnections.get(connection.sessionId);
    if (!sessionConns) {
      sessionConns = new Set();
      this.sessionConnections.set(connection.sessionId, sessionConns);
    }
    sessionConns.add(connection.id);
  }

  /**
   * Unregister a connection.
   * Only needed when NOT using a transport adapter.
   */
  unregisterConnection(connectionId: string): void {
    if (!this.managesConnections) {
      return;
    }

    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const sessionConns = this.sessionConnections.get(connection.sessionId);
    if (sessionConns) {
      sessionConns.delete(connectionId);
      if (sessionConns.size === 0) {
        this.sessionConnections.delete(connection.sessionId);
      }
    }

    this.connections.delete(connectionId);
  }

  /**
   * Handle an incoming event.
   *
   * Accepts either:
   * - connectionId (string) - looks up connection internally (HTTP/SSE mode)
   * - connection (ServerConnection) - uses directly (transport adapter mode)
   */
  async handleEvent(
    connectionOrId: string | ServerConnection,
    event: { channel: string; type: string; payload: unknown; id?: string },
  ): Promise<void> {
    // Resolve connection
    const connection =
      typeof connectionOrId === "string"
        ? this.connections.get(connectionOrId)
        : connectionOrId;

    if (!connection) {
      this.logger.warn({ connectionOrId }, "Event from unknown connection");
      return;
    }

    if (this.validateEvent) {
      try {
        await this.validateEvent(connection, event);
      } catch (err) {
        this.logger.warn({ err, connectionId: connection.id, channel: event.channel, type: event.type }, "Event validation failed");
        return;
      }
    }

    // Route by channel
    switch (event.channel) {
      case FrameworkChannels.MESSAGES:
        await this.handleMessage(connection, event);
        break;

      case FrameworkChannels.CONTROL:
        await this.handleControl(connection, event);
        break;

      case FrameworkChannels.TOOL_CONFIRMATION:
        await this.handleToolConfirmation(connection, event);
        break;

      default:
        this.logger.warn({ channel: event.channel }, "Unknown channel");
    }
  }

  private async handleMessage(
    connection: ServerConnection,
    event: { type: string; payload: unknown },
  ): Promise<void> {
    if (event.type !== "message") return;

    this.logger.info({ event, sessionId: connection.sessionId }, "handleMessage");
    const payload = event.payload as SessionMessagePayload | Message | Message[];
    const session = this.sessionHandler.getSession(connection.sessionId);
    if (!session) {
      this.logger.warn({ sessionId: connection.sessionId }, "Session not found");
      return;
    }
    const sessionId = connection.sessionId;
    // Abort existing stream
    this.activeStreams.get(sessionId)?.();

    let aborted = false;
    this.activeStreams.set(sessionId, () => { aborted = true; });

    const sendInput = Array.isArray(payload)
      ? { messages: payload }
      : payload && typeof payload === "object" && "role" in payload && "content" in payload
        ? { message: payload as Message }
        : (payload as SessionMessagePayload);

    const handle = session.send(sendInput);
    await this.streamHandle(sessionId, handle, aborted);
  }

  private async handleControl(
    connection: ServerConnection,
    event: { type: string; payload: unknown },
  ): Promise<void> {
    const session = this.sessionHandler.getSession(connection.sessionId);
    if (!session) {
      this.logger.warn({ sessionId: connection.sessionId }, "Session not found");
      return;
    }

    if (event.type === "tick") {
      const props = (event.payload as { props?: Record<string, unknown> })?.props;
      const inspection = session.inspect();
      const hasQueuedMessages = inspection.queuedMessages.length > 0;
      const hasProps =
        props != null &&
        (typeof props !== "object" || Object.keys(props as Record<string, unknown>).length > 0);

      if (!hasQueuedMessages && !hasProps) {
        return;
      }
      await this.startStreaming(connection.sessionId, props);
    } else if (event.type === "abort") {
      this.activeStreams.get(connection.sessionId)?.();
      const reason = (event.payload as { reason?: string })?.reason;
      session.interrupt(undefined, reason);
    }
  }

  private async handleToolConfirmation(
    connection: ServerConnection,
    event: { type: string; payload: unknown; id?: string },
  ): Promise<void> {
    if (event.type !== "response") return;

    const session = this.sessionHandler.getSession(connection.sessionId);
    if (!session) return;

    session.channel("tool_confirmation").publish({
      type: "response",
      id: event.id,
      channel: "tool_confirmation",
      payload: event.payload,
    });
  }

  private async startStreaming(
    sessionId: string,
    props?: Record<string, unknown>,
  ): Promise<void> {
    // Abort existing stream
    this.activeStreams.get(sessionId)?.();

    let aborted = false;
    this.activeStreams.set(sessionId, () => { aborted = true; });

    const session = this.sessionHandler.getSession(sessionId);
    if (!session) {
      this.logger.warn({ sessionId }, "Session not found");
      return;
    }

    const handle = session.tick(props as Record<string, unknown>);
    await this.streamHandle(sessionId, handle, aborted);
  }

  private async streamHandle(
    sessionId: string,
    handle: AsyncIterable<StreamEvent>,
    aborted = false,
  ): Promise<void> {
    try {
      for await (const event of handle) {
        if (aborted) break;

        await this.sendToSession(sessionId, {
          channel: FrameworkChannels.EVENTS,
          type: event.type,
          payload: event,
        });

        if (event.type === "result") {
          await this.sendToSession(sessionId, {
            channel: FrameworkChannels.RESULT,
            type: "result",
            payload: event.result,
          });
        }
      }
    } catch (error) {
      if (!aborted) {
        const err = error as Error;
        const errorPayload: ProtocolError = {
          code: this.classifyError(err),
          message: err.message,
          details: err.cause ? { cause: String(err.cause) } : undefined,
        };
        await this.sendToSession(sessionId, {
          channel: FrameworkChannels.EVENTS,
          type: "error",
          payload: errorPayload,
        });
      }
    } finally {
      const handleWithResult = handle as { result?: Promise<unknown> };
      if (handleWithResult.result) {
        void handleWithResult.result.catch((err) => {
          this.logger.error({ err, sessionId }, "Session result failed");
        });
      }
      this.activeStreams.delete(sessionId);
    }
  }

  /**
   * Classify an error into a protocol error code.
   */
  private classifyError(error: Error): string {
    const message = error.message.toLowerCase();

    if (message.includes("session not found") || message.includes("sessionnotfound")) {
      return ErrorCodes.SESSION_NOT_FOUND;
    }
    if (message.includes("session closed") || message.includes("sessionclosed")) {
      return ErrorCodes.SESSION_CLOSED;
    }
    if (message.includes("timeout") || error.name === "TimeoutError") {
      return ErrorCodes.TIMEOUT;
    }
    if (message.includes("invalid") || message.includes("validation")) {
      return ErrorCodes.INVALID_MESSAGE;
    }

    // Default to a generic error - could add more codes as needed
    return "EXECUTION_ERROR";
  }

  private async sendToSession(
    sessionId: string,
    event: { channel: string; type: string; payload: unknown; id?: string },
  ): Promise<void> {
    // Delegate to transport adapter if available
    if (this.transport) {
      await this.transport.sendToSession(sessionId, event);
      return;
    }

    // Otherwise use internal tracking
    const connectionIds = this.sessionConnections.get(sessionId);
    if (!connectionIds) return;

    for (const id of connectionIds) {
      const conn = this.connections.get(id);
      if (!conn) continue;

      void conn.send(event).catch((err) => {
        this.logger.warn({ connectionId: id, err }, "Connection send failed");
        // Drop the connection; it can reconnect via a new SSE/WebSocket connection.
        conn.close();
        this.unregisterConnection(id);
      });
    }
  }

  destroy(): void {
    // Abort all streams
    for (const abort of this.activeStreams.values()) {
      abort();
    }
    this.activeStreams.clear();

    // Close internal connections
    for (const conn of this.connections.values()) {
      conn.close();
    }
    this.connections.clear();
    this.sessionConnections.clear();

    // Cleanup transport
    this.transport?.destroy();
  }
}

/**
 * Create an event bridge.
 */
export function createEventBridge(config: EventBridgeConfig): EventBridge {
  return new EventBridgeImpl(config);
}
