/**
 * Client Transport Interface
 *
 * Abstracts the connection layer (SSE/HTTP vs WebSocket vs Local) from client business logic.
 * Defined in shared so that both @agentick/client and @agentick/core can implement transports
 * without circular dependencies.
 *
 * @module @agentick/shared/transport
 */

import type { SendInput, ChannelEvent, ToolConfirmationResponse } from "./protocol";
import type { ContentBlock } from "./blocks";

// ============================================================================
// Transport Events
// ============================================================================

export interface TransportEventData {
  type: string;
  sessionId?: string;
  executionId?: string;
  [key: string]: unknown;
}

export type TransportEventHandler = (event: TransportEventData) => void;

// ============================================================================
// Transport Interface
// ============================================================================

/**
 * Transport connection state.
 */
export type TransportState = "disconnected" | "connecting" | "connected" | "error";

/**
 * Transport interface - abstracts SSE/HTTP vs WebSocket vs Local.
 */
export interface ClientTransport {
  /** Current connection state */
  readonly state: TransportState;

  /** Connection ID (if assigned by server) */
  readonly connectionId: string | undefined;

  /** Connect to the server */
  connect(): Promise<void>;

  /** Disconnect from the server */
  disconnect(): void;

  /**
   * Send a message and return a stream of events.
   * Returns an async iterator of events for this execution.
   */
  send(
    input: SendInput,
    sessionId?: string,
  ): AsyncIterable<TransportEventData> & {
    /** Abort the current send operation */
    abort(reason?: string): void;
  };

  /** Subscribe to session events */
  subscribeToSession(sessionId: string): Promise<void>;

  /** Unsubscribe from session events */
  unsubscribeFromSession(sessionId: string): Promise<void>;

  /** Abort a session's execution */
  abortSession(sessionId: string, reason?: string): Promise<void>;

  /** Close a session */
  closeSession(sessionId: string): Promise<void>;

  /** Submit tool result */
  submitToolResult(
    sessionId: string,
    toolUseId: string,
    result: ToolConfirmationResponse,
  ): Promise<void>;

  /** Publish to a channel */
  publishToChannel(sessionId: string, channel: string, event: ChannelEvent): Promise<void>;

  /** Subscribe to a channel */
  subscribeToChannel(sessionId: string, channel: string): Promise<void>;

  /** Dispatch a tool by name. Optional — not all transports support this. */
  dispatch?(
    sessionId: string,
    name: string,
    input: Record<string, unknown>,
  ): Promise<ContentBlock[]>;

  /** Register event handler for incoming events */
  onEvent(handler: TransportEventHandler): () => void;

  /** Register state change handler */
  onStateChange(handler: (state: TransportState) => void): () => void;
}

// ============================================================================
// Transport Configuration
// ============================================================================

export interface TransportConfig {
  /** Base URL for the server */
  baseUrl: string;

  /** Authentication token */
  token?: string;

  /** Custom headers */
  headers?: Record<string, string>;

  /** Request timeout in ms */
  timeout?: number;

  /** Send credentials with requests */
  withCredentials?: boolean;
}
