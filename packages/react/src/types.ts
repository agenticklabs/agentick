/**
 * React integration types for Tentickle.
 *
 * @module @tentickle/react/types
 */

import type {
  TentickleClient,
  ConnectionState,
  StreamEvent,
  ContentBlock,
  Message,
  SessionMessagePayload,
} from "@tentickle/client";
import type { ReactNode } from "react";

// ============================================================================
// Provider Types
// ============================================================================

/**
 * Configuration for TentickleProvider.
 */
export interface TentickleProviderProps {
  /**
   * Pre-configured client instance.
   * If provided, clientConfig is ignored.
   */
  client?: TentickleClient;

  /**
   * Client configuration (used if client is not provided).
   */
  clientConfig?: {
    baseUrl: string;
    token?: string;
    userId?: string;
    headers?: Record<string, string>;
    paths?: {
      events?: string;
      sessions?: string;
    };
  };

  /**
   * Children to render.
   */
  children: ReactNode;
}

/**
 * Context value for TentickleProvider.
 */
export interface TentickleContextValue {
  /**
   * The Tentickle client instance.
   */
  client: TentickleClient;
}

// ============================================================================
// Hook Types
// ============================================================================

/**
 * Options for useSession hook.
 */
export interface UseSessionOptions {
  /**
   * Session ID to connect to.
   * If not provided, a new session will be created.
   */
  sessionId?: string;

  /**
   * Whether to auto-connect on mount.
   * @default true
   */
  autoConnect?: boolean;

  /**
   * Initial props for new sessions.
   */
  initialProps?: Record<string, unknown>;
}

/**
 * Return value from useSession hook.
 */
export interface UseSessionResult {
  /**
   * Current session ID (undefined until connected).
   */
  sessionId: string | undefined;

  /**
   * Current connection state.
   */
  connectionState: ConnectionState;

  /**
   * Whether currently connected.
   */
  isConnected: boolean;

  /**
   * Whether currently connecting.
   */
  isConnecting: boolean;

  /**
   * Error if connection failed.
   */
  error: Error | undefined;

  /**
   * Connect to session (called automatically if autoConnect is true).
   */
  connect: (sessionId?: string) => Promise<void>;

  /**
   * Disconnect from session.
   */
  disconnect: () => Promise<void>;

  /**
   * Send a message to the session.
   */
  send: (
    input:
      | string
      | string[]
      | ContentBlock
      | ContentBlock[]
      | Message
      | Message[]
      | SessionMessagePayload,
  ) => Promise<void>;

  /**
   * Trigger a tick with optional props.
   */
  tick: (props?: Record<string, unknown>) => Promise<void>;

  /**
   * Abort the current execution.
   */
  abort: (reason?: string) => Promise<void>;
}

/**
 * Options for useEvents hook.
 */
export interface UseEventsOptions {
  /**
   * Filter events by type.
   * If provided, only events of these types are returned.
   */
  filter?: StreamEvent["type"][];

  /**
   * Whether the hook is enabled.
   * @default true
   */
  enabled?: boolean;
}

/**
 * Return value from useEvents hook.
 */
export interface UseEventsResult {
  /**
   * Latest event received (not accumulated).
   * Use useStreamingText for accumulated text.
   */
  event: StreamEvent | undefined;

  /**
   * Clear the current event.
   */
  clear: () => void;
}

/**
 * Options for useStreamingText hook.
 */
export interface UseStreamingTextOptions {
  /**
   * Whether the hook is enabled.
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
   * Whether streaming is currently active.
   */
  isStreaming: boolean;

  /**
   * Clear the accumulated text.
   */
  clear: () => void;
}

// ============================================================================
// Re-exports
// ============================================================================

export type {
  TentickleClient,
  ConnectionState,
  StreamEvent,
  StreamingTextState,
} from "@tentickle/client";
