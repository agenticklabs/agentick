/**
 * TentickleController - Default NestJS controller for Tentickle endpoints.
 *
 * Provides multiplexed SSE endpoints matching Express adapter API.
 *
 * @module @tentickle/nestjs/controller
 */

import { Controller, Post, Get, Body, Res, HttpException, HttpStatus } from "@nestjs/common";
import type { Response } from "express";
import type { Message, ToolConfirmationResponse } from "@tentickle/shared";
import { TentickleService } from "./tentickle.service";

// ============================================================================
// DTOs
// ============================================================================

interface SubscribeDto {
  connectionId: string;
  add?: string[];
  remove?: string[];
}

interface SendDto {
  sessionId?: string;
  message?: Message;
  messages?: Message[];
  props?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

interface AbortDto {
  sessionId: string;
  reason?: string;
}

interface CloseDto {
  sessionId: string;
}

interface ToolResponseDto {
  sessionId: string;
  toolUseId: string;
  response: ToolConfirmationResponse;
}

interface ChannelPublishDto {
  sessionId: string;
  channel: string;
  type: string;
  payload: unknown;
}

// ============================================================================
// Controller
// ============================================================================

/**
 * Default controller for Tentickle endpoints.
 *
 * Provides multiplexed SSE with per-session subscriptions.
 *
 * @example Using the default controller
 * ```typescript
 * @Module({
 *   imports: [TentickleModule.forRoot({ app })],
 * })
 * export class AppModule {}
 * ```
 *
 * @example Custom controller
 * ```typescript
 * @Module({
 *   imports: [TentickleModule.forRoot({ app, registerController: false })],
 *   controllers: [MyController],
 * })
 * export class AppModule {}
 * ```
 */
@Controller()
export class TentickleController {
  constructor(private readonly tentickle: TentickleService) {}

  /**
   * SSE endpoint for multiplexed events.
   *
   * GET /events
   */
  @Get("events")
  events(@Res() res: Response) {
    this.tentickle.createConnection(res);
  }

  /**
   * Subscribe to sessions.
   *
   * POST /subscribe
   */
  @Post("subscribe")
  async subscribe(@Body() body: SubscribeDto) {
    if (!body.connectionId) {
      throw new HttpException("connectionId is required", HttpStatus.BAD_REQUEST);
    }

    const { connectionId, add = [], remove = [] } = body;

    if (add.length > 0) {
      await this.tentickle.subscribe(connectionId, add);
    }
    if (remove.length > 0) {
      await this.tentickle.unsubscribe(connectionId, remove);
    }

    return { success: true };
  }

  /**
   * Send message and stream events.
   *
   * POST /send
   */
  @Post("send")
  async send(@Body() body: SendDto, @Res() res: Response) {
    const { sessionId, message, messages, props, metadata } = body;

    // Build valid SendInput - must have message OR messages (not neither)
    let input: { message: Message } | { messages: Message[] };
    if (message) {
      input = { message };
    } else if (messages && messages.length > 0) {
      input = { messages };
    } else {
      throw new HttpException("Either message or messages is required", HttpStatus.BAD_REQUEST);
    }

    // Add optional fields
    const sendInput = {
      ...input,
      ...(props && { props }),
      ...(metadata && { metadata }),
    };

    await this.tentickle.sendAndStream(sessionId, sendInput, res);
  }

  /**
   * Abort execution.
   *
   * POST /abort
   */
  @Post("abort")
  async abort(@Body() body: AbortDto) {
    if (!body.sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }

    await this.tentickle.abort(body.sessionId, body.reason);
    return { success: true };
  }

  /**
   * Close session.
   *
   * POST /close
   */
  @Post("close")
  async close(@Body() body: CloseDto) {
    if (!body.sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }

    await this.tentickle.close(body.sessionId);
    return { success: true };
  }

  /**
   * Submit tool confirmation response.
   *
   * POST /tool-response
   */
  @Post("tool-response")
  async toolResponse(@Body() body: ToolResponseDto) {
    if (!body.sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }
    if (!body.toolUseId) {
      throw new HttpException("toolUseId is required", HttpStatus.BAD_REQUEST);
    }

    await this.tentickle.submitToolResult(body.sessionId, body.toolUseId, body.response);
    return { success: true };
  }

  /**
   * Publish to session channel.
   *
   * POST /channel
   */
  @Post("channel")
  async channel(@Body() body: ChannelPublishDto) {
    if (!body.sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }
    if (!body.channel) {
      throw new HttpException("channel is required", HttpStatus.BAD_REQUEST);
    }
    if (!body.type) {
      throw new HttpException("type is required", HttpStatus.BAD_REQUEST);
    }

    await this.tentickle.publishToChannel(body.sessionId, body.channel, body.type, body.payload);
    return { success: true };
  }
}
