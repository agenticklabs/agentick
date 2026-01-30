/**
 * TentickleService - High-level service for Tentickle operations.
 *
 * Wraps App with NestJS-friendly patterns for multiplexed SSE sessions.
 *
 * @module @tentickle/nestjs/service
 */

import { Injectable, Inject } from "@nestjs/common";
import type { Response } from "express";
import type { App } from "@tentickle/core";
import type { StreamEvent, SendInput, ChannelEvent } from "@tentickle/shared";
import { createSSEWriter, setSSEHeaders } from "@tentickle/server";
import { TENTICKLE_APP, TENTICKLE_OPTIONS, type TentickleModuleOptions } from "./types";

type Connection = {
  id: string;
  writer: ReturnType<typeof createSSEWriter>;
  subscriptions: Set<string>;
  closed: boolean;
};

/**
 * High-level service for Tentickle operations.
 *
 * @example Injecting into your controller
 * ```typescript
 * @Controller('chat')
 * export class ChatController {
 *   constructor(private readonly tentickle: TentickleService) {}
 *
 *   @Post('send')
 *   async send(@Body() body: { message: string }, @Res() res: Response) {
 *     const { sessionId } = body;
 *     return this.tentickle.sendAndStream(sessionId, { message: body.message }, res);
 *   }
 * }
 * ```
 */
@Injectable()
export class TentickleService {
  private readonly connections = new Map<string, Connection>();
  private readonly sessionSubscribers = new Map<string, Set<string>>();
  private readonly sessionListeners = new Map<string, (event: StreamEvent) => void>();
  private readonly sessionChannelListeners = new Map<string, Map<string, () => void>>();

  constructor(
    @Inject(TENTICKLE_APP) private readonly app: App,
    @Inject(TENTICKLE_OPTIONS) private readonly options: TentickleModuleOptions,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // SSE Connection Management
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create an SSE connection.
   * Returns a connection ID that the client will use for subscriptions.
   */
  createConnection(res: Response): string {
    setSSEHeaders(res);
    const writer = createSSEWriter(res, {
      keepaliveInterval: this.options.sseKeepaliveInterval ?? 15000,
    });

    const connectionId = `conn-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const connection: Connection = {
      id: connectionId,
      writer,
      subscriptions: new Set<string>(),
      closed: false,
    };

    this.connections.set(connectionId, connection);

    writer.writeEvent({
      type: "connection",
      connectionId,
      subscriptions: [],
    });

    res.on("close", () => {
      connection.closed = true;
      for (const sessionId of connection.subscriptions) {
        this.unsubscribeConnection(connectionId, sessionId);
      }
      this.connections.delete(connectionId);
    });

    return connectionId;
  }

  /**
   * Subscribe a connection to one or more sessions.
   */
  async subscribe(connectionId: string, sessionIds: string[]): Promise<void> {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.closed) {
      throw new Error("Connection not found or closed");
    }

    for (const sessionId of sessionIds) {
      this.ensureSessionListener(sessionId);
      connection.subscriptions.add(sessionId);

      const subscribers = this.sessionSubscribers.get(sessionId) ?? new Set<string>();
      subscribers.add(connectionId);
      this.sessionSubscribers.set(sessionId, subscribers);
    }
  }

  /**
   * Unsubscribe a connection from one or more sessions.
   */
  async unsubscribe(connectionId: string, sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      this.unsubscribeConnection(connectionId, sessionId);
    }
  }

  private ensureSessionListener(sessionId: string): void {
    if (this.sessionListeners.has(sessionId)) return;

    const session = this.app.session(sessionId);
    const listener = (event: StreamEvent) => {
      const subscribers = this.sessionSubscribers.get(sessionId);
      if (!subscribers) return;

      for (const connectionId of subscribers) {
        const connection = this.connections.get(connectionId);
        if (!connection || connection.closed) continue;
        connection.writer.writeEvent({ ...event, sessionId });
      }
    };

    session.on("event", listener);
    session.once("close", () => {
      this.sessionListeners.delete(sessionId);
      this.sessionSubscribers.delete(sessionId);

      const channelListeners = this.sessionChannelListeners.get(sessionId);
      if (channelListeners) {
        for (const unsubscribe of channelListeners.values()) {
          unsubscribe();
        }
        this.sessionChannelListeners.delete(sessionId);
      }
    });

    this.sessionListeners.set(sessionId, listener);
  }

  private unsubscribeConnection(connectionId: string, sessionId: string): void {
    const connection = this.connections.get(connectionId);
    if (connection) {
      connection.subscriptions.delete(sessionId);
    }

    const subscribers = this.sessionSubscribers.get(sessionId);
    if (!subscribers) return;

    subscribers.delete(connectionId);
    if (subscribers.size === 0) {
      this.sessionSubscribers.delete(sessionId);
      const listener = this.sessionListeners.get(sessionId);
      if (listener && this.app.has(sessionId)) {
        const session = this.app.session(sessionId);
        session.off("event", listener);
      }
      this.sessionListeners.delete(sessionId);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Session Operations
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send a message and stream events via SSE.
   * Mirrors Express POST /send endpoint.
   */
  async sendAndStream(
    sessionId: string | undefined,
    input: SendInput,
    res: Response,
  ): Promise<void> {
    setSSEHeaders(res);
    const writer = createSSEWriter(res);

    try {
      const handle = await this.app.send(input, { sessionId });

      for await (const event of handle) {
        writer.writeEvent({ ...event, sessionId: handle.sessionId });
      }

      const result = await handle.result;
      writer.writeEvent({ type: "result", sessionId: handle.sessionId, result });
    } catch (error) {
      writer.writeEvent({
        type: "error",
        sessionId: sessionId ?? "unknown",
        error: { message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      writer.close();
    }
  }

  /**
   * Abort a session's current execution.
   */
  async abort(sessionId: string, reason?: string): Promise<void> {
    if (!this.app.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const session = this.app.session(sessionId);
    session.interrupt(undefined, reason);
  }

  /**
   * Close a session server-side.
   */
  async close(sessionId: string): Promise<void> {
    if (!this.app.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found`);
    }
    await this.app.close(sessionId);
  }

  /**
   * Submit tool confirmation result.
   */
  async submitToolResult(
    sessionId: string,
    toolUseId: string,
    result: { approved: boolean; reason?: string; modifiedArguments?: Record<string, unknown> },
  ): Promise<void> {
    if (!this.app.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const session = this.app.session(sessionId);
    session.submitToolResult(toolUseId, result);
  }

  /**
   * Publish to a session-scoped channel.
   */
  async publishToChannel(
    sessionId: string,
    channelName: string,
    eventType: string,
    payload: unknown,
  ): Promise<void> {
    if (!this.app.has(sessionId)) {
      throw new Error(`Session ${sessionId} not found`);
    }

    this.ensureChannelListener(sessionId, channelName);

    const session = this.app.session(sessionId);
    const channel = session.channel(channelName);
    channel.publish({ type: eventType, channel: channelName, payload });
  }

  private ensureChannelListener(sessionId: string, channelName: string): void {
    let channelListeners = this.sessionChannelListeners.get(sessionId);
    if (!channelListeners) {
      channelListeners = new Map();
      this.sessionChannelListeners.set(sessionId, channelListeners);
    }
    if (channelListeners.has(channelName)) return;

    const session = this.app.session(sessionId);
    const channel = session.channel(channelName);
    const unsubscribe = channel.subscribe((event: ChannelEvent) => {
      const subscribers = this.sessionSubscribers.get(sessionId);
      if (!subscribers) return;

      const sseEvent = {
        type: "channel" as const,
        sessionId,
        channel: channelName,
        event,
      };

      for (const connectionId of subscribers) {
        const connection = this.connections.get(connectionId);
        if (!connection || connection.closed) continue;
        connection.writer.writeEvent(sseEvent);
      }
    });

    channelListeners.set(channelName, unsubscribe);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Low-level Access
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get the underlying App for direct access.
   */
  getApp(): App {
    return this.app;
  }
}
