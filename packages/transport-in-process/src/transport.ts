/**
 * In-process `ClientTransport` implementation.
 *
 * Subclasses `BaseClientTransport` from `@agentick/transport`;
 * supplies a synchronous handler that delivers JSON-RPC requests to a
 * server-side function and routes the response (and any notifications
 * the handler emits) back through the base class.
 *
 * On the `gateway` path the server side is a real
 * {@link BaseConnectionContext} — the same per-connection adapter the socket
 * transports use. That is what makes this transport behave like a wire rather
 * than like a function call: id-less frames (`notifications/cancelled`) reach
 * the in-flight registry, and subscriptions registered during a dispatch are
 * released when the client closes. The `handler` escape hatch keeps its
 * request-only shape, with `onNotification` as its opt-in notification route.
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
  MediaDownlink,
  MediaSessionRef,
  MediaTransport,
  MediaUplink,
  TransportCapabilities,
} from "@agentick/spec";
import { BaseClientTransport, BaseConnectionContext, type DispatchHost } from "@agentick/transport";

export type InProcessGatewayHandler = (
  request: JsonRpcRequest,
  sendNotification: (notification: { method: string; params?: unknown }) => void,
) => Promise<JsonRpcResponse>;

/**
 * Server-side route for a client-originated NOTIFICATION (an id-less frame) —
 * in practice `notifications/cancelled`, which every aborted request emits.
 *
 * Only the `handler` path needs this: on the `gateway` path the connection
 * context routes cancellations into its own in-flight registry, exactly as the
 * socket transports do.
 */
export type InProcessNotificationHandler = (notification: {
  method: string;
  params?: unknown;
}) => void;

export interface InProcessTransportOptions {
  /**
   * The gateway to dispatch to — the common case. The transport builds the
   * server-side connection context internally, so you never touch the server
   * plumbing: `inProcessTransport({ gateway })`.
   */
  readonly gateway?: DispatchHost;
  /**
   * A raw request handler — the escape hatch for custom dispatch (a stub
   * server, request interception, a non-gateway host). Provide this OR
   * `gateway`, not both.
   */
  readonly handler?: InProcessGatewayHandler;
  /**
   * Where client-originated notifications go on the `handler` path. Omitted,
   * they are dropped — a stub server that models no cancellation has nothing to
   * tell. IGNORED on the `gateway` path, which routes them through the
   * connection's in-flight registry.
   */
  readonly onNotification?: InProcessNotificationHandler;
  readonly wireParity?: boolean;
  readonly id?: string;
  /**
   * Optional media-plane implementation (ADR 88). When provided, the transport
   * advertises `capabilities.media = true` and delegates `openUplink` /
   * `openDownlink` to it — the control transport stays generic and knows nothing
   * about `live`; the live-aware in-process router (`inProcessLiveMedia` from
   * `@agentick/live`) is what wires frames to the session's `LiveHarness`.
   */
  readonly media?: MediaTransport;
}

/**
 * How an outbound frame reaches the server side. Two shapes: a real connection
 * context over a gateway, or the adopter's raw handler.
 */
interface ServerRoute {
  /** Deliver one inbound frame; resolves with a response for requests. */
  deliver(frame: JsonRpcFrame): Promise<JsonRpcResponse | null>;
  /** Release whatever the server side holds for this connection. */
  close(): Promise<void>;
}

/**
 * The server-side half of an in-process pair: a `BaseConnectionContext` whose
 * "wire" is a callback into the client's frame router. Inherits the shared
 * dispatch path — `notifications/cancelled` → in-flight abort, subscription and
 * in-flight registries, connect-time scope narrowing, and teardown that runs
 * every registered cleanup.
 */
class InProcessConnection extends BaseConnectionContext implements ServerRoute {
  constructor(
    gateway: DispatchHost,
    private readonly toClient: (frame: JsonRpcFrame) => void,
  ) {
    super(gateway);
  }

  deliver(frame: JsonRpcFrame): Promise<JsonRpcResponse | null> {
    return this.dispatchInbound(frame);
  }

  protected sendFrame(frame: JsonRpcFrame): void {
    this.toClient(frame);
  }

  protected closeWire(): void {
    /* no wire to tear down — the pair is two objects in one process */
  }
}

/** The raw-handler route: requests to the handler, notifications to `onNotification`. */
class HandlerRoute implements ServerRoute {
  constructor(
    private readonly handler: InProcessGatewayHandler,
    private readonly toClient: (frame: JsonRpcFrame) => void,
    private readonly onNotification?: InProcessNotificationHandler,
  ) {}

  async deliver(frame: JsonRpcFrame): Promise<JsonRpcResponse | null> {
    if (!("id" in frame)) {
      // A stub server models whatever it wants to model; absent a route the
      // frame is dropped, which is the honest behavior for a handler that
      // declared no interest in cancellation.
      this.onNotification?.(frame as { method: string; params?: unknown });
      return null;
    }
    return this.handler(frame as JsonRpcRequest, (notification) =>
      this.toClient({
        jsonrpc: "2.0",
        method: notification.method,
        params: notification.params,
      }),
    );
  }

  async close(): Promise<void> {
    /* the adopter owns whatever their handler holds */
  }
}

let transportCounter = 0;

export function inProcessTransport(options: InProcessTransportOptions): ClientTransport {
  return new InProcessTransport(options);
}

class InProcessTransport extends BaseClientTransport implements MediaTransport {
  readonly id: string;
  readonly capabilities: TransportCapabilities;

  private readonly gateway?: DispatchHost;
  private readonly handler?: InProcessGatewayHandler;
  private readonly onNotification?: InProcessNotificationHandler;
  private readonly wireParity: boolean;
  private readonly media?: MediaTransport;
  /** The server side of the pair. Built at connect, released at close. */
  private route: ServerRoute | null = null;

  constructor(options: InProcessTransportOptions) {
    super();
    this.id = options.id ?? `in-process-${++transportCounter}`;
    if (options.handler && options.gateway) {
      throw new Error("inProcessTransport: provide `gateway` OR `handler`, not both");
    }
    if (!options.handler && !options.gateway) {
      throw new Error("inProcessTransport: provide `gateway` or `handler`");
    }
    this.gateway = options.gateway;
    this.handler = options.handler;
    this.onNotification = options.onNotification;
    this.wireParity = options.wireParity ?? false;
    this.media = options.media;
    this.capabilities = {
      bidirectional: true,
      streamingRequest: true,
      reconnectable: false,
      // Parity mode routes every frame through JSON, which a `Uint8Array` does
      // not survive — so in that mode this transport genuinely cannot carry
      // binary frames, and says so. Default mode passes references and can.
      binaryFrames: !this.wireParity,
      media: options.media !== undefined,
    };
  }

  // ─── MediaTransport (ADR 88) — delegates to the injected media impl ───

  openUplink(ref: MediaSessionRef): MediaUplink {
    return this.requireMedia().openUplink(ref);
  }

  openDownlink(ref: MediaSessionRef): MediaDownlink {
    return this.requireMedia().openDownlink(ref);
  }

  private requireMedia(): MediaTransport {
    if (!this.media) {
      throw new Error(
        "inProcessTransport: no media capability — pass `media` (e.g. inProcessLiveMedia(gateway)) to open a media plane.",
      );
    }
    return this.media;
  }

  protected async openConnection(): Promise<void> {
    this.setState("connecting");
    const toClient = (frame: JsonRpcFrame): void => {
      this.routeFrame(this.maybeRoundtrip(frame));
    };
    this.route = this.gateway
      ? new InProcessConnection(this.gateway, toClient)
      : new HandlerRoute(this.handler!, toClient, this.onNotification);
    this.setState("open");
  }

  protected async closeConnection(): Promise<void> {
    // Releases the connection's subscriptions (running each registered cleanup)
    // and aborts anything still in flight — the same teardown a dropped socket
    // performs. Without it, a server-side drain loop outlives its client.
    const route = this.route;
    this.route = null;
    await route?.close();
  }

  protected async sendFrame(frame: JsonRpcFrame): Promise<void> {
    const route = this.route;
    if (!route) return;
    // Responses never originate client-side; anything without a method is not
    // ours to deliver.
    if (!("method" in frame)) return;

    const response = await route.deliver(this.maybeRoundtrip(frame));
    // Notifications answer with null — nothing to route back.
    if (response !== null) this.routeFrame(this.maybeRoundtrip(response) as JsonRpcFrame);
  }

  private maybeRoundtrip<T>(value: T): T {
    if (!this.wireParity) return value;
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
