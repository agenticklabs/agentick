/**
 * React hooks for Tentickle.
 *
 * @module @tentickle/react/hooks
 */

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from "react";
import type { ConnectionState, StreamEvent, StreamingTextState } from "@tentickle/client";
import { useClient } from "./context.js";
import type {
  UseSessionOptions,
  UseSessionResult,
  UseEventsOptions,
  UseEventsResult,
  UseStreamingTextOptions,
  UseStreamingTextResult,
} from "./types.js";

// ============================================================================
// useConnectionState
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
// useSession
// ============================================================================

/**
 * Manage session lifecycle.
 *
 * Creates or connects to a session, provides connection state and methods.
 *
 * @example Basic usage
 * ```tsx
 * import { useSession } from '@tentickle/react';
 *
 * function Chat() {
 *   const { isConnected, send } = useSession();
 *   const [input, setInput] = useState('');
 *
 *   const handleSend = async () => {
 *     await send(input);
 *     setInput('');
 *   };
 *
 *   if (!isConnected) return <div>Connecting...</div>;
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
 * @example With existing session
 * ```tsx
 * function Chat({ sessionId }: { sessionId: string }) {
 *   const { isConnected, send } = useSession({ sessionId });
 *   // ...
 * }
 * ```
 *
 * @example Manual connect
 * ```tsx
 * function Chat() {
 *   const { connect, isConnected } = useSession({ autoConnect: false });
 *
 *   return isConnected ? (
 *     <ChatInterface />
 *   ) : (
 *     <button onClick={() => connect()}>Start Chat</button>
 *   );
 * }
 * ```
 */
export function useSession(options: UseSessionOptions = {}): UseSessionResult {
  const { sessionId: initialSessionId, autoConnect = true, initialProps } = options;

  const client = useClient();
  const [sessionId, setSessionId] = useState<string | undefined>(initialSessionId);
  const [connectionState, setConnectionState] = useState<ConnectionState>(client.state);
  const [error, setError] = useState<Error | undefined>();

  // Track if we've initiated connection
  const connectingRef = useRef(false);
  const mountedRef = useRef(true);

  // Subscribe to connection state
  useEffect(() => {
    setConnectionState(client.state);
    const unsubscribe = client.onConnectionChange((state) => {
      if (mountedRef.current) {
        setConnectionState(state);
      }
    });
    return unsubscribe;
  }, [client]);

  // Cleanup on unmount
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Connect function
  const connect = useCallback(
    async (explicitSessionId?: string) => {
      if (connectingRef.current || connectionState === "connected") {
        return;
      }

      connectingRef.current = true;
      setError(undefined);

      try {
        let targetSessionId = explicitSessionId ?? sessionId;

        // Create session if needed
        if (!targetSessionId) {
          const result = await client.createSession({ props: initialProps });
          targetSessionId = result.sessionId;
          if (mountedRef.current) {
            setSessionId(targetSessionId);
          }
        }

        // Connect to session
        await client.connect(targetSessionId);
      } catch (err) {
        if (mountedRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        connectingRef.current = false;
      }
    },
    [client, sessionId, connectionState, initialProps],
  );

  // Disconnect function
  const disconnect = useCallback(async () => {
    try {
      await client.disconnect();
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }, [client]);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect && connectionState === "disconnected" && !connectingRef.current) {
      connect();
    }
  }, [autoConnect, connectionState, connect]);

  // Framework methods
  const send = useCallback(
    async (content: string) => {
      await client.send(content);
    },
    [client],
  );

  const tick = useCallback(
    async (props?: Record<string, unknown>) => {
      await client.tick(props);
    },
    [client],
  );

  const abort = useCallback(
    async (reason?: string) => {
      await client.abort(reason);
    },
    [client],
  );

  return {
    sessionId,
    connectionState,
    isConnected: connectionState === "connected",
    isConnecting: connectionState === "connecting",
    error,
    connect,
    disconnect,
    send,
    tick,
    abort,
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
 */
export function useEvents(options: UseEventsOptions = {}): UseEventsResult {
  const { filter, enabled = true } = options;

  const client = useClient();
  const [event, setEvent] = useState<StreamEvent | undefined>();

  useEffect(() => {
    if (!enabled) return;

    const unsubscribe = client.onEvent((incoming) => {
      // Apply filter if provided
      if (filter && !filter.includes(incoming.type)) {
        return;
      }
      setEvent(incoming);
    });

    return unsubscribe;
  }, [client, enabled, filter]);

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
export function useStreamingText(
  options: UseStreamingTextOptions = {},
): UseStreamingTextResult {
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
// useResult
// ============================================================================

/**
 * Subscribe to execution results.
 *
 * @example
 * ```tsx
 * import { useResult } from '@tentickle/react';
 *
 * function ResultDisplay() {
 *   const result = useResult();
 *
 *   if (!result) return null;
 *
 *   return (
 *     <div>
 *       <p>{result.response}</p>
 *       <small>Tokens: {result.usage.totalTokens}</small>
 *     </div>
 *   );
 * }
 * ```
 */
export function useResult() {
  const client = useClient();
  const [result, setResult] = useState<{
    response: string;
    outputs: Record<string, unknown>;
    usage: { inputTokens: number; outputTokens: number; totalTokens: number };
    stopReason?: string;
  } | undefined>();

  useEffect(() => {
    const unsubscribe = client.onResult((incoming) => {
      setResult(incoming);
    });

    return unsubscribe;
  }, [client]);

  return result;
}

// ============================================================================
// useChannel
// ============================================================================

/**
 * Access a named channel for custom pub/sub.
 *
 * @example
 * ```tsx
 * import { useChannel } from '@tentickle/react';
 *
 * function TodoList() {
 *   const [todos, setTodos] = useState([]);
 *   const channel = useChannel('todos');
 *
 *   useEffect(() => {
 *     return channel.subscribe((payload, event) => {
 *       if (event.type === 'updated') {
 *         setTodos(payload.items);
 *       }
 *     });
 *   }, [channel]);
 *
 *   const addTodo = async (title: string) => {
 *     await channel.publish('add', { title });
 *   };
 *
 *   return (
 *     <ul>
 *       {todos.map((t) => <li key={t.id}>{t.title}</li>)}
 *     </ul>
 *   );
 * }
 * ```
 */
export function useChannel(name: string) {
  const client = useClient();
  // Channel accessor is memoized in the client
  return client.channel(name);
}
