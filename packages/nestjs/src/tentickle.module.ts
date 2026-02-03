/**
 * TentickleModule - NestJS module for Tentickle Gateway.
 *
 * This is a thin adapter - all business logic lives in @tentickle/gateway.
 *
 * @module @tentickle/nestjs/module
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
import { Gateway, type GatewayConfig } from "@tentickle/gateway";

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
export type TentickleModuleOptions = Omit<
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
export class TentickleService {
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
export class TentickleController {
  constructor(private readonly tentickle: TentickleService) {}

  @All("*")
  async handleAll(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.tentickle.handleRequest(req, res);
  }
}

// ============================================================================
// Module
// ============================================================================

/**
 * NestJS module for Tentickle.
 *
 * @example Default controller (simplest)
 * ```typescript
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
 * @example Custom controller with TentickleService
 * ```typescript
 * @Module({
 *   imports: [
 *     TentickleModule.forRoot({
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
 *   constructor(private tentickle: TentickleService) {}
 *
 *   @All('*')
 *   async handleAll(@Req() req: Request, @Res() res: Response) {
 *     await this.tentickle.handleRequest(req, res);
 *   }
 * }
 * ```
 */
@Module({})
export class TentickleModule {
  /**
   * Register module with static configuration.
   */
  static forRoot(options: TentickleModuleOptions): DynamicModule {
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
      TentickleService,
    ];

    const controllers = options.registerController !== false ? [TentickleController] : [];

    return {
      module: TentickleModule,
      providers,
      controllers,
      exports: [TentickleService, TENTICKLE_GATEWAY],
    };
  }
}
