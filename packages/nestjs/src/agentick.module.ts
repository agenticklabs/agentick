/**
 * AgentickModule - NestJS module for Agentick Gateway.
 *
 * This is a thin adapter - all business logic lives in @agentick/gateway.
 *
 * @module @agentick/nestjs/module
 */

import {
  Module,
  type DynamicModule,
  type Provider,
  Inject,
  Injectable,
  Controller,
  All,
  Req,
  Res,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Gateway, type GatewayConfig } from "@agentick/gateway";

// ============================================================================
// Injection Tokens
// ============================================================================

export const TENTICKLE_GATEWAY = "TENTICKLE_GATEWAY";

// ============================================================================
// Types
// ============================================================================

/**
 * Gateway config type for NestJS module.
 * Excludes standalone-mode-only options.
 */
export type AgentickModuleOptions = Omit<
  GatewayConfig,
  "port" | "host" | "transport" | "httpPort"
> & {
  /**
   * Whether to register the default controller.
   * Set to false if you want to define your own routes.
   * @default true
   */
  registerController?: boolean;
};

// ============================================================================
// Service (thin wrapper around Gateway)
// ============================================================================

@Injectable()
export class AgentickService {
  constructor(@Inject(TENTICKLE_GATEWAY) public readonly gateway: Gateway) {}

  /**
   * Handle an HTTP request by delegating to Gateway.
   */
  async handleRequest(req: Request, res: Response): Promise<void> {
    return this.gateway.handleRequest(req, res);
  }
}

// ============================================================================
// Controller (delegates everything to Gateway)
// ============================================================================

@Controller()
export class AgentickController {
  constructor(private readonly agentick: AgentickService) {}

  @All("*")
  async handleAll(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.agentick.handleRequest(req, res);
  }
}

// ============================================================================
// Module
// ============================================================================

/**
 * NestJS module for Agentick.
 *
 * @example Default controller (simplest)
 * ```typescript
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
 * @example Custom controller with AgentickService
 * ```typescript
 * @Module({
 *   imports: [
 *     AgentickModule.forRoot({
 *       apps: { assistant: myApp },
 *       defaultApp: "assistant",
 *       registerController: false,
 *     }),
 *   ],
 *   controllers: [ChatController],
 * })
 * export class AppModule {}
 *
 * @Controller('chat')
 * export class ChatController {
 *   constructor(private agentick: AgentickService) {}
 *
 *   @All('*')
 *   async handleAll(@Req() req: Request, @Res() res: Response) {
 *     await this.agentick.handleRequest(req, res);
 *   }
 * }
 * ```
 */
@Module({})
export class AgentickModule {
  /**
   * Register module with static configuration.
   */
  static forRoot(options: AgentickModuleOptions): DynamicModule {
    // Create gateway in embedded mode
    const gateway = new Gateway({
      ...options,
      embedded: true,
    });

    const providers: Provider[] = [
      {
        provide: TENTICKLE_GATEWAY,
        useValue: gateway,
      },
      AgentickService,
    ];

    const controllers = options.registerController !== false ? [AgentickController] : [];

    return {
      module: AgentickModule,
      providers,
      controllers,
      exports: [AgentickService, TENTICKLE_GATEWAY],
    };
  }
}
