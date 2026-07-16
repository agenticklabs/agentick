/**
 * In-process `ClientTransport` implementation.
 *
 * Subclasses `BaseClientTransport` from `@agentick/transport-next`;
 * supplies a synchronous handler that delivers JSON-RPC requests to a
 * server-side function and routes the response (and any notifications
 * the handler emits) back through the base class.
 *
 * Optional `wireParity: true` test mode routes frame payloads through
 * `JSON.parse(JSON.stringify(...))` to catch wire-shape regressions
 * without paying the cost in production.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type {
  ClientTransport,
  JsonRpcFrame,
  JsonRpcRequest,
  JsonRpcResponse,
  TransportCapabilities,
} from "@agentick/spec-next";
import {
  BaseClientTransport,
  dispatchRequest,
  type DispatchHost,
  type DispatchSink,
} from "@agentick/transport-next";

export type InProcessGatewayHandler = (
  request: JsonRpcRequest,
  sendNotification: (notification: { method: string; params?: unknown }) => void,
) => Promise<JsonRpcResponse>;

export interface InProcessTransportOptions {
  /**
   * The gateway to dispatch to — the common case. The transport builds the
   * `DispatchSink` + `dispatchRequest` wiring internally, so you never touch
   * the server plumbing: `inProcessTransport({ gateway })`.
   */
  readonly gateway?: DispatchHost;
  /**
   * A raw request handler — the escape hatch for custom dispatch (a stub
   * server, request interception, a non-gateway host). Provide this OR
   * `gateway`, not both.
   */
  readonly handler?: InProcessGatewayHandler;
  readonly wireParity?: boolean;
  readonly id?: string;
}

/** Build the handler that dispatches to a gateway — the sink is boilerplate. */
function gatewayHandler(gateway: DispatchHost): InProcessGatewayHandler {
  return async (request, sendNotification) => {
    // Fresh sink per request: its `sendNotification` is THIS frame's
    // notification route (a shared one drops subscription events).
    const sink: DispatchSink = {
      sendNotification,
      registerSubscription: () => {},
      unregisterSubscription: () => {},
      registerInFlight: () => {},
      unregisterInFlight: () => {},
    };
    return dispatchRequest(gateway, request, sink);
  };
}

const CAPABILITIES: TransportCapabilities = {
  bidirectional: true,
  streamingRequest: true,
  reconnectable: false,
  binaryFrames: true,
  media: false,
};

let transportCounter = 0;

export function inProcessTransport(options: InProcessTransportOptions): ClientTransport {
  return new InProcessTransport(options);
}

class InProcessTransport extends BaseClientTransport {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private readonly handler: InProcessGatewayHandler;
  private readonly wireParity: boolean;

  constructor(options: InProcessTransportOptions) {
    super();
    this.id = options.id ?? `in-process-${++transportCounter}`;
    if (options.handler && options.gateway) {
      throw new Error("inProcessTransport: provide `gateway` OR `handler`, not both");
    }
    const handler = options.handler ?? (options.gateway && gatewayHandler(options.gateway));
    if (!handler) throw new Error("inProcessTransport: provide `gateway` or `handler`");
    this.handler = handler;
    this.wireParity = options.wireParity ?? false;
  }

  protected async openConnection(): Promise<void> {
    this.setState("connecting");
    this.setState("open");
  }

  protected async closeConnection(): Promise<void> {
    /* nothing to tear down for in-process */
  }

  protected async sendFrame(frame: JsonRpcFrame): Promise<void> {
    // Only requests get handler-roundtripped; notifications from the
    // client (e.g., notifications/cancelled) have no in-process effect
    // until per-handler cancellation is wired (deferred).
    if (!("id" in frame) || !("method" in frame)) return;

    const request = this.maybeRoundtrip(frame as JsonRpcRequest);
    const response = await this.handler(request, (notification) => {
      // Server-emitted notifications (progress / subscription event /
      // closed / evicted) — route them through the base class.
      const noteFrame = this.maybeRoundtrip({
        jsonrpc: "2.0" as const,
        method: notification.method,
        params: notification.params,
      });
      this.routeFrame(noteFrame as JsonRpcFrame);
    });

    this.routeFrame(this.maybeRoundtrip(response) as JsonRpcFrame);
  }

  private maybeRoundtrip<T>(value: T): T {
    if (!this.wireParity) return value;
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
