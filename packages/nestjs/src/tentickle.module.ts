/**
 * TentickleModule - NestJS module for Tentickle.
 *
 * @module @tentickle/nestjs/module
 */

import {
  Module,
  type DynamicModule,
  type Provider,
  type Type,
} from "@nestjs/common";
import { createSessionHandler, createEventBridge } from "@tentickle/server";
import { TentickleController } from "./tentickle.controller.js";
import { TentickleService } from "./tentickle.service.js";
import {
  TENTICKLE_OPTIONS,
  TENTICKLE_SESSION_HANDLER,
  TENTICKLE_EVENT_BRIDGE,
  type TentickleModuleOptions,
  type TentickleModuleAsyncOptions,
  type TentickleModuleOptionsFactory,
} from "./types.js";

/**
 * NestJS module for Tentickle.
 *
 * Provides session handling and event routing for Tentickle applications.
 * The module offers three levels of progressive disclosure:
 *
 * 1. **Default controller** - Use `forRoot()` and get working endpoints immediately
 * 2. **TentickleService** - Inject the service into your own controllers
 * 3. **Raw handlers** - Inject SessionHandler/EventBridge directly for full control
 *
 * @example Level 1: Default controller (simplest)
 * ```typescript
 * import { TentickleModule } from '@tentickle/nestjs';
 * import { createApp } from '@tentickle/core';
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
 * import { TentickleModule, TentickleService } from '@tentickle/nestjs';
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
 *
 * @Controller('chat')
 * export class ChatController {
 *   constructor(private tentickle: TentickleService) {}
 *
 *   @Post()
 *   async chat(@Body() body: { message: string }) {
 *     const { sessionId } = await this.tentickle.createSession();
 *     return this.tentickle.sendMessage(sessionId, body.message);
 *   }
 * }
 * ```
 *
 * @example Level 3: Raw handlers for full control
 * ```typescript
 * import {
 *   TentickleModule,
 *   TENTICKLE_SESSION_HANDLER,
 *   TENTICKLE_EVENT_BRIDGE,
 * } from '@tentickle/nestjs';
 *
 * @Injectable()
 * export class AdvancedService {
 *   constructor(
 *     @Inject(TENTICKLE_SESSION_HANDLER) private handler: SessionHandler,
 *     @Inject(TENTICKLE_EVENT_BRIDGE) private bridge: EventBridge,
 *   ) {}
 * }
 * ```
 */
@Module({})
export class TentickleModule {
  /**
   * Register module with static configuration.
   */
  static forRoot(options: TentickleModuleOptions): DynamicModule {
    const providers = this.createProviders(options);
    const controllers =
      options.registerController !== false ? [TentickleController] : [];

    return {
      module: TentickleModule,
      controllers,
      providers,
      exports: [
        TentickleService,
        TENTICKLE_SESSION_HANDLER,
        TENTICKLE_EVENT_BRIDGE,
      ],
    };
  }

  /**
   * Register module with async configuration.
   */
  static forRootAsync(options: TentickleModuleAsyncOptions): DynamicModule {
    const providers = this.createAsyncProviders(options);
    const controllers =
      options.registerController !== false ? [TentickleController] : [];

    return {
      module: TentickleModule,
      imports: options.imports || [],
      controllers,
      providers,
      exports: [
        TentickleService,
        TENTICKLE_SESSION_HANDLER,
        TENTICKLE_EVENT_BRIDGE,
      ],
    };
  }

  private static createProviders(options: TentickleModuleOptions): Provider[] {
    return [
      {
        provide: TENTICKLE_OPTIONS,
        useValue: options,
      },
      {
        provide: TENTICKLE_SESSION_HANDLER,
        useFactory: () => createSessionHandler(options.sessionHandler),
      },
      {
        provide: TENTICKLE_EVENT_BRIDGE,
        useFactory: (sessionHandler) =>
          createEventBridge({
            sessionHandler,
            ...options.eventBridge,
          }),
        inject: [TENTICKLE_SESSION_HANDLER],
      },
      TentickleService,
    ];
  }

  private static createAsyncProviders(
    options: TentickleModuleAsyncOptions,
  ): Provider[] {
    const providers: Provider[] = [
      {
        provide: TENTICKLE_SESSION_HANDLER,
        useFactory: (opts: TentickleModuleOptions) =>
          createSessionHandler(opts.sessionHandler),
        inject: [TENTICKLE_OPTIONS],
      },
      {
        provide: TENTICKLE_EVENT_BRIDGE,
        useFactory: (opts: TentickleModuleOptions, sessionHandler) =>
          createEventBridge({
            sessionHandler,
            ...opts.eventBridge,
          }),
        inject: [TENTICKLE_OPTIONS, TENTICKLE_SESSION_HANDLER],
      },
      TentickleService,
    ];

    if (options.useFactory) {
      providers.push({
        provide: TENTICKLE_OPTIONS,
        useFactory: options.useFactory,
        inject: options.inject || [],
      });
    } else if (options.useClass) {
      providers.push(
        {
          provide: options.useClass,
          useClass: options.useClass,
        },
        {
          provide: TENTICKLE_OPTIONS,
          useFactory: async (factory: TentickleModuleOptionsFactory) =>
            factory.createTentickleOptions(),
          inject: [options.useClass],
        },
      );
    } else if (options.useExisting) {
      providers.push({
        provide: TENTICKLE_OPTIONS,
        useFactory: async (factory: TentickleModuleOptionsFactory) =>
          factory.createTentickleOptions(),
        inject: [options.useExisting],
      });
    }

    return providers;
  }
}
