/**
 * React integration types for Agentick.
 *
 * @module @agentick/react/types
 */

import type {
  AgentickClient,
  ConnectionState,
  StreamEvent,
  SendInput,
  SessionAccessor,
  ClientExecutionHandle,
  SessionStreamEvent,
  ClientTransport,
} from "@agentick/client";
import type { ContentBlock, Message } from "@agentick/shared";
import type { ReactNode } from "react";

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Transport configuration for AgentickProvider.
 * Can be a built-in transport type or a custom ClientTransport instance.
 */
export type TransportConfig = "sse" | "websocket" | "auto" | ClientTransport;

/**
 * Configuration for AgentickProvider.
 */
export interface AgentickProviderProps {
  /**
   * Pre-configured client instance.
   * If provided, clientConfig is ignored.
   */
  client?: AgentickClient;

  /**
   * Client configuration (used if client is not provided).
   */
  clientConfig?: {
    baseUrl: string;
    /**
     * Transport to use for communication.
     * - "sse": HTTP/SSE transport (default for http:// and https:// URLs)
     * - "websocket": WebSocket transport (default for ws:// and wss:// URLs)
     * - "auto": Auto-detect based on URL scheme (default)
     * - ClientTransport instance: Use a custom transport (e.g., SharedTransport for multi-tab)
     *
     * @example
     * ```tsx
     * import { createSharedTransport } from '@agentick/client-multiplexer';
     *
     * <AgentickProvider clientConfig={{
     *   baseUrl: 'https://api.example.com',
     *   transport: createSharedTransport({ baseUrl: 'https://api.example.com' }),
     * }}>
     * ```
     */
    transport?: TransportConfig;
    token?: string;
    withCredentials?: boolean;
    timeout?: number;
    paths?: {
      events?: string;
      send?: string;
      subscribe?: string;
      abort?: string;
      close?: string;
      channel?: string;
    };
  };

  children?: ReactNode;
}

/**
 * Context value provided by AgentickProvider.
 */
export interface AgentickContextValue {
  client: AgentickClient;
}

// ============================================================================
// Session Hooks
// ============================================================================

/**
 * Options for useSession hook.
 */
export interface UseSessionOptions {
  /**
   * Session ID to work with.
   * If not provided, send() will use ephemeral sessions.
   */
  sessionId?: string;

  /**
   * Automatically subscribe to the session on mount.
   * Requires sessionId to be provided.
   * @default false
   */
  autoSubscribe?: boolean;
}

/**
 * Return value from useSession hook.
 */
export interface UseSessionResult {
  /**
   * Session ID (if provided in options).
   */
  sessionId?: string;

  /**
   * Whether this session is subscribed.
   */
  isSubscribed: boolean;

  /**
   * Subscribe to this session (only if sessionId provided).
   */
  subscribe: () => void;

  /**
   * Unsubscribe from this session.
   */
  unsubscribe: () => void;

  /**
   * Send a message.
   *
   * If sessionId was provided, sends to that session.
   * Otherwise, creates an ephemeral session.
   */
  send: (
    input: string | ContentBlock | ContentBlock[] | Message | Message[] | SendInput,
  ) => ClientExecutionHandle;

  /**
   * Abort the session's current execution.
   */
  abort: (reason?: string) => Promise<void>;

  /**
   * Close this session.
   */
  close: () => Promise<void>;

  /**
   * Session accessor for advanced operations (channels, tool confirmations).
   * Only available if sessionId was provided.
   */
  accessor?: SessionAccessor;
}

// ============================================================================
// Connection Hooks
// ============================================================================

/**
 * Options for useConnection hook.
 */
export interface UseConnectionOptions {}

/**
 * Return value from useConnection hook.
 */
export interface UseConnectionResult {
  /**
   * Current connection state.
   */
  state: ConnectionState;

  /**
   * Whether currently connected.
   */
  isConnected: boolean;

  /**
   * Whether currently connecting.
   */
  isConnecting: boolean;
}

// ============================================================================
// Event Hooks
// ============================================================================

/**
 * Options for useEvents hook.
 */
export interface UseEventsOptions {
  /**
   * Optional session ID to filter events for.
   * If not provided, receives all events from all sessions.
   */
  sessionId?: string;

  /**
   * Optional event type filter.
   * If provided, only events of these types are returned.
   */
  filter?: Array<StreamEvent["type"] | SessionStreamEvent["type"]>;

  /**
   * Whether the hook is enabled.
   * If false, no event subscription is created.
   * @default true
   */
  enabled?: boolean;
}

/**
 * Return value from useEvents hook.
 */
export interface UseEventsResult {
  /**
   * Latest event received.
   */
  event: StreamEvent | SessionStreamEvent | undefined;

  /**
   * Clear the current event.
   */
  clear: () => void;
}

// ============================================================================
// Streaming Text Hooks
// ============================================================================

/**
 * Options for useStreamingText hook.
 */
export interface UseStreamingTextOptions {
  /**
   * Optional session ID to filter events for.
   * If not provided, receives text from all sessions.
   */
  sessionId?: string;

  /**
   * Whether the hook is enabled.
   * If false, no text accumulation occurs.
   * @default true
   */
  enabled?: boolean;
}

/**
 * Return value from useStreamingText hook.
 */
export interface UseStreamingTextResult {
  /**
   * Accumulated text from content_delta events.
   */
  text: string;

  /**
   * Whether currently streaming (between tick_start and execution_end).
   */
  isStreaming: boolean;

  /**
   * Clear the accumulated text.
   */
  clear: () => void;
}
