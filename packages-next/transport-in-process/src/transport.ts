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
  ClientConnection,
  ClientTransport,
  JsonRpcFrame,
  JsonRpcRequest,
  JsonRpcResponse,
  TransportCapabilities,
} from "@agentick/spec-next";
import { BaseClientTransport } from "@agentick/transport-next";
import { ulid } from "@agentick/utils-next";

export type InProcessGatewayHandler = (
  request: JsonRpcRequest,
  sendNotification: (notification: { method: string; params?: unknown }) => void,
) => Promise<JsonRpcResponse>;

/**
 * Callback the transport hands to the server side on `connect()`,
 * enabling out-of-band notification pushes (server → client).
 *
 * The transport calls this once during `openConnection`, passing a
 * `deliver` callback the server can invoke while the connection is
 * open. Whatever the caller returns is treated as an unsubscribe,
 * invoked during `closeConnection`.
 *
 * Test / stub usage — capture `deliver` directly and push:
 *
 * ```ts
 * let push: (n: { method: string; params?: unknown }) => void = () => {};
 * inProcessTransport({
 *   handler,
 *   serverNotifier: (deliver) => { push = deliver; return () => { push = () => {}; }; },
 * });
 * // later: push({ method: "notifications/whatever", params: {} });
 * ```
 *
 * For the common case of pushing from a real gateway, pass the
 * gateway directly instead — the transport structurally detects
 * `acceptConnection` and wires it. See {@link InProcessTransportOptions}.
 */
export type InProcessServerNotifierFn = (
  deliver: (notification: { method: string; params?: unknown }) => void,
) => () => void;

/**
 * Anything the transport can call `acceptConnection` on — every
 * `@agentick/gateway-next` instance satisfies this. Enables the
 * zero-boilerplate shortcut:
 *
 * ```ts
 * inProcessTransport({ handler, serverNotifier: gateway })
 * ```
 */
export interface AcceptingServer {
  acceptConnection(connection: ClientConnection): () => void;
}

/**
 * Server-side notification wiring. Either a raw callback (full
 * control over metadata + registration mechanism) or an object
 * with `acceptConnection` (typically a `GatewayHarness`; transport
 * generates default metadata + connectionId).
 */
export type InProcessServerNotifier = InProcessServerNotifierFn | AcceptingServer;

export interface InProcessTransportOptions {
  readonly handler: InProcessGatewayHandler;
  readonly wireParity?: boolean;
  readonly id?: string;
  /**
   * Optional server-side notification wiring (#311). Pass a
   * `GatewayHarness` directly for the common case; pass a function
   * for full control over metadata or when wiring a non-gateway
   * server. When omitted, no server→client push channel is
   * installed — safe for tests that don't exercise the path.
   */
  readonly serverNotifier?: InProcessServerNotifier;
}

const CAPABILITIES: TransportCapabilities = {
  bidirectional: true,
  streamingRequest: true,
  reconnectable: false,
  binaryFrames: true,
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
  private readonly serverNotifier: InProcessServerNotifier | undefined;
  private unregisterServerNotifier: (() => void) | null = null;

  constructor(options: InProcessTransportOptions) {
    super();
    this.id = options.id ?? `in-process-${++transportCounter}`;
    this.handler = options.handler;
    this.wireParity = options.wireParity ?? false;
    this.serverNotifier = options.serverNotifier;
  }

  protected async openConnection(): Promise<void> {
    this.setState("connecting");
    // Install the server-side notification path BEFORE the state
    // flips open — a notification fired during the ensuing handshake
    // must reach us.
    if (this.serverNotifier) {
      const notifierFn = normalizeServerNotifier(this.serverNotifier, this.id);
      this.unregisterServerNotifier = notifierFn((notification) => {
        const noteFrame = this.maybeRoundtrip({
          jsonrpc: "2.0" as const,
          method: notification.method,
          params: notification.params,
        });
        this.routeFrame(noteFrame as JsonRpcFrame);
      });
    }
    this.setState("open");
  }

  protected async closeConnection(): Promise<void> {
    if (this.unregisterServerNotifier) {
      this.unregisterServerNotifier();
      this.unregisterServerNotifier = null;
    }
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

/**
 * Normalize the union {@link InProcessServerNotifier} to a function.
 * When adopters pass a gateway-shaped object, wrap it into a
 * function that calls `acceptConnection` with default metadata.
 */
function normalizeServerNotifier(
  notifier: InProcessServerNotifier,
  transportId: string,
): InProcessServerNotifierFn {
  if (typeof notifier === "function") return notifier;
  return (deliver) =>
    notifier.acceptConnection({
      metadata: {
        transport: "in-process",
        connectionId: `inproc:${transportId}:${ulid()}`,
      },
      deliver: (n) => deliver({ method: n.method, params: n.params }),
    });
}
