/**
 * In-process `ClientTransport` implementation.
 *
 * The transport receives a `InProcessGatewayHandler` — the server-side
 * function that handles JSON-RPC frames. In practice the handler is
 * supplied by a gateway-side adapter that translates frames into
 * `GatewayHarness` method calls.
 *
 * This file ships the client side ONLY. The matching server-side
 * adapter lives next to `GatewayHarness` (or in a future
 * `@agentick/gateway-next/transport-host`) — for the MVP smoke test,
 * adopters write their own handler closure that wraps a
 * `GatewayHarness` instance.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type {
  ClientState,
  ClientTransport,
  Cursor,
  EventFrame,
  EventQuery,
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcResponse,
  ProgressStream,
  SubscriptionScope,
  SubscriptionStream,
  TransportCapabilities,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec-next";

/**
 * Server-side handler the transport calls. Receives a JSON-RPC request
 * frame; returns the matching response. The handler also receives a
 * callback for sending notifications back to the client (progress,
 * subscription events, etc.).
 */
export type InProcessGatewayHandler = (
  request: JsonRpcRequest,
  sendNotification: (notification: { method: string; params?: unknown }) => void,
) => Promise<JsonRpcResponse>;

export interface InProcessTransportOptions {
  readonly handler: InProcessGatewayHandler;
  /** When true, frames pass through JSON serialization to catch wire-shape bugs. */
  readonly wireParity?: boolean;
  readonly id?: string;
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

class InProcessTransport implements ClientTransport {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private readonly handler: InProcessGatewayHandler;
  private readonly wireParity: boolean;
  private readonly stateListeners = new Set<(s: ClientState) => void>();

  private currentState: ClientState = "idle";

  // Subscription / progress streams currently open, keyed by their token.
  private readonly subscriptionStreams = new Map<string, InProcessStream<EventFrame>>();
  private readonly progressStreams = new Map<string, InProcessStream<EventFrame>>();

  private nextRequestId = 1;

  constructor(options: InProcessTransportOptions) {
    this.id = options.id ?? `in-process-${++transportCounter}`;
    this.handler = options.handler;
    this.wireParity = options.wireParity ?? false;
  }

  get state(): ClientState {
    return this.currentState;
  }

  async connect(): Promise<void> {
    this.setState("connecting");
    this.setState("open");
  }

  async close(): Promise<void> {
    for (const stream of this.subscriptionStreams.values()) await stream.end(null);
    for (const stream of this.progressStreams.values()) await stream.end(null);
    this.subscriptionStreams.clear();
    this.progressStreams.clear();
    this.setState("closed");
  }

  onStateChange(handler: (state: ClientState) => void): () => void {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  }

  async request<M extends WireMethod>(
    method: M,
    params: WireParams<M>,
    signal?: AbortSignal,
  ): Promise<WireResult<M>> {
    if (this.currentState !== "open") {
      throw makeError("connection", `transport ${this.id} is not open`);
    }
    if (signal?.aborted) {
      throw makeError("cancelled", "aborted before send");
    }

    const id = this.nextRequestId++ as JsonRpcId;
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id,
      method,
      params: params as unknown,
    };

    const response = await this.handler(
      this.maybeRoundtrip(request) as JsonRpcRequest,
      (notification) => this.routeNotification(notification),
    );

    const decoded = this.maybeRoundtrip(response) as JsonRpcResponse;
    if ("error" in decoded && decoded.error) {
      throw {
        kind: "rpc" as const,
        error: decoded.error,
      };
    }
    if ("result" in decoded) {
      return decoded.result as WireResult<M>;
    }
    throw makeError("protocol", "response carried neither result nor error");
  }

  subscribe(scope: SubscriptionScope, query?: EventQuery, fromCursor?: Cursor): SubscriptionStream {
    const subscriptionId = `sub-${this.id}-${this.nextRequestId++}`;
    const stream = new InProcessStream<EventFrame>(subscriptionId, async () => {
      this.subscriptionStreams.delete(subscriptionId);
      try {
        await this.request("unsubscribe", { subscriptionId });
      } catch {
        /* swallow — transport may be closing */
      }
    });
    this.subscriptionStreams.set(subscriptionId, stream);

    // Fire-and-forget subscribe RPC. The handler emits notifications via
    // `sendNotification`, which routes here through `routeNotification`.
    void this.request("subscribe", { scope, query, fromCursor }).then((res) => {
      // Server replies with its own server-allocated subscriptionId; we
      // re-key the stream so notifications route by that id.
      if (res && typeof res === "object" && "subscriptionId" in res) {
        const serverId = (res as { subscriptionId: string }).subscriptionId;
        if (serverId !== subscriptionId) {
          this.subscriptionStreams.delete(subscriptionId);
          stream.rekey(serverId);
          this.subscriptionStreams.set(serverId, stream);
        }
      }
    });

    return Object.assign(stream, { subscriptionId });
  }

  progress(progressToken: string): ProgressStream {
    const stream = new InProcessStream<EventFrame>(progressToken, async () => {
      this.progressStreams.delete(progressToken);
    });
    this.progressStreams.set(progressToken, stream);
    return Object.assign(stream, { progressToken });
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private setState(s: ClientState): void {
    this.currentState = s;
    for (const l of this.stateListeners) l(s);
  }

  private routeNotification(notification: { method: string; params?: unknown }): void {
    const params = notification.params as Record<string, unknown> | undefined;
    if (!params) return;

    switch (notification.method) {
      case "notifications/progress": {
        const token = params.progressToken as string | undefined;
        if (!token) return;
        const stream = this.progressStreams.get(token);
        if (!stream) return;
        const frame = {
          cursor: params.cursor as Cursor,
          envelope: params.envelope as EventFrame["envelope"],
        };
        void stream.push(this.maybeRoundtrip(frame) as EventFrame);
        return;
      }
      case "notifications/subscription/event": {
        const subId = params.subscriptionId as string | undefined;
        if (!subId) return;
        const stream = this.subscriptionStreams.get(subId);
        if (!stream) return;
        const frame = {
          cursor: params.cursor as Cursor,
          envelope: params.envelope as EventFrame["envelope"],
        };
        void stream.push(this.maybeRoundtrip(frame) as EventFrame);
        return;
      }
      case "notifications/subscription/closed": {
        const subId = params.subscriptionId as string | undefined;
        if (!subId) return;
        const stream = this.subscriptionStreams.get(subId);
        if (!stream) return;
        void stream.end(null);
        this.subscriptionStreams.delete(subId);
        return;
      }
      case "notifications/subscription/evicted": {
        const subId = params.subscriptionId as string | undefined;
        if (!subId) return;
        const stream = this.subscriptionStreams.get(subId);
        if (!stream) return;
        void stream.end({
          kind: "protocol",
          message: "cursor evicted",
          cause: params,
        });
        this.subscriptionStreams.delete(subId);
        return;
      }
      default:
        return;
    }
  }

  private maybeRoundtrip<T>(value: T): T {
    if (!this.wireParity) return value;
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

// ============================================================================
// InProcessStream — internal AsyncIterable with push/end controls
// ============================================================================

class InProcessStream<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private terminated = false;
  private error: unknown = null;

  constructor(
    public id: string,
    private readonly onClose: () => Promise<void>,
  ) {}

  rekey(newId: string): void {
    this.id = newId;
  }

  push(value: T): void {
    if (this.terminated) return;
    if (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  async end(error: unknown): Promise<void> {
    if (this.terminated) return;
    this.terminated = true;
    this.error = error;
    while (this.resolvers.length > 0) {
      this.resolvers.shift()!({ value: undefined as unknown as T, done: true });
    }
  }

  async close(): Promise<void> {
    if (this.terminated) return;
    await this.end(null);
    await this.onClose();
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.error !== null) {
          return Promise.reject(this.error);
        }
        if (this.buffer.length > 0) {
          return Promise.resolve({ value: this.buffer.shift()!, done: false });
        }
        if (this.terminated) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
      return: async () => {
        await this.close();
        return { value: undefined as unknown as T, done: true };
      },
    };
  }
}

function makeError(
  kind: "connection" | "timeout" | "cancelled" | "protocol" | "closed",
  message: string,
): { kind: typeof kind; message: string } {
  return { kind, message };
}
