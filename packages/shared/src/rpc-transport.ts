/**
 * RPC Client Transport
 *
 * Shared protocol machinery for all bidirectional client transports
 * (WebSocket, Unix socket, etc.). Each transport provides a delegate that
 * handles wire-specific I/O (open/send/close); this module provides
 * everything else: state machine, request correlation, event streaming,
 * send streams, reconnection, session operations.
 *
 * This eliminates the massive duplication between WSTransport and
 * UnixSocketClientTransport — the only real difference is how bytes
 * hit the wire.
 */

import type {
  ClientTransport,
  TransportEventData,
  TransportEventHandler,
  TransportState,
} from "./transport";
import type { SendInput, ChannelEvent, ToolConfirmationResponse } from "./protocol";
import { unwrapEventMessage, extractSendMessage } from "./transport-utils";

// ============================================================================
// Delegate Interface — wire-specific I/O
// ============================================================================

/** Handle to an open connection. Provided by the delegate after open(). */
export interface RPCConnectionHandle {
  /** Send a JSON-serializable object over the wire */
  send(data: Record<string, unknown>): void;
  /** Close the connection */
  close(): void;
}

/** Callbacks the delegate invokes when data arrives or the connection drops. */
export interface RPCTransportCallbacks {
  onMessage(data: Record<string, unknown>): void;
  onClose(): void;
  onError(error: Error): void;
}

/**
 * Wire-specific delegate. Implementations exist for WebSocket, Unix socket, etc.
 * The delegate is responsible ONLY for opening the raw connection, sending bytes,
 * and forwarding received messages/close/error events to the callbacks.
 */
export interface RPCTransportDelegate {
  /**
   * Open a connection to the server.
   * Must call callbacks.onMessage for each received message (already parsed JSON).
   * Must call callbacks.onClose when connection drops.
   * Must call callbacks.onError on connection errors.
   * Returns a handle for sending data and closing.
   */
  open(callbacks: RPCTransportCallbacks): Promise<RPCConnectionHandle>;
}

// ============================================================================
// Configuration
// ============================================================================

export interface RPCTransportConfig {
  /** Client ID sent in the connect message */
  clientId?: string;
  /** Authentication token */
  token?: string;
  /** Request timeout in ms (default: 30000) */
  timeout?: number;
  /** Reconnection settings */
  reconnect?: {
    enabled?: boolean;
    maxAttempts?: number;
    delay?: number;
  };
}

// ============================================================================
// Internal types
// ============================================================================

interface PendingRequest {
  resolve: (response: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface SendStream {
  events: TransportEventData[];
  resolvers: Array<(result: IteratorResult<TransportEventData>) => void>;
  closed: boolean;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a ClientTransport backed by an RPC delegate.
 *
 * The delegate handles wire I/O (WebSocket, Unix socket, etc.).
 * This function handles the full gateway RPC protocol:
 * request/response correlation, event streaming, reconnection,
 * and all session operations.
 */
export function createRPCTransport(
  config: RPCTransportConfig,
  delegate: RPCTransportDelegate,
): ClientTransport {
  let connection: RPCConnectionHandle | null = null;
  let state: TransportState = "disconnected";
  let connectionId: string | undefined;
  let connectionPromise: Promise<void> | undefined;
  let reconnectAttempts = 0;

  let requestCounter = 0;
  const pendingRequests = new Map<string, PendingRequest>();
  const eventHandlers = new Set<TransportEventHandler>();
  const stateHandlers = new Set<(state: TransportState) => void>();
  const subscriptions = new Set<string>();
  const sendStreams = new Map<string, SendStream>();

  const requestTimeout = config.timeout ?? 30000;

  // ──────────────────────────────────────────────────────────────────────────
  // State management
  // ──────────────────────────────────────────────────────────────────────────

  function setState(newState: TransportState): void {
    if (state === newState) return;
    state = newState;
    for (const handler of stateHandlers) {
      try {
        handler(newState);
      } catch (error) {
        console.error("Error in state handler:", error);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Message handling
  // ──────────────────────────────────────────────────────────────────────────

  function handleMessage(data: Record<string, unknown>): void {
    const type = data.type as string;

    // Response to pending request
    if (type === "res") {
      const id = data.id as string;
      const pending = pendingRequests.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        pendingRequests.delete(id);
        pending.resolve(data);
        return;
      }
    }

    // Pong — swallow
    if (type === "pong") return;

    // Gateway error
    if (type === "error") {
      console.error("Gateway error:", data.message);
      return;
    }

    // Session events — unwrap and distribute to streams + handlers
    if (type === "event") {
      const eventData = unwrapEventMessage(data) as TransportEventData;

      for (const [, stream] of sendStreams) {
        if (!stream.closed) {
          const resolver = stream.resolvers.shift();
          if (resolver) {
            resolver({ value: eventData, done: false });
          } else {
            stream.events.push(eventData);
          }
        }
      }

      dispatchEvent(eventData);
      return;
    }

    // All other messages — forward to event handlers
    dispatchEvent(data as TransportEventData);
  }

  function dispatchEvent(event: TransportEventData): void {
    for (const handler of eventHandlers) {
      try {
        handler(event);
      } catch (error) {
        console.error("Error in event handler:", error);
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Connection lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  function handleClose(): void {
    const wasConnected = state === "connected";
    connectionId = undefined;
    connection = null;
    subscriptions.clear();
    setState("disconnected");

    // Attempt reconnection
    const reconnect = config.reconnect;
    if (wasConnected && reconnect?.enabled !== false) {
      const maxAttempts = reconnect?.maxAttempts ?? 5;
      const delay = reconnect?.delay ?? 1000;

      if (reconnectAttempts < maxAttempts) {
        reconnectAttempts++;
        setTimeout(() => {
          transport.connect().catch((error) => {
            console.error("Reconnection failed:", error);
          });
        }, delay * reconnectAttempts);
      }
    }
  }

  function closeConnection(): void {
    // Clear pending requests
    for (const [, pending] of pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Connection closed"));
    }
    pendingRequests.clear();

    // Close send streams
    for (const [, stream] of sendStreams) {
      stream.closed = true;
      for (const resolver of stream.resolvers) {
        resolver({ value: undefined as unknown as TransportEventData, done: true });
      }
    }
    sendStreams.clear();

    connection?.close();
    connection = null;
    connectionId = undefined;
    subscriptions.clear();
    setState("disconnected");
  }

  async function openConnection(): Promise<void> {
    closeConnection();

    const handle = await delegate.open({
      onMessage: handleMessage,
      onClose: handleClose,
      onError: (error) => {
        console.error("Transport error:", error);
      },
    });

    connection = handle;

    // Send connect message
    const clientId = config.clientId ?? `client-${Date.now().toString(36)}`;
    handle.send({
      type: "connect",
      clientId,
      token: config.token,
    });
    connectionId = clientId;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Request/response
  // ──────────────────────────────────────────────────────────────────────────

  async function sendRequest(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    await transport.connect();

    const id = `req-${++requestCounter}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, requestTimeout);

      pendingRequests.set(id, { resolve, reject, timeout: timer });

      connection!.send({
        type: "req",
        id,
        method,
        params,
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Transport object
  // ──────────────────────────────────────────────────────────────────────────

  const transport: ClientTransport = {
    get state() {
      return state;
    },

    get connectionId() {
      return connectionId;
    },

    async connect() {
      if (state === "connected") return;
      if (connectionPromise) {
        await connectionPromise;
        return;
      }

      setState("connecting");
      connectionPromise = openConnection();

      try {
        await connectionPromise;
        setState("connected");
        reconnectAttempts = 0;
      } catch (error) {
        setState("error");
        throw error;
      } finally {
        connectionPromise = undefined;
      }
    },

    disconnect() {
      closeConnection();
    },

    send(input: SendInput, sessionId?: string) {
      const streamId = `stream-${++requestCounter}`;
      const stream: SendStream = {
        events: [],
        resolvers: [],
        closed: false,
      };
      sendStreams.set(streamId, stream);

      let aborted = false;
      let sessionIdFromResponse: string | undefined;

      // Start the send request
      const sendPromise = sendRequest("send", {
        sessionId: sessionId ?? "main",
        message: extractSendMessage(input),
      });

      sendPromise
        .then((response) => {
          if (response.ok && response.payload) {
            sessionIdFromResponse = (response.payload as { sessionId?: string }).sessionId;
          }
        })
        .catch((error) => {
          stream.closed = true;
          const errorEvent = { type: "error", error: error.message };
          const resolver = stream.resolvers.shift();
          if (resolver) {
            resolver({ value: errorEvent as TransportEventData, done: false });
          }
          for (const r of stream.resolvers) {
            r({ value: undefined as unknown as TransportEventData, done: true });
          }
          stream.resolvers = [];
        });

      const iterable = {
        async *[Symbol.asyncIterator](): AsyncIterator<TransportEventData> {
          try {
            while (!stream.closed && !aborted) {
              if (stream.events.length > 0) {
                const event = stream.events.shift()!;
                yield event;
                if (event.type === "execution_end" || event.type === "message_end") break;
                continue;
              }

              const result = await new Promise<IteratorResult<TransportEventData>>((resolve) => {
                stream.resolvers.push(resolve);
              });

              if (result.done) break;
              yield result.value;
              if (result.value.type === "execution_end" || result.value.type === "message_end") {
                break;
              }
            }
          } finally {
            stream.closed = true;
            sendStreams.delete(streamId);
          }
        },

        abort(reason?: string) {
          aborted = true;
          stream.closed = true;
          for (const resolver of stream.resolvers) {
            resolver({ value: undefined as unknown as TransportEventData, done: true });
          }
          stream.resolvers = [];
          if (sessionIdFromResponse) {
            transport.abortSession(sessionIdFromResponse, reason).catch(() => {});
          }
        },
      };

      return iterable;
    },

    async subscribeToSession(sessionId: string) {
      if (subscriptions.has(sessionId)) return;
      await sendRequest("subscribe", { sessionId });
      subscriptions.add(sessionId);
    },

    async unsubscribeFromSession(sessionId: string) {
      if (!subscriptions.has(sessionId)) return;
      await sendRequest("unsubscribe", { sessionId });
      subscriptions.delete(sessionId);
    },

    async abortSession(sessionId: string, reason?: string) {
      await sendRequest("abort", { sessionId, reason });
    },

    async closeSession(sessionId: string) {
      await sendRequest("close", { sessionId });
      subscriptions.delete(sessionId);
    },

    async submitToolResult(sessionId: string, toolUseId: string, result: ToolConfirmationResponse) {
      await sendRequest("tool-response", { sessionId, toolUseId, result });
    },

    async publishToChannel(sessionId: string, channel: string, event: ChannelEvent) {
      await sendRequest("channel", {
        sessionId,
        channel,
        type: event.type,
        payload: event.payload,
        id: event.id,
        metadata: event.metadata,
      });
    },

    async subscribeToChannel(sessionId: string, channel: string) {
      await sendRequest("channel-subscribe", { sessionId, channel });
    },

    onEvent(handler: TransportEventHandler) {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },

    onStateChange(handler: (state: TransportState) => void) {
      stateHandlers.add(handler);
      return () => {
        stateHandlers.delete(handler);
      };
    },
  };

  return transport;
}
