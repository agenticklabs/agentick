/**
 * @agentick/nestjs - NestJS adapter for Agentick Gateway
 *
 * Provides NestJS integration that delegates to Gateway.
 * This is a thin adapter - all business logic lives in @agentick/gateway.
 *
 * @example Default controller
 * ```typescript
 * import { Module } from '@nestjs/common';
 * import { AgentickModule } from '@agentick/nestjs';
 * import { createApp } from '@agentick/core';
 *
 * @Module({
 *   imports: [
 *     AgentickModule.forRoot({
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
 * import { AgentickModule, method } from '@agentick/nestjs';
 * import { z } from "zod";
 *
 * @Module({
 *   imports: [
 *     AgentickModule.forRoot({
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
 * @module @agentick/nestjs
 */

// Module, Service, Controller
export {
  AgentickModule,
  AgentickService,
  AgentickController,
  TENTICKLE_GATEWAY,
  type AgentickModuleOptions,
} from "./agentick.module";

// Re-export gateway types for convenience
export {
  method,
  type GatewayConfig,
  type MethodDefinition,
  type AuthConfig,
} from "@agentick/gateway";
