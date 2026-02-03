/**
 * React hooks for Tentickle.
 *
 * @module @tentickle/react/hooks
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
  TentickleClient,
  ConnectionState,
  StreamEvent,
  SessionStreamEvent,
  StreamingTextState,
  SessionAccessor,
} from "@tentickle/client";
import { TentickleContext } from "./context";
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
 * Access the Tentickle client from context.
 *
 * @throws If used outside of TentickleProvider
 *
 * @example
 * ```tsx
 * import { useClient } from '@tentickle/react';
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
export function useClient(): TentickleClient {
  const context = useContext(TentickleContext);

  if (!context) {
    throw new Error("useClient must be used within a TentickleProvider");
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
 * import { useConnectionState } from '@tentickle/react';
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
 * import { useSession } from '@tentickle/react';
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
 * import { useEvents } from '@tentickle/react';
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
 * import { useStreamingText } from '@tentickle/react';
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
