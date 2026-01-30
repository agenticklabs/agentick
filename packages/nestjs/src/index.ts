/**
 * @tentickle/nestjs - NestJS module for Tentickle
 *
 * Provides NestJS integration with multiplexed SSE sessions.
 *
 * @example Default controller
 * ```typescript
 * import { Module } from '@nestjs/common';
 * import { TentickleModule } from '@tentickle/nestjs';
 * import { createApp } from '@tentickle/core';
 *
 * @Module({
 *   imports: [
 *     TentickleModule.forRoot({
 *       app: createApp(<MyAgent />),
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * // Endpoints: GET /events, POST /send, POST /subscribe, etc.
 * ```
 *
 * @example Custom controller
 * ```typescript
 * @Controller('chat')
 * export class ChatController {
 *   constructor(private tentickle: TentickleService) {}
 *
 *   @Post('send')
 *   async send(@Body() body: SendDto, @Res() res: Response) {
 *     await this.tentickle.sendAndStream(body.sessionId, body, res);
 *   }
 * }
 *
 * @Module({
 *   imports: [
 *     TentickleModule.forRoot({
 *       app,
 *       registerController: false,
 *     }),
 *   ],
 *   controllers: [ChatController],
 * })
 * export class AppModule {}
 * ```
 *
 * ## Default Endpoints
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | GET | `/events` | SSE stream |
 * | POST | `/send` | Send and stream |
 * | POST | `/subscribe` | Subscribe to sessions |
 * | POST | `/abort` | Abort execution |
 * | POST | `/close` | Close session |
 * | POST | `/tool-response` | Submit tool confirmation |
 * | POST | `/channel` | Publish to channel |
 *
 * @module @tentickle/nestjs
 */

// Module
export { TentickleModule } from "./tentickle.module";

// Service
export { TentickleService } from "./tentickle.service";

// Controller
export { TentickleController } from "./tentickle.controller";

// Types and tokens
export {
  TENTICKLE_OPTIONS,
  TENTICKLE_APP,
  type TentickleModuleOptions,
  type TentickleModuleAsyncOptions,
  type TentickleModuleOptionsFactory,
  type SendInput,
} from "./types";
