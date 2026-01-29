/**
 * TentickleService - High-level service for Tentickle operations.
 *
 * Provides a clean, NestJS-idiomatic API for session and event management.
 * Users can inject this service into their own controllers for custom routing.
 *
 * @module @tentickle/nestjs/service
 */

import { Injectable, Inject } from "@nestjs/common";
import type { Response } from "express";
import {
  setSSEHeaders,
  createSSEWriter,
  SessionNotFoundError,
  type SessionHandler,
  type EventBridge,
  type ServerConnection,
  type SSEWriter,
} from "@tentickle/server";
import type { TextBlock, Message } from "@tentickle/shared";
import {
  TENTICKLE_SESSION_HANDLER,
  TENTICKLE_EVENT_BRIDGE,
} from "./types.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Result of creating a session.
 */
export interface CreateSessionResult {
  sessionId: string;
  status: "created";
}

/**
 * Result of sending a message or triggering a tick.
 */
export interface SendResult {
  success: true;
  response: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  stopReason?: string;
}

/**
 * State information for a session.
 */
export interface SessionState {
  sessionId: string;
  status: string;
  tick: number;
  queuedMessages: number;
}

/**
 * Result of establishing an SSE connection.
 */
export interface ConnectionResult {
  connectionId: string;
  writer: SSEWriter;
  cleanup: () => void;
}

/**
 * Event to publish to a session.
 */
export interface PublishEventInput {
  channel: string;
  type: string;
  payload: unknown;
  id?: string;
}

// ============================================================================
// Service
// ============================================================================

/**
 * High-level service for Tentickle operations.
 *
 * @example Injecting into your own controller
 * ```typescript
 * import { Controller, Post, Body } from '@nestjs/common';
 * import { TentickleService } from '@tentickle/nestjs';
 *
 * @Controller('chat')
 * export class ChatController {
 *   constructor(private readonly tentickle: TentickleService) {}
 *
 *   @Post()
 *   async sendMessage(@Body() body: { message: string }) {
 *     const { sessionId } = await this.tentickle.createSession();
 *     const result = await this.tentickle.sendMessage(sessionId, body.message);
 *     return result;
 *   }
 * }
 * ```
 *
 * @example Custom SSE endpoint
 * ```typescript
 * @Get('stream/:sessionId')
 * async stream(
 *   @Param('sessionId') sessionId: string,
 *   @Res() res: Response
 * ) {
 *   const conn = await this.tentickle.createConnection(sessionId, res);
 *   // Connection is now established and streaming
 * }
 * ```
 */
@Injectable()
export class TentickleService {
  constructor(
    @Inject(TENTICKLE_SESSION_HANDLER)
    private readonly sessionHandler: SessionHandler,
    @Inject(TENTICKLE_EVENT_BRIDGE)
    private readonly eventBridge: EventBridge,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // Session Management
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new session.
   *
   * @param options.sessionId - Optional custom session ID
   * @param options.props - Session properties for the agent
   */
  async createSession(options?: {
    sessionId?: string;
    props?: Record<string, unknown>;
  }): Promise<CreateSessionResult> {
    const { sessionId } = await this.sessionHandler.create({
      sessionId: options?.sessionId,
      props: options?.props,
    });

    return { sessionId, status: "created" };
  }

  /**
   * Get session state.
   *
   * @throws SessionNotFoundError if session doesn't exist
   */
  getSession(sessionId: string): SessionState {
    const state = this.sessionHandler.getState(sessionId);

    if (!state) {
      throw new SessionNotFoundError(sessionId);
    }

    return state;
  }

  /**
   * Check if a session exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessionHandler.getState(sessionId) !== undefined;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Messaging
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Send a message to a session.
   *
   * @throws SessionNotFoundError if session doesn't exist
   */
  async sendMessage(
    sessionId: string,
    content: string,
    role: "user" | "assistant" = "user",
  ): Promise<SendResult> {
    const textBlock: TextBlock = { type: "text", text: content };
    const result = await this.sessionHandler.send(sessionId, {
      messages: [{ role, content: [textBlock] }],
    });

    return {
      success: true,
      response: result.response,
      usage: result.usage,
      stopReason: result.stopReason,
    };
  }

  /**
   * Send raw messages to a session.
   *
   * @throws SessionNotFoundError if session doesn't exist
   */
  async sendMessages(
    sessionId: string,
    messages: Message[],
    props?: Record<string, unknown>,
  ): Promise<SendResult> {
    const result = await this.sessionHandler.send(sessionId, {
      messages,
      props,
    });

    return {
      success: true,
      response: result.response,
      usage: result.usage,
      stopReason: result.stopReason,
    };
  }

  /**
   * Trigger a tick without sending a message.
   *
   * @throws SessionNotFoundError if session doesn't exist
   */
  async tick(
    sessionId: string,
    props?: Record<string, unknown>,
  ): Promise<SendResult> {
    const result = await this.sessionHandler.send(sessionId, { props });

    return {
      success: true,
      response: result.response,
      usage: result.usage,
      stopReason: result.stopReason,
    };
  }

  /**
   * Abort the current execution.
   *
   * @throws SessionNotFoundError if session doesn't exist
   */
  abort(sessionId: string, reason?: string): void {
    const session = this.sessionHandler.getSession(sessionId);

    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    session.interrupt(undefined, reason);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Event Streaming
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create an SSE connection for a session.
   *
   * Sets up headers, registers the connection, and returns a writer
   * for sending events. The connection is automatically cleaned up
   * when the client disconnects.
   *
   * @param sessionId - Session to connect to
   * @param res - Express response object
   * @param userId - Optional user ID for the connection
   * @returns Connection info with writer and cleanup function
   * @throws SessionNotFoundError if session doesn't exist
   */
  createConnection(
    sessionId: string,
    res: Response,
    userId?: string,
  ): ConnectionResult {
    // Verify session exists
    const session = this.sessionHandler.getSession(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }

    // Set up SSE
    setSSEHeaders(res);
    const writer = createSSEWriter(res);

    // Generate connection ID
    const connectionId = `conn-${Date.now()}${Math.random().toString(36).slice(2, 8)}`;

    // Register connection
    const connection: ServerConnection = {
      id: connectionId,
      sessionId,
      userId,
      metadata: {},
      send: async (event) => writer.writeEvent(event),
      close: () => writer.close(),
    };

    this.eventBridge.registerConnection(connection);

    // Send initial connection event
    writer.writeEvent({
      channel: "system",
      type: "connected",
      payload: { connectionId, sessionId },
    });

    // Set up cleanup
    const cleanup = () => {
      this.eventBridge.unregisterConnection(connectionId);
    };

    res.on("close", cleanup);

    return { connectionId, writer, cleanup };
  }

  /**
   * Publish an event to a connection.
   */
  async publishEvent(
    connectionId: string,
    event: PublishEventInput,
  ): Promise<void> {
    await this.eventBridge.handleEvent(connectionId, {
      channel: event.channel,
      type: event.type,
      payload: event.payload,
      id: event.id,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Low-level Access
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Get the underlying session handler for advanced operations.
   */
  get handler(): SessionHandler {
    return this.sessionHandler;
  }

  /**
   * Get the underlying event bridge for advanced operations.
   */
  get bridge(): EventBridge {
    return this.eventBridge;
  }
}
