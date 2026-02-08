/**
 * React hooks for Agentick.
 *
 * @module @agentick/react/hooks
 */

import {
  useState,
  useEffect,
  useCallback,
  useRef,
  useSyncExternalStore,
  useMemo,
  useContext,
} from "react";
import type {
  AgentickClient,
  ConnectionState,
  StreamEvent,
  SessionStreamEvent,
  StreamingTextState,
  SessionAccessor,
} from "@agentick/client";
import { AgentickContext } from "./context";
import type {
  UseSessionOptions,
  UseSessionResult,
  UseEventsOptions,
  UseEventsResult,
  UseStreamingTextOptions,
  UseStreamingTextResult,
  UseConnectionOptions,
  UseConnectionResult,
} from "./types";

// ============================================================================
// useClient
// ============================================================================

/**
 * Access the Agentick client from context.
 *
 * @throws If used outside of AgentickProvider
 *
 * @example
 * ```tsx
 * import { useClient } from '@agentick/react';
 *
 * function MyComponent() {
 *   const client = useClient();
 *
 *   // Direct client access for advanced use cases
 *   const handleCustomChannel = () => {
 *     const session = client.session('conv-123');
 *     const channel = session.channel('custom');
 *     channel.publish('event', { data: 'value' });
 *   };
 *
 *   return <button onClick={handleCustomChannel}>Send</button>;
 * }
 * ```
 */
export function useClient(): AgentickClient {
  const context = useContext(AgentickContext);

  if (!context) {
    throw new Error("useClient must be used within a AgentickProvider");
  }

  return context.client;
}

// ============================================================================
// useConnectionState (alias for useConnection)
// ============================================================================

/**
 * Subscribe to connection state changes.
 *
 * @example
 * ```tsx
 * import { useConnectionState } from '@agentick/react';
 *
 * function ConnectionIndicator() {
 *   const state = useConnectionState();
 *
 *   return (
 *     <div className={`indicator ${state}`}>
 *       {state === 'connected' ? 'Online' : 'Offline'}
 *     </div>
 *   );
 * }
 * ```
 */
export function useConnectionState(): ConnectionState {
  const client = useClient();
  const [state, setState] = useState<ConnectionState>(client.state);

  useEffect(() => {
    // Sync initial state
    setState(client.state);

    // Subscribe to changes
    const unsubscribe = client.onConnectionChange(setState);
    return unsubscribe;
  }, [client]);

  return state;
}

// ============================================================================
// useConnection
// ============================================================================

/**
 * Read the SSE connection state.
 */
export function useConnection(_options: UseConnectionOptions = {}): UseConnectionResult {
  const client = useClient();
  const [state, setState] = useState<ConnectionState>(client.state);

  useEffect(() => {
    setState(client.state);
    return client.onConnectionChange(setState);
  }, [client]);

  return {
    state,
    isConnected: state === "connected",
    isConnecting: state === "connecting",
  };
}

// ============================================================================
// useSession
// ============================================================================

/**
 * Work with a specific session.
 *
 * @example Basic usage with session ID
 * ```tsx
 * import { useSession } from '@agentick/react';
 *
 * function Chat({ sessionId }: { sessionId: string }) {
 *   const { send, isSubscribed, subscribe } = useSession({ sessionId });
 *   const [input, setInput] = useState('');
 *
 *   // Subscribe on mount
 *   useEffect(() => {
 *     subscribe();
 *   }, [subscribe]);
 *
 *   const handleSend = async () => {
 *     await send(input);
 *     setInput('');
 *   };
 *
 *   return (
 *     <div>
 *       <input value={input} onChange={(e) => setInput(e.target.value)} />
 *       <button onClick={handleSend}>Send</button>
 *     </div>
 *   );
 * }
 * ```
 *
 * @example Ephemeral session (no sessionId)
 * ```tsx
 * function QuickChat() {
 *   const { send } = useSession();
 *
 *   // Each send creates/uses an ephemeral session
 *   const handleSend = () => send('Hello!');
 *
 *   return <button onClick={handleSend}>Ask</button>;
 * }
 * ```
 *
 * @example Auto-subscribe
 * ```tsx
 * function Chat({ sessionId }: { sessionId: string }) {
 *   const { send, isSubscribed } = useSession({
 *     sessionId,
 *     autoSubscribe: true,
 *   });
 *
 *   if (!isSubscribed) return <div>Subscribing...</div>;
 *
 *   return <ChatInterface />;
 * }
 * ```
 */
export function useSession(options: UseSessionOptions = {}): UseSessionResult {
  const { sessionId, autoSubscribe = false } = options;

  const client = useClient();
  const mountedRef = useRef(true);

  // Get or create session accessor
  const accessor = useMemo<SessionAccessor | undefined>(() => {
    if (!sessionId) return undefined;
    return client.session(sessionId);
  }, [client, sessionId]);

  const [isSubscribed, setIsSubscribed] = useState(false);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Subscribe function
  const subscribe = useCallback(() => {
    if (!accessor) return;
    accessor.subscribe();
    if (mountedRef.current) {
      setIsSubscribed(true);
    }
  }, [accessor]);

  // Unsubscribe function
  const unsubscribe = useCallback(() => {
    if (!accessor) return;
    accessor.unsubscribe();
    if (mountedRef.current) {
      setIsSubscribed(false);
    }
  }, [accessor]);

  // Auto-subscribe
  useEffect(() => {
    if (autoSubscribe && accessor && !isSubscribed) {
      subscribe();
    }
  }, [autoSubscribe, accessor, isSubscribed, subscribe]);

  // Send function
  const send = useCallback(
    (input: Parameters<UseSessionResult["send"]>[0]) => {
      if (accessor) {
        const normalizedInput =
          typeof input === "string"
            ? {
                message: {
                  role: "user" as const,
                  content: [{ type: "text" as const, text: input }],
                },
              }
            : input;
        return accessor.send(normalizedInput as any);
      }
      return client.send(input as any);
    },
    [client, accessor],
  );

  // Abort function
  const abort = useCallback(
    async (reason?: string) => {
      if (accessor) {
        await accessor.abort(reason);
      } else if (sessionId) {
        await client.abort(sessionId, reason);
      }
    },
    [client, accessor, sessionId],
  );

  // Close function
  const close = useCallback(async () => {
    if (accessor) {
      await accessor.close();
    } else if (sessionId) {
      await client.closeSession(sessionId);
    }
  }, [client, accessor, sessionId]);

  return {
    sessionId,
    isSubscribed,
    subscribe,
    unsubscribe,
    send,
    abort,
    close,
    accessor,
  };
}

// ============================================================================
// useEvents
// ============================================================================

/**
 * Subscribe to stream events.
 *
 * Returns the latest event (not accumulated). Use useStreamingText
 * for accumulated text from content_delta events.
 *
 * @example
 * ```tsx
 * import { useEvents } from '@agentick/react';
 *
 * function EventLog() {
 *   const { event } = useEvents();
 *
 *   useEffect(() => {
 *     if (event) {
 *       console.log('Event:', event.type, event);
 *     }
 *   }, [event]);
 *
 *   return <div>Latest: {event?.type}</div>;
 * }
 * ```
 *
 * @example With filter
 * ```tsx
 * function ToolCalls() {
 *   const { event } = useEvents({ filter: ['tool_call', 'tool_result'] });
 *
 *   if (!event) return null;
 *
 *   return <div>Tool: {event.type === 'tool_call' ? event.name : 'result'}</div>;
 * }
 * ```
 *
 * @example Session-specific events
 * ```tsx
 * function SessionEvents({ sessionId }: { sessionId: string }) {
 *   const { event } = useEvents({ sessionId });
 *   // Only receives events for this session
 *   return <div>{event?.type}</div>;
 * }
 * ```
 */
export function useEvents(options: UseEventsOptions = {}): UseEventsResult {
  const { filter, sessionId, enabled = true } = options;

  const client = useClient();
  const [event, setEvent] = useState<StreamEvent | SessionStreamEvent | undefined>();

  useEffect(() => {
    if (!enabled) return;

    // Use session-specific subscription if sessionId provided
    if (sessionId) {
      const accessor = client.session(sessionId);
      const unsubscribe = accessor.onEvent((incoming) => {
        if (filter && !filter.includes(incoming.type)) {
          return;
        }
        setEvent(incoming);
      });
      return unsubscribe;
    }

    // Global subscription
    const unsubscribe = client.onEvent((incoming) => {
      if (filter && !filter.includes(incoming.type)) {
        return;
      }
      setEvent(incoming);
    });

    return unsubscribe;
  }, [client, sessionId, enabled, filter]);

  const clear = useCallback(() => {
    setEvent(undefined);
  }, []);

  return { event, clear };
}

// ============================================================================
// useStreamingText
// ============================================================================

/**
 * Subscribe to streaming text from the client.
 *
 * Uses the client's built-in streaming text accumulation which handles
 * tick_start, content_delta, tick_end, and execution_end events.
 *
 * @example
 * ```tsx
 * import { useStreamingText } from '@agentick/react';
 *
 * function StreamingResponse() {
 *   const { text, isStreaming } = useStreamingText();
 *
 *   return (
 *     <div>
 *       <p>{text}</p>
 *       {isStreaming && <span className="cursor">|</span>}
 *     </div>
 *   );
 * }
 * ```
 */
export function useStreamingText(options: UseStreamingTextOptions = {}): UseStreamingTextResult {
  const { enabled = true } = options;
  const client = useClient();

  // Use useSyncExternalStore for concurrent-safe subscription
  const state = useSyncExternalStore<StreamingTextState>(
    useCallback(
      (onStoreChange) => {
        if (!enabled) return () => {};
        return client.onStreamingText(onStoreChange);
      },
      [client, enabled],
    ),
    () => (enabled ? client.streamingText : { text: "", isStreaming: false }),
    () => ({ text: "", isStreaming: false }),
  );

  const clear = useCallback(() => {
    client.clearStreamingText();
  }, [client]);

  return { text: state.text, isStreaming: state.isStreaming, clear };
}

// ============================================================================
// useContextInfo
// ============================================================================

/**
 * Context utilization info from the server.
 * Updated after each tick with token usage and model capabilities.
 */
export interface ContextInfo {
  /** Model ID (e.g., "gpt-4o", "claude-3-5-sonnet-20241022") */
  modelId: string;
  /** Human-readable model name */
  modelName?: string;
  /** Provider name (e.g., "openai", "anthropic") */
  provider?: string;
  /** Context window size in tokens */
  contextWindow?: number;
  /** Input tokens used this tick */
  inputTokens: number;
  /** Output tokens generated this tick */
  outputTokens: number;
  /** Total tokens this tick */
  totalTokens: number;
  /** Context utilization percentage (0-100) */
  utilization?: number;
  /** Max output tokens for this model */
  maxOutputTokens?: number;
  /** Model capabilities */
  supportsVision?: boolean;
  supportsToolUse?: boolean;
  isReasoningModel?: boolean;
  /** Current tick number */
  tick: number;
  /** Cumulative usage across all ticks in this execution */
  cumulativeUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    ticks: number;
  };
}

/**
 * Options for useContextInfo hook.
 */
export interface UseContextInfoOptions {
  /**
   * Optional session ID to filter events for.
   * If not provided, receives context info from any session.
   */
  sessionId?: string;

  /**
   * Whether the hook is enabled.
   * If false, no context info subscription is created.
   * @default true
   */
  enabled?: boolean;
}

/**
 * Return value from useContextInfo hook.
 */
export interface UseContextInfoResult {
  /**
   * Latest context info (null before first tick completes).
   */
  contextInfo: ContextInfo | null;

  /**
   * Clear the current context info.
   */
  clear: () => void;
}

/**
 * Subscribe to context utilization info from the server.
 *
 * Receives context_update events after each tick with:
 * - Token usage (input, output, total)
 * - Context utilization percentage
 * - Model capabilities (vision, tools, reasoning)
 * - Cumulative usage across ticks
 *
 * @example Basic usage
 * ```tsx
 * import { useContextInfo } from '@agentick/react';
 *
 * function ContextBar() {
 *   const { contextInfo } = useContextInfo();
 *
 *   if (!contextInfo) return null;
 *
 *   return (
 *     <div className="context-bar">
 *       <span>{contextInfo.modelId}</span>
 *       <span>{contextInfo.utilization?.toFixed(1)}% used</span>
 *       <progress value={contextInfo.utilization} max={100} />
 *     </div>
 *   );
 * }
 * ```
 *
 * @example Session-specific context info
 * ```tsx
 * function SessionContext({ sessionId }: { sessionId: string }) {
 *   const { contextInfo } = useContextInfo({ sessionId });
 *
 *   if (!contextInfo) return <span>No context yet</span>;
 *
 *   return (
 *     <span>
 *       {contextInfo.inputTokens.toLocaleString()} /
 *       {contextInfo.contextWindow?.toLocaleString() ?? '?'} tokens
 *     </span>
 *   );
 * }
 * ```
 */
export function useContextInfo(options: UseContextInfoOptions = {}): UseContextInfoResult {
  const { sessionId, enabled = true } = options;
  const client = useClient();
  const [contextInfo, setContextInfo] = useState<ContextInfo | null>(null);

  useEffect(() => {
    if (!enabled) return;

    // Subscribe to context_update events
    const handleEvent = (event: StreamEvent | SessionStreamEvent) => {
      if (event.type !== "context_update") return;

      // Type assertion since we filtered by type
      const ctxEvent = event as StreamEvent & {
        modelId: string;
        modelName?: string;
        provider?: string;
        contextWindow?: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        utilization?: number;
        maxOutputTokens?: number;
        supportsVision?: boolean;
        supportsToolUse?: boolean;
        isReasoningModel?: boolean;
        tick: number;
        cumulativeUsage?: ContextInfo["cumulativeUsage"];
      };

      setContextInfo({
        modelId: ctxEvent.modelId,
        modelName: ctxEvent.modelName,
        provider: ctxEvent.provider,
        contextWindow: ctxEvent.contextWindow,
        inputTokens: ctxEvent.inputTokens,
        outputTokens: ctxEvent.outputTokens,
        totalTokens: ctxEvent.totalTokens,
        utilization: ctxEvent.utilization,
        maxOutputTokens: ctxEvent.maxOutputTokens,
        supportsVision: ctxEvent.supportsVision,
        supportsToolUse: ctxEvent.supportsToolUse,
        isReasoningModel: ctxEvent.isReasoningModel,
        tick: ctxEvent.tick,
        cumulativeUsage: ctxEvent.cumulativeUsage,
      });
    };

    // Use session-specific subscription if sessionId provided
    if (sessionId) {
      const accessor = client.session(sessionId);
      return accessor.onEvent(handleEvent);
    }

    // Global subscription
    return client.onEvent(handleEvent);
  }, [client, sessionId, enabled]);

  const clear = useCallback(() => {
    setContextInfo(null);
  }, []);

  return { contextInfo, clear };
}
