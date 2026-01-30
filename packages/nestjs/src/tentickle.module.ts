/**
 * TentickleModule - NestJS module for Tentickle.
 *
 * @module @tentickle/nestjs/module
 */

import { Module, type DynamicModule, type Provider, type Type } from "@nestjs/common";
import { TentickleController } from "./tentickle.controller";
import { TentickleService } from "./tentickle.service";
import {
  TENTICKLE_OPTIONS,
  TENTICKLE_APP,
  type TentickleModuleOptions,
  type TentickleModuleAsyncOptions,
  type TentickleModuleOptionsFactory,
} from "./types";

/**
 * NestJS module for Tentickle.
 *
 * Provides multiplexed SSE session access with App injection.
 *
 * @example Default controller (simplest)
 * ```typescript
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
 * @example Custom controller with TentickleService
 * ```typescript
 * import { TentickleModule, TentickleService } from '@tentickle/nestjs';
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
 *
 * @Controller('chat')
 * export class ChatController {
 *   constructor(private tentickle: TentickleService) {}
 *
 *   @Post()
 *   async chat(@Body() body: { message: string }) {
 *     const handle = await this.tentickle.send({
 *       message: { role: 'user', content: [{ type: 'text', text: body.message }] },
 *     });
 *     return handle.result;
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
    const providers = this.createProviders(options);
    const controllers = options.registerController !== false ? [TentickleController] : [];

    return {
      module: TentickleModule,
      controllers,
      providers,
      exports: [TentickleService, TENTICKLE_APP],
    };
  }

  /**
   * Register module with async configuration.
   */
  static forRootAsync(options: TentickleModuleAsyncOptions): DynamicModule {
    const providers = this.createAsyncProviders(options);
    const controllers = options.registerController !== false ? [TentickleController] : [];

    return {
      module: TentickleModule,
      imports: options.imports || [],
      controllers,
      providers,
      exports: [TentickleService, TENTICKLE_APP],
    };
  }

  private static createProviders(options: TentickleModuleOptions): Provider[] {
    return [
      {
        provide: TENTICKLE_OPTIONS,
        useValue: options,
      },
      {
        provide: TENTICKLE_APP,
        useValue: options.app,
      },
      TentickleService,
    ];
  }

  private static createAsyncProviders(options: TentickleModuleAsyncOptions): Provider[] {
    const providers: Provider[] = [
      {
        provide: TENTICKLE_APP,
        useFactory: (opts: TentickleModuleOptions) => opts.app,
        inject: [TENTICKLE_OPTIONS],
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
