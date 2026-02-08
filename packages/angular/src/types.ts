/**
 * Angular integration types for Agentick.
 *
 * @module @agentick/angular/types
 */

import type { ClientTransport } from "@agentick/client";

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Transport configuration for AgentickService.
 * Can be a built-in transport type or a custom ClientTransport instance.
 */
export type TransportConfig = "sse" | "websocket" | "auto" | ClientTransport;

/**
 * Configuration for AgentickService.
 */
export interface AgentickConfig {
  /**
   * Base URL of the Agentick server.
   */
  baseUrl: string;

  /**
   * Transport to use for communication.
   * - "sse": HTTP/SSE transport (default for http:// and https:// URLs)
   * - "websocket": WebSocket transport (default for ws:// and wss:// URLs)
   * - "auto": Auto-detect based on URL scheme (default)
   * - ClientTransport instance: Use a custom transport (e.g., SharedTransport for multi-tab)
   *
   * @example
   * ```typescript
   * import { createSharedTransport } from '@agentick/client-multiplexer';
   *
   * providers: [
   *   {
   *     provide: TENTICKLE_CONFIG,
   *     useValue: {
   *       baseUrl: 'https://api.example.com',
   *       transport: createSharedTransport({ baseUrl: 'https://api.example.com' }),
   *     },
   *   },
   * ]
   * ```
   */
  transport?: TransportConfig;

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
  AgentickClient,
  ConnectionState,
  StreamEvent,
  SessionStreamEvent,
  ClientExecutionHandle,
  StreamingTextState,
  ClientTransport,
} from "@agentick/client";
