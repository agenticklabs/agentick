/**
 * NestJS module types for Tentickle.
 *
 * @module @tentickle/nestjs/types
 */

import type { ModuleMetadata, Type, InjectionToken } from "@nestjs/common";
import type { App } from "@tentickle/core";

// ============================================================================
// Module Configuration
// ============================================================================

/**
 * Configuration for TentickleModule.
 */
export interface TentickleModuleOptions {
  /**
   * The Tentickle App instance.
   */
  app: App;

  /**
   * Endpoint path overrides.
   */
  paths?: {
    events?: string;
    send?: string;
    subscribe?: string;
    abort?: string;
    close?: string;
    toolResponse?: string;
    channel?: string;
  };

  /**
   * SSE keepalive interval in ms.
   * @default 15000
   */
  sseKeepaliveInterval?: number;

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
  createTentickleOptions(): Promise<TentickleModuleOptions> | TentickleModuleOptions;
}

/**
 * Async module configuration.
 */
export interface TentickleModuleAsyncOptions extends Pick<ModuleMetadata, "imports"> {
  /**
   * Factory function for options.
   */
  useFactory?: (...args: unknown[]) => Promise<TentickleModuleOptions> | TentickleModuleOptions;

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
 * Injection token for App.
 */
export const TENTICKLE_APP = "TENTICKLE_APP";

// ============================================================================
// Re-exports
// ============================================================================

export type { SendInput } from "@tentickle/shared";
