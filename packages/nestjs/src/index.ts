/**
 * @tentickle/nestjs - NestJS module for Tentickle
 *
 * Provides NestJS integration for Tentickle servers with dependency injection
 * and configurable routing. The module offers three levels of progressive disclosure:
 *
 * 1. **Default controller** - Use `forRoot()` and get working endpoints immediately
 * 2. **TentickleService** - Inject the service into your own controllers
 * 3. **Raw handlers** - Inject SessionHandler/EventBridge directly for full control
 *
 * @example Level 1: Default controller (simplest)
 * ```typescript
 * import { Module } from '@nestjs/common';
 * import { TentickleModule } from '@tentickle/nestjs';
 * import { createApp } from '@tentickle/core';
 * import { MyAgent } from './my-agent';
 *
 * @Module({
 *   imports: [
 *     TentickleModule.forRoot({
 *       sessionHandler: { app: createApp(<MyAgent />) },
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * // Endpoints: POST /sessions, GET /sessions/:id, POST /sessions/:id/messages, etc.
 * ```
 *
 * @example Level 2: Custom controller with TentickleService
 * ```typescript
 * import { Module, Controller, Post, Body } from '@nestjs/common';
 * import { TentickleModule, TentickleService } from '@tentickle/nestjs';
 *
 * @Controller('chat')
 * export class ChatController {
 *   constructor(private tentickle: TentickleService) {}
 *
 *   @Post()
 *   async chat(@Body() body: { message: string }) {
 *     const { sessionId } = await this.tentickle.createSession();
 *     const result = await this.tentickle.sendMessage(sessionId, body.message);
 *     return result;
 *   }
 *
 *   @Get('stream/:sessionId')
 *   async stream(
 *     @Param('sessionId') sessionId: string,
 *     @Res() res: Response
 *   ) {
 *     // Creates SSE connection automatically
 *     this.tentickle.createConnection(sessionId, res);
 *   }
 * }
 *
 * @Module({
 *   imports: [
 *     TentickleModule.forRoot({
 *       sessionHandler: { app },
 *       registerController: false, // Disable default routes
 *     }),
 *   ],
 *   controllers: [ChatController],
 * })
 * export class AppModule {}
 * ```
 *
 * @example Level 3: Raw handlers for full control
 * ```typescript
 * import { Injectable, Inject } from '@nestjs/common';
 * import {
 *   TentickleModule,
 *   TENTICKLE_SESSION_HANDLER,
 *   TENTICKLE_EVENT_BRIDGE,
 *   SessionHandler,
 *   EventBridge,
 * } from '@tentickle/nestjs';
 *
 * @Injectable()
 * export class AdvancedService {
 *   constructor(
 *     @Inject(TENTICKLE_SESSION_HANDLER) private handler: SessionHandler,
 *     @Inject(TENTICKLE_EVENT_BRIDGE) private bridge: EventBridge,
 *   ) {}
 *
 *   async customOperation(sessionId: string) {
 *     const session = this.handler.getSession(sessionId);
 *     // Full access to session internals
 *   }
 * }
 * ```
 *
 * @example Async configuration with ConfigModule
 * ```typescript
 * import { Module } from '@nestjs/common';
 * import { ConfigModule, ConfigService } from '@nestjs/config';
 * import { TentickleModule } from '@tentickle/nestjs';
 *
 * @Module({
 *   imports: [
 *     ConfigModule.forRoot(),
 *     TentickleModule.forRootAsync({
 *       imports: [ConfigModule],
 *       useFactory: (config: ConfigService) => ({
 *         sessionHandler: { app: createApp(<MyAgent />) },
 *         path: config.get('TENTICKLE_PATH', 'tentickle'),
 *       }),
 *       inject: [ConfigService],
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * ```
 *
 * ## Default Endpoints
 *
 * When `registerController` is true (default):
 *
 * | Method | Path | Description |
 * |--------|------|-------------|
 * | POST | `/sessions` | Create session |
 * | GET | `/sessions/:id` | Get session state |
 * | POST | `/sessions/:id/messages` | Send message |
 * | POST | `/sessions/:id/tick` | Trigger tick |
 * | POST | `/sessions/:id/abort` | Abort execution |
 * | GET | `/events?sessionId=xxx` | SSE stream |
 * | POST | `/events` | Publish event |
 *
 * ## TentickleService Methods
 *
 * | Method | Description |
 * |--------|-------------|
 * | `createSession(options?)` | Create a new session |
 * | `getSession(id)` | Get session state |
 * | `hasSession(id)` | Check if session exists |
 * | `sendMessage(id, content, role?)` | Send message |
 * | `sendMessages(id, messages, props?)` | Send raw messages |
 * | `tick(id, props?)` | Trigger tick |
 * | `abort(id, reason?)` | Abort execution |
 * | `createConnection(id, res, userId?)` | Create SSE connection |
 * | `publishEvent(connId, event)` | Publish event |
 * | `handler` | Raw SessionHandler access |
 * | `bridge` | Raw EventBridge access |
 *
 * ## Injection Tokens
 *
 * | Token | Type | Description |
 * |-------|------|-------------|
 * | `TENTICKLE_SESSION_HANDLER` | `SessionHandler` | Session operations |
 * | `TENTICKLE_EVENT_BRIDGE` | `EventBridge` | Event routing |
 * | `TENTICKLE_OPTIONS` | `TentickleModuleOptions` | Module config |
 *
 * @module @tentickle/nestjs
 */

// Module
export { TentickleModule } from "./tentickle.module.js";

// Service
export {
  TentickleService,
  type CreateSessionResult,
  type SendResult,
  type SessionState,
  type ConnectionResult,
  type PublishEventInput,
} from "./tentickle.service.js";

// Controller and filter
export { TentickleController } from "./tentickle.controller.js";
export { TentickleExceptionFilter } from "./tentickle.filter.js";

// Types and tokens
export {
  TENTICKLE_OPTIONS,
  TENTICKLE_SESSION_HANDLER,
  TENTICKLE_EVENT_BRIDGE,
  type TentickleModuleOptions,
  type TentickleModuleAsyncOptions,
  type TentickleModuleOptionsFactory,
  type SessionHandler,
  type EventBridge,
  type SessionHandlerConfig,
  type EventBridgeConfig,
  type CreateSessionInput,
  type SendInput,
  type ServerConnection,
  type SessionStateInfo,
} from "./types.js";
