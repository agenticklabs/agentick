/**
 * TentickleController - Default NestJS controller for Tentickle endpoints.
 *
 * This controller uses TentickleService internally. Users who want custom
 * routes should inject TentickleService into their own controllers and
 * set `registerController: false` in the module options.
 *
 * @module @tentickle/nestjs/controller
 */

import {
  Controller,
  Post,
  Get,
  Param,
  Body,
  Res,
  Query,
  HttpException,
  HttpStatus,
  UseFilters,
} from "@nestjs/common";
import type { Response } from "express";
import { TentickleService } from "./tentickle.service.js";
import { TentickleExceptionFilter } from "./tentickle.filter.js";

// ============================================================================
// DTOs
// ============================================================================

/**
 * Input for creating a session.
 */
interface CreateSessionDto {
  sessionId?: string;
  props?: Record<string, unknown>;
}

/**
 * Input for sending a message.
 */
interface SendMessageDto {
  content: string;
  role?: "user" | "assistant";
}

/**
 * Input for triggering a tick.
 */
interface TickDto {
  props?: Record<string, unknown>;
}

/**
 * Input for aborting execution.
 */
interface AbortDto {
  reason?: string;
}

/**
 * Input for publishing an event.
 */
interface PublishEventDto {
  connectionId: string;
  channel: string;
  type: string;
  payload: unknown;
  id?: string;
}

// ============================================================================
// Controller
// ============================================================================

/**
 * Default controller for Tentickle endpoints.
 *
 * Provides REST endpoints for session management and SSE for events.
 * Uses TentickleExceptionFilter to convert SessionNotFoundError to 404.
 *
 * @example Using the default controller
 * ```typescript
 * @Module({
 *   imports: [TentickleModule.forRoot({ sessionHandler: { app } })],
 * })
 * export class AppModule {}
 * // Endpoints available at /sessions, /events, etc.
 * ```
 *
 * @example Custom controller with TentickleService
 * ```typescript
 * @Module({
 *   imports: [TentickleModule.forRoot({
 *     sessionHandler: { app },
 *     registerController: false,
 *   })],
 *   controllers: [MyCustomController],
 * })
 * export class AppModule {}
 *
 * @Controller('chat')
 * export class MyCustomController {
 *   constructor(private tentickle: TentickleService) {}
 *
 *   @Post('start')
 *   async start() {
 *     return this.tentickle.createSession();
 *   }
 * }
 * ```
 */
@Controller()
@UseFilters(TentickleExceptionFilter)
export class TentickleController {
  constructor(private readonly tentickle: TentickleService) {}

  // ══════════════════════════════════════════════════════════════════════════
  // Session Endpoints
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Create a new session.
   *
   * POST /sessions
   */
  @Post("sessions")
  async createSession(@Body() body: CreateSessionDto) {
    return this.tentickle.createSession(body);
  }

  /**
   * Get session state.
   *
   * GET /sessions/:id
   */
  @Get("sessions/:id")
  async getSession(@Param("id") id: string) {
    return this.tentickle.getSession(id);
  }

  /**
   * Send message to session.
   *
   * POST /sessions/:id/messages
   */
  @Post("sessions/:id/messages")
  async sendMessage(@Param("id") id: string, @Body() body: SendMessageDto) {
    return this.tentickle.sendMessage(id, body.content, body.role);
  }

  /**
   * Trigger tick.
   *
   * POST /sessions/:id/tick
   */
  @Post("sessions/:id/tick")
  async tick(@Param("id") id: string, @Body() body: TickDto) {
    return this.tentickle.tick(id, body.props);
  }

  /**
   * Abort execution.
   *
   * POST /sessions/:id/abort
   */
  @Post("sessions/:id/abort")
  async abort(@Param("id") id: string, @Body() body: AbortDto) {
    this.tentickle.abort(id, body.reason);
    return { success: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Event Endpoints
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * SSE endpoint for events.
   *
   * GET /events?sessionId=xxx&userId=xxx
   */
  @Get("events")
  async events(
    @Query("sessionId") sessionId: string,
    @Query("userId") userId: string | undefined,
    @Res() res: Response,
  ) {
    if (!sessionId) {
      throw new HttpException("sessionId is required", HttpStatus.BAD_REQUEST);
    }

    // createConnection handles the SSE setup and connection registration
    this.tentickle.createConnection(sessionId, res, userId);
  }

  /**
   * Post event to session.
   *
   * POST /events
   */
  @Post("events")
  async postEvent(@Body() body: PublishEventDto) {
    if (!body.connectionId) {
      throw new HttpException("connectionId is required", HttpStatus.BAD_REQUEST);
    }
    if (!body.channel) {
      throw new HttpException("channel is required", HttpStatus.BAD_REQUEST);
    }
    if (!body.type) {
      throw new HttpException("type is required", HttpStatus.BAD_REQUEST);
    }

    await this.tentickle.publishEvent(body.connectionId, {
      channel: body.channel,
      type: body.type,
      payload: body.payload,
      id: body.id,
    });

    return { success: true };
  }
}
