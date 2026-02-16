/**
 * Local Transport
 *
 * Bridges an in-process App to the ClientTransport interface.
 * Enables @agentick/client (and by extension @agentick/react hooks)
 * to work with a local App without any network layer.
 *
 * @module @agentick/core/local-transport
 */

import type {
  ClientTransport,
  TransportState,
  TransportEventData,
  TransportEventHandler,
  SendInput,
  ChannelEvent,
  ToolConfirmationResponse,
} from "@agentick/shared";
import type { App } from "./app/types";

/**
 * Create a ClientTransport that bridges to an in-process App.
 *
 * The transport is always "connected" — there's no network.
 * send() delegates to app.send() and pipes SessionExecutionHandle
 * events as TransportEventData.
 *
 * @example
 * ```typescript
 * import { createApp } from '@agentick/core';
 * import { createLocalTransport } from '@agentick/core';
 * import { createClient } from '@agentick/client';
 *
 * const app = createApp(MyAgent, { model });
 * const transport = createLocalTransport(app);
 * const client = createClient({ baseUrl: 'local://', transport });
 * ```
 */
export function createLocalTransport(app: App): ClientTransport {
  let _state: TransportState = "disconnected";
  const _eventHandlers = new Set<TransportEventHandler>();
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
      return "local";
    },

    async connect() {
      setState("connected");
    },

    disconnect() {
      setState("disconnected");
    },

    send(input: SendInput, sessionId?: string) {
      const sid = sessionId ?? "main";
      const ac = new AbortController();

      const iterable = (async function* (): AsyncGenerator<TransportEventData> {
        const handle = await app.send(input, { sessionId: sid });

        // If abort was called before send() resolved, abort immediately
        if (ac.signal.aborted) {
          handle.abort(ac.signal.reason);
          return;
        }

        // Wire up future abort calls to the handle
        ac.signal.addEventListener("abort", () => {
          handle.abort(ac.signal.reason);
        });

        // Stream all events from the handle.
        // Session already emits execution_start, result, execution_end —
        // no synthetic events needed. The client dispatches each yielded
        // event via handleIncomingEvent, so we must NOT also call
        // emitToHandlers here (that would double-dispatch).
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

    async subscribeToSession(_sessionId: string) {
      // No-op for local transport — events flow directly
    },

    async unsubscribeFromSession(_sessionId: string) {
      // No-op for local transport
    },

    async abortSession(sessionId: string, reason?: string) {
      const session = await app.session(sessionId);
      session.interrupt(undefined, reason);
    },

    async closeSession(sessionId: string) {
      await app.close(sessionId);
    },

    async submitToolResult(sessionId: string, toolUseId: string, result: ToolConfirmationResponse) {
      const session = await app.session(sessionId);
      session.submitToolResult(toolUseId, result);
    },

    async publishToChannel(sessionId: string, channel: string, event: ChannelEvent) {
      const session = await app.session(sessionId);
      session.channel(channel).publish(event);
    },

    async subscribeToChannel(_sessionId: string, _channel: string) {
      // No-op for local transport — channels are in-process
    },

    async dispatchCommand(sessionId: string, name: string, input: Record<string, unknown>) {
      const session = await app.session(sessionId);
      return session.dispatchCommand(name, input);
    },

    onEvent(handler: TransportEventHandler) {
      _eventHandlers.add(handler);
      return () => {
        _eventHandlers.delete(handler);
      };
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
