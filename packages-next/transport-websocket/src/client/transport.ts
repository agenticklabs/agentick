/**
 * WebSocket `ClientTransport` implementation.
 *
 * Uses `globalThis.WebSocket` by default. Adopters needing `ws` (Node
 * 18/20, custom headers) pass a constructor via `options.WebSocket`.
 *
 * Frame multiplexing: a single connection carries N concurrent
 * RPC request/response pairs (correlated by JSON-RPC `id`) plus N
 * concurrent subscription / progress streams (correlated by
 * `subscriptionId` / `progressToken`). The "rooms" / multicast story
 * via one socket — same canonical pattern as Phoenix Channels / Slack
 * gateway, no Socket.IO needed.
 *
 * Reconnect: exponential backoff with full jitter (per AWS Builder's
 * Library; capped at 30s). On reconnect, every still-open subscription
 * re-subscribes with its last-seen cursor. Subscriptions whose
 * cursors have evicted surface `notifications/subscription/evicted`
 * — adopters choose policy.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type {
  ClientState,
  ClientTransport,
  Cursor,
  EventFrame,
  EventQuery,
  JsonRpcFrame,
  JsonRpcId,
  JsonRpcResponse,
  ProgressStream,
  SubscriptionScope,
  SubscriptionStream,
  TransportCapabilities,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec-next";
import { AGENTICK_SUBPROTOCOL, decodeFrame, encodeFrame } from "../shared/codec.js";

// ── WebSocket constructor type — matches both browser native and `ws` ─────

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  addEventListener(type: "close", listener: (ev: { code: number; reason: string }) => void): void;
  removeEventListener?: (...args: unknown[]) => void;
};

type WebSocketConstructor = new (
  url: string,
  protocols?: string | readonly string[],
) => WebSocketLike;

export interface WebSocketTransportOptions {
  readonly url: string;
  /**
   * Optional WebSocket constructor override. Defaults to
   * `globalThis.WebSocket`. Pass `(await import("ws")).WebSocket` to
   * use the `ws` library (Node 18/20 compat, custom headers).
   */
  readonly WebSocket?: WebSocketConstructor;
  /** Additional WS subprotocols to advertise alongside `agentick-rpc-v1`.
   *  Useful for bilingual MCP servers: `["mcp"]`. */
  readonly extraSubprotocols?: readonly string[];
  /**
   * Reconnect policy. Defaults to exponential backoff (100ms → 30s)
   * with full jitter. Set `{ enabled: false }` to disable.
   */
  readonly reconnect?: ReconnectPolicy;
  /** Optional adopter-provided id for the transport. */
  readonly id?: string;
}

export interface ReconnectPolicy {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

const DEFAULT_RECONNECT: Required<ReconnectPolicy> = {
  enabled: true,
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  maxAttempts: Infinity,
};

const CAPABILITIES: TransportCapabilities = {
  bidirectional: true,
  streamingRequest: true,
  reconnectable: true,
  binaryFrames: false,
};

let transportCounter = 0;

export function websocket(options: WebSocketTransportOptions): ClientTransport {
  return new WebSocketTransport(options);
}

class WebSocketTransport implements ClientTransport {
  readonly id: string;
  readonly capabilities = CAPABILITIES;

  private readonly url: string;
  private readonly ctor: WebSocketConstructor;
  private readonly subprotocols: readonly string[];
  private readonly reconnect: Required<ReconnectPolicy>;

  private socket: WebSocketLike | null = null;
  private currentState: ClientState = "idle";
  private readonly stateListeners = new Set<(s: ClientState) => void>();

  // RPC correlation
  private nextRequestId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  // Streams keyed by id (subscriptionId / progressToken)
  private readonly subscriptionStreams = new Map<string, MultiplexedStream<EventFrame>>();
  private readonly progressStreams = new Map<string, MultiplexedStream<EventFrame>>();

  // Active subscriptions tracked for cursor-aware resubscribe on reconnect
  private readonly activeSubscriptions = new Map<
    string,
    {
      stream: MultiplexedStream<EventFrame>;
      scope: SubscriptionScope;
      query?: EventQuery;
      lastCursor?: Cursor;
    }
  >();

  // Reconnect state
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitClose = false;

  constructor(options: WebSocketTransportOptions) {
    this.id = options.id ?? `ws-${++transportCounter}`;
    this.url = options.url;
    this.ctor = options.WebSocket ?? resolveDefaultWebSocketCtor();
    this.subprotocols = [AGENTICK_SUBPROTOCOL, ...(options.extraSubprotocols ?? [])];
    this.reconnect = { ...DEFAULT_RECONNECT, ...(options.reconnect ?? {}) };
  }

  get state(): ClientState {
    return this.currentState;
  }

  onStateChange(handler: (s: ClientState) => void): () => void {
    this.stateListeners.add(handler);
    return () => this.stateListeners.delete(handler);
  }

  async connect(): Promise<void> {
    if (this.currentState === "open") return;
    this.explicitClose = false;
    await this.openSocket();
  }

  async close(): Promise<void> {
    this.explicitClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const s of this.subscriptionStreams.values()) await s.end(null);
    for (const s of this.progressStreams.values()) await s.end(null);
    this.subscriptionStreams.clear();
    this.progressStreams.clear();
    this.activeSubscriptions.clear();
    for (const p of this.pending.values()) {
      p.reject({ kind: "closed", message: "transport closing" });
    }
    this.pending.clear();
    if (this.socket && this.socket.readyState <= 1) {
      this.socket.close(1000, "client close");
    }
    this.socket = null;
    this.setState("closed");
  }

  async request<M extends WireMethod>(
    method: M,
    params: WireParams<M>,
    signal?: AbortSignal,
  ): Promise<WireResult<M>> {
    if (this.currentState !== "open" || !this.socket) {
      throw { kind: "connection" as const, message: `transport ${this.id} is not open` };
    }
    if (signal?.aborted) {
      throw { kind: "cancelled" as const, message: "aborted before send" };
    }

    const id = this.nextRequestId++ as JsonRpcId;
    const frame = encodeFrame({ jsonrpc: "2.0", id, method, params: params as unknown });

    const promise = new Promise<WireResult<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      signal?.addEventListener("abort", () => {
        this.pending.delete(id);
        // Send `notifications/cancelled` per MCP convention
        this.sendNotification("notifications/cancelled", { requestId: id, reason: "aborted" });
        reject({ kind: "cancelled", message: "aborted" });
      });
    });

    this.socket.send(frame);
    return promise;
  }

  subscribe(scope: SubscriptionScope, query?: EventQuery, fromCursor?: Cursor): SubscriptionStream {
    // Tentative client-side id used until server returns the real subscriptionId.
    const tentativeId = `tentative-sub-${this.id}-${this.nextRequestId++}`;
    const stream = new MultiplexedStream<EventFrame>(tentativeId, async () => {
      const real = stream.id;
      this.subscriptionStreams.delete(real);
      this.activeSubscriptions.delete(real);
      if (this.currentState === "open") {
        try {
          await this.request("unsubscribe", { subscriptionId: real });
        } catch {
          /* swallow */
        }
      }
    });
    this.subscriptionStreams.set(tentativeId, stream);

    void this.request("subscribe", { scope, query, fromCursor }).then((res) => {
      const serverId = (res as { subscriptionId: string }).subscriptionId;
      if (serverId !== tentativeId) {
        this.subscriptionStreams.delete(tentativeId);
        stream.rekey(serverId);
        this.subscriptionStreams.set(serverId, stream);
      }
      this.activeSubscriptions.set(serverId, { stream, scope, query, lastCursor: fromCursor });
    });

    return Object.assign(stream, { subscriptionId: tentativeId });
  }

  progress(progressToken: string): ProgressStream {
    const stream = new MultiplexedStream<EventFrame>(progressToken, async () => {
      this.progressStreams.delete(progressToken);
    });
    this.progressStreams.set(progressToken, stream);
    return Object.assign(stream, { progressToken });
  }

  // ── internals ─────────────────────────────────────────────────────────

  private setState(s: ClientState): void {
    this.currentState = s;
    for (const l of this.stateListeners) l(s);
  }

  private async openSocket(): Promise<void> {
    this.setState("connecting");

    return new Promise<void>((resolve, reject) => {
      const socket = new this.ctor(this.url, this.subprotocols);
      this.socket = socket;

      socket.addEventListener("open", () => {
        this.reconnectAttempts = 0;
        this.setState("open");
        this.resubscribeAfterReconnect();
        resolve();
      });

      socket.addEventListener("message", (ev) => {
        this.handleMessage(ev.data);
      });

      socket.addEventListener("error", (err) => {
        if (this.currentState !== "open") {
          reject({ kind: "connection", message: "WebSocket error before open", cause: err });
        }
        // While open: errors are logged via state; the close event handles cleanup
      });

      socket.addEventListener("close", () => {
        const wasOpen = this.currentState === "open";
        if (wasOpen) {
          for (const p of this.pending.values()) {
            p.reject({ kind: "closed", message: "WebSocket closed mid-request" });
          }
          this.pending.clear();
        }
        if (this.explicitClose) {
          this.setState("closed");
          return;
        }
        if (!this.reconnect.enabled) {
          this.setState("closed");
          return;
        }
        if (this.reconnectAttempts >= this.reconnect.maxAttempts) {
          this.setState({
            kind: "failed",
            error: { kind: "connection", message: "reconnect attempts exhausted" },
          });
          return;
        }
        this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = this.computeBackoff(this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openSocket().catch(() => {
        // openSocket's reject path is handled by the close event chain
      });
    }, delay);
  }

  private computeBackoff(attempt: number): number {
    const exp = Math.min(this.reconnect.maxDelayMs, this.reconnect.initialDelayMs * 2 ** attempt);
    // Full jitter — uniform random in [0, exp). Per AWS Builder's
    // Library "Timeouts, retries, and backoff with jitter".
    return Math.random() * exp;
  }

  /**
   * Cursor-aware resubscribe — replays each still-open subscription
   * with its last-seen cursor when the WS reconnects. The server's bus
   * retention determines whether the cursor is still in window;
   * out-of-retention cursors fail loudly via
   * `notifications/subscription/evicted` (per ADR 29 cursor protocol).
   *
   * Resubscription wire path is exercised end-to-end on reconnect;
   * the retention-eviction path (where the server's bus has rolled
   * past the client's last cursor) is not yet asserted — needs a
   * `LocalEventBus` configured with tight retention plus a subscription
   * that falls behind. Deferred to the 33.C hardening pass.
   */
  private resubscribeAfterReconnect(): void {
    if (this.activeSubscriptions.size === 0) return;
    for (const [oldId, sub] of this.activeSubscriptions) {
      this.activeSubscriptions.delete(oldId);
      this.subscriptionStreams.delete(oldId);
      this.subscriptionStreams.set(oldId, sub.stream); // re-register under old id pending re-key
      void this.request("subscribe", {
        scope: sub.scope,
        query: sub.query,
        fromCursor: sub.lastCursor,
      }).then((res) => {
        const newId = (res as { subscriptionId: string }).subscriptionId;
        this.subscriptionStreams.delete(oldId);
        sub.stream.rekey(newId);
        this.subscriptionStreams.set(newId, sub.stream);
        this.activeSubscriptions.set(newId, sub);
      });
    }
  }

  private sendNotification(method: string, params: unknown): void {
    if (!this.socket || this.currentState !== "open") return;
    this.socket.send(encodeFrame({ jsonrpc: "2.0", method, params }));
  }

  private handleMessage(raw: unknown): void {
    const decoded = decodeFrame(raw as string | ArrayBuffer | Buffer);
    if (!decoded.ok) {
      // Server sent garbage — log path TBD; for now swallow. ADR 33 §5
      // open question on validator-error notification routing.
      return;
    }
    const frame = decoded.value;
    if (Array.isArray(frame)) {
      for (const f of frame) this.routeSingle(f as JsonRpcFrame);
      return;
    }
    this.routeSingle(frame as JsonRpcFrame);
  }

  private routeSingle(frame: JsonRpcFrame): void {
    if ("id" in frame && ("result" in frame || "error" in frame)) {
      this.routeResponse(frame as JsonRpcResponse);
      return;
    }
    if ("method" in frame && !("id" in frame)) {
      this.routeNotification(frame.method, frame.params);
      return;
    }
    // Server-initiated requests (notifications/cancelled with id?) — out of
    // scope for the initial impl; ignore.
  }

  private routeResponse(response: JsonRpcResponse): void {
    const id = response.id as JsonRpcId;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if ("error" in response && response.error) {
      pending.reject({ kind: "rpc", error: response.error });
      return;
    }
    if ("result" in response) {
      pending.resolve(response.result);
    }
  }

  private routeNotification(method: string, paramsRaw: unknown): void {
    const params = paramsRaw as Record<string, unknown> | undefined;
    if (!params) return;

    switch (method) {
      case "notifications/progress": {
        const token = params.progressToken as string;
        const stream = this.progressStreams.get(token);
        if (!stream) return;
        const frame = {
          cursor: params.cursor as Cursor,
          envelope: params.envelope as EventFrame["envelope"],
        };
        stream.push(frame);
        return;
      }
      case "notifications/subscription/event": {
        const subId = params.subscriptionId as string;
        const stream = this.subscriptionStreams.get(subId);
        if (!stream) return;
        const cursor = params.cursor as Cursor;
        const frame = {
          cursor,
          envelope: params.envelope as EventFrame["envelope"],
        };
        const active = this.activeSubscriptions.get(subId);
        if (active) active.lastCursor = cursor;
        stream.push(frame);
        return;
      }
      case "notifications/subscription/closed": {
        const subId = params.subscriptionId as string;
        const stream = this.subscriptionStreams.get(subId);
        if (!stream) return;
        void stream.end(null);
        this.subscriptionStreams.delete(subId);
        this.activeSubscriptions.delete(subId);
        return;
      }
      case "notifications/subscription/evicted": {
        const subId = params.subscriptionId as string;
        const stream = this.subscriptionStreams.get(subId);
        if (!stream) return;
        void stream.end({
          kind: "protocol",
          message: "cursor evicted",
          cause: params,
        });
        this.subscriptionStreams.delete(subId);
        this.activeSubscriptions.delete(subId);
        return;
      }
      default:
        return;
    }
  }
}

// ============================================================================
// MultiplexedStream — bounded AsyncIterable shared by subscription + progress
// ============================================================================

class MultiplexedStream<T> implements AsyncIterable<T> {
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
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
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
        if (this.error !== null) return Promise.reject(this.error);
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

// ============================================================================
// Resolver — picks `globalThis.WebSocket` when available
// ============================================================================

function resolveDefaultWebSocketCtor(): WebSocketConstructor {
  const g = globalThis as { WebSocket?: WebSocketConstructor };
  if (typeof g.WebSocket === "function") return g.WebSocket;
  throw new Error(
    'No `globalThis.WebSocket` available. Pass `{ WebSocket: (await import("ws")).WebSocket }` to opt into the `ws` library (Node 18/20 or custom-header use cases).',
  );
}
