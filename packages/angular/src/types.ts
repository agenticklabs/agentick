/**
 * Angular integration types for Tentickle.
 *
 * @module @tentickle/angular/types
 */

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Configuration for TentickleService.
 */
export interface TentickleConfig {
  /**
   * Base URL of the Tentickle server.
   */
  baseUrl: string;

  /**
   * Authentication token (adds Authorization: Bearer header).
   */
  token?: string;

  /**
   * User ID for session metadata.
   */
  userId?: string;

  /**
   * Custom headers for requests.
   */
  headers?: Record<string, string>;

  /**
   * Custom path configuration.
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
   * Request timeout in milliseconds.
   * @default 30000
   */
  timeout?: number;
}

// ============================================================================
// Re-exports
// ============================================================================

export type {
  TentickleClient,
  ConnectionState,
  StreamEvent,
  SessionStreamEvent,
  ClientExecutionHandle,
  StreamingTextState,
} from "@tentickle/client";
