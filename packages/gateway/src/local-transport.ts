/**
 * Local Gateway Transport
 *
 * Bridges in-process clients to the gateway's transport system.
 * Local clients appear in sendEventToSubscribers iteration alongside
 * WS/HTTP clients, enabling cross-client event broadcasting.
 *
 * Two layers:
 * - Server-side: LocalGatewayTransport (extends BaseTransport) — the gateway
 *   tracks local clients and pushes events to them.
 * - Client-side: ClientTransport (returned by createClientTransport) — what
 *   createClient() consumes.
 *
 * @module @agentick/gateway/local-transport
 */

import type {
  ClientTransport,
  TransportState,
  TransportEventData,
  TransportEventHandler,
  SendInput,
  ChannelEvent,
  ToolConfirmationResponse,
  ContentBlock,
} from "@agentick/shared";
import { BaseTransport, type TransportClient } from "./transport.js";
import type { GatewayMessage, EventMessage } from "./transport-protocol.js";
import type { ClientState } from "./types.js";
import type { Gateway } from "./gateway.js";

// ============================================================================
// Local Transport Client (server-side)
// ============================================================================

/**
 * A local in-process client from the gateway's perspective.
 * Implements TransportClient so it participates in sendToSubscribers.
 */
class LocalTransportClient implements TransportClient {
  readonly id: string;
  readonly state: ClientState;
  private _connected = true;
  private _eventHandlers = new Set<TransportEventHandler>();
  private _onClose: (() => void) | null = null;

  constructor(id: string) {
    this.id = id;
    this.state = {
      id,
      connectedAt: new Date(),
      authenticated: true,
      subscriptions: new Set(),
    };
  }

  get isConnected(): boolean {
    return this._connected;
  }

  isPressured(): boolean {
    return false;
  }

  /**
   * Called by the gateway when pushing events to subscribers.
   * Converts EventMessage → TransportEventData and fires handlers.
   */
  send(message: GatewayMessage): void {
    if (!this._connected) return;

    // Only forward event messages to the ClientTransport handlers.
    // Other message types (res, connected, pong, error) are protocol-level
    // and don't apply to local clients.
    if (message.type !== "event") return;

    const event = message as EventMessage;
    const transportEvent: TransportEventData = {
      type: event.event,
      sessionId: event.sessionId,
      ...(event.data && typeof event.data === "object" ? (event.data as object) : {}),
    };

    for (const handler of this._eventHandlers) {
      handler(transportEvent);
    }
  }

  close(): void {
    this._connected = false;
    this._eventHandlers.clear();
    this._onClose?.();
    this._onClose = null;
  }

  onEvent(handler: TransportEventHandler): () => void {
    this._eventHandlers.add(handler);
    return () => {
      this._eventHandlers.delete(handler);
    };
  }

  setOnClose(handler: () => void): void {
    this._onClose = handler;
  }
}

// ============================================================================
// Local Gateway Transport (server-side)
// ============================================================================

/**
 * Server-side transport that manages local in-process clients.
 * Registered with the gateway so local clients participate in
 * event broadcasting via sendToSubscribers.
 */
export class LocalGatewayTransport extends BaseTransport {
  readonly type = "local" as const;

  constructor() {
    super();
  }

  async start(): Promise<void> {
    // No-op: no network to start
  }

  async stop(): Promise<void> {
    // Disconnect all local clients
    for (const client of this.clients.values()) {
      client.close();
    }
    this.clients.clear();
  }

  /**
   * Create a new local client and return a ClientTransport for use
   * with createClient().
   */
  createClientTransport(gateway: Gateway): ClientTransport {
    const clientId = this.generateClientId();
    const client = new LocalTransportClient(clientId);

    // Register in BaseTransport's client map
    this.clients.set(clientId, client);

    // Emit connection event so gateway's setupTransportHandlers tracks it
    this.handlers.connection?.(client);

    // Wire up disconnect: when client closes, notify gateway
    client.setOnClose(() => {
      this.clients.delete(clientId);
      this.handlers.disconnect?.(clientId, "local client disconnected");
    });

    return createLocalClientTransport(client, gateway);
  }
}

// ============================================================================
// Client-side Transport (returned to createClient)
// ============================================================================

/**
 * Create a ClientTransport that wraps a LocalTransportClient and
 * delegates to the gateway's session management.
 *
 * Follows the same pattern as createLocalTransport(app) in @agentick/core
 * but routes through the gateway's multi-app session management.
 */
function createLocalClientTransport(
  client: LocalTransportClient,
  gateway: Gateway,
): ClientTransport {
  let _state: TransportState = "disconnected";
  const _stateChangeHandlers = new Set<(state: TransportState) => void>();

  function setState(newState: TransportState): void {
    _state = newState;
    for (const handler of _stateChangeHandlers) {
      handler(newState);
    }
  }

  const transport: ClientTransport = {
    get state() {
      return _state;
    },

    get connectionId() {
      return client.id;
    },

    async connect() {
      setState("connected");
    },

    disconnect() {
      setState("disconnected");
      client.close();
    },

    send(input: SendInput, sessionId?: string) {
      const sid = sessionId ?? "main";
      const ac = new AbortController();

      const iterable = (async function* (): AsyncGenerator<TransportEventData> {
        // Auto-subscribe so push events from other clients reach us
        await gateway.subscribe(sid, client.id);
        client.state.subscriptions.add(sid);

        // Use gateway.sendToSession() so events are broadcast to
        // other subscribers (cross-client push). Pass our client ID
        // to exclude ourselves from broadcast — we get events through
        // direct handle iteration instead.
        const handle = await gateway.sendToSession(sid, input, client.id);

        // If abort was called before send() resolved, abort immediately
        if (ac.signal.aborted) {
          handle.abort(ac.signal.reason);
          return;
        }

        // Wire up future abort calls to the handle
        ac.signal.addEventListener("abort", () => {
          handle.abort(ac.signal.reason);
        });

        // Stream all events from the handle directly.
        // These are the "direct" events for the caller's iteration.
        // Push events from other clients go through client.onEvent handlers
        // via sendEventToSubscribers in gateway.sendToSession().
        for await (const event of handle) {
          yield { ...event, sessionId: sid } as TransportEventData;
        }
      })();

      return Object.assign(iterable, {
        abort(reason?: string) {
          ac.abort(reason);
        },
      });
    },

    async subscribeToSession(sessionId: string) {
      await gateway.subscribe(sessionId, client.id);
      client.state.subscriptions.add(sessionId);
    },

    async unsubscribeFromSession(sessionId: string) {
      gateway.unsubscribe(sessionId, client.id);
      client.state.subscriptions.delete(sessionId);
    },

    async abortSession(sessionId: string, reason?: string) {
      const session = await gateway.session(sessionId);
      session.interrupt(undefined, reason);
    },

    async closeSession(sessionId: string) {
      await gateway.closeSession(sessionId);
    },

    async submitToolResult(sessionId: string, toolUseId: string, result: ToolConfirmationResponse) {
      const session = await gateway.session(sessionId);
      session.submitToolResult(toolUseId, result);
    },

    async publishToChannel(sessionId: string, channel: string, event: ChannelEvent) {
      const session = await gateway.session(sessionId);
      session.channel(channel).publish(event);
    },

    async subscribeToChannel(_sessionId: string, _channel: string) {
      // No-op for local transport — channels are in-process
    },

    async dispatch(
      sessionId: string,
      name: string,
      input: Record<string, unknown>,
    ): Promise<ContentBlock[]> {
      const session = await gateway.session(sessionId);
      return session.dispatch(name, input);
    },

    onEvent(handler: TransportEventHandler) {
      return client.onEvent(handler);
    },

    onStateChange(handler: (state: TransportState) => void) {
      _stateChangeHandlers.add(handler);
      return () => {
        _stateChangeHandlers.delete(handler);
      };
    },
  };

  return transport;
}
