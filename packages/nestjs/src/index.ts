/**
 * @tentickle/nestjs - NestJS adapter for Tentickle Gateway
 *
 * Provides NestJS integration that delegates to Gateway.
 * This is a thin adapter - all business logic lives in @tentickle/gateway.
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
 *       apps: { assistant: createApp(<MyAgent />) },
 *       defaultApp: "assistant",
 *     }),
 *   ],
 * })
 * export class AppModule {}
 * // Endpoints: GET /events, POST /send, POST /invoke, etc.
 * ```
 *
 * @example With custom methods
 * ```typescript
 * import { TentickleModule, method } from '@tentickle/nestjs';
 * import { z } from "zod";
 *
 * @Module({
 *   imports: [
 *     TentickleModule.forRoot({
 *       apps: { assistant: myApp },
 *       defaultApp: "assistant",
 *       methods: {
 *         tasks: {
 *           list: method({
 *             schema: z.object({ sessionId: z.string() }),
 *             handler: async (params) => todoService.list(params.sessionId),
 *           }),
 *         },
 *       },
 *     }),
 *   ],
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
 * | POST | `/invoke` | Invoke custom method |
 * | POST | `/subscribe` | Subscribe to sessions |
 * | POST | `/abort` | Abort execution |
 * | POST | `/close` | Close session |
 *
 * @module @tentickle/nestjs
 */

// Module, Service, Controller
export {
  TentickleModule,
  TentickleService,
  TentickleController,
  TENTICKLE_GATEWAY,
  type TentickleModuleOptions,
} from "./tentickle.module";

// Re-export gateway types for convenience
export {
  method,
  type GatewayConfig,
  type MethodDefinition,
  type AuthConfig,
} from "@tentickle/gateway";
