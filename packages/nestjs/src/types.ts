/**
 * NestJS module types for Tentickle.
 *
 * @module @tentickle/nestjs/types
 */

import type { ModuleMetadata, Type, InjectionToken } from "@nestjs/common";
import type {
  SessionHandler,
  EventBridge,
  SessionHandlerConfig,
  EventBridgeConfig,
} from "@tentickle/server";

// ============================================================================
// Module Configuration
// ============================================================================

/**
 * Configuration for TentickleModule.
 */
export interface TentickleModuleOptions {
  /**
   * Session handler configuration.
   */
  sessionHandler: SessionHandlerConfig;

  /**
   * Event bridge configuration (optional).
   * If not provided, uses sessionHandler from above.
   */
  eventBridge?: Omit<EventBridgeConfig, "sessionHandler">;

  /**
   * Controller path prefix.
   * @default "tentickle"
   */
  path?: string;

  /**
   * Whether to register the default controller.
   * Set to false if you want to define your own routes.
   * @default true
   */
  registerController?: boolean;
}

/**
 * Async configuration factory.
 */
export interface TentickleModuleOptionsFactory {
  createTentickleOptions():
    | Promise<TentickleModuleOptions>
    | TentickleModuleOptions;
}

/**
 * Async module configuration.
 */
export interface TentickleModuleAsyncOptions
  extends Pick<ModuleMetadata, "imports"> {
  /**
   * Factory function for options.
   */
  useFactory?: (
    ...args: unknown[]
  ) => Promise<TentickleModuleOptions> | TentickleModuleOptions;

  /**
   * Dependencies to inject into factory.
   */
  inject?: InjectionToken[];

  /**
   * Class that implements TentickleModuleOptionsFactory.
   */
  useClass?: Type<TentickleModuleOptionsFactory>;

  /**
   * Existing provider to use.
   */
  useExisting?: Type<TentickleModuleOptionsFactory>;

  /**
   * Whether to register the default controller.
   * Set to false if you want to define your own routes.
   * @default true
   */
  registerController?: boolean;
}

// ============================================================================
// Injection Tokens
// ============================================================================

/**
 * Injection token for TentickleModuleOptions.
 */
export const TENTICKLE_OPTIONS = "TENTICKLE_OPTIONS";

/**
 * Injection token for SessionHandler.
 */
export const TENTICKLE_SESSION_HANDLER = "TENTICKLE_SESSION_HANDLER";

/**
 * Injection token for EventBridge.
 */
export const TENTICKLE_EVENT_BRIDGE = "TENTICKLE_EVENT_BRIDGE";

// ============================================================================
// Re-exports
// ============================================================================

export type {
  SessionHandler,
  EventBridge,
  SessionHandlerConfig,
  EventBridgeConfig,
  CreateSessionInput,
  SendInput,
  ServerConnection,
  SessionStateInfo,
} from "@tentickle/server";
