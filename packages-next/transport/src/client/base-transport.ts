/**
 * `BaseClientTransport` — abstract base every `@agentick/transport-*-next`
 * client transport subclasses.
 *
 * Owns:
 *   - Connection state machine + listener registry
 *   - RPC correlation via JSON-RPC `id` (pending map, in-flight ids)
 *   - Subscription stream registry (keyed by `subscriptionId`, re-keyed
 *     when the server allocates the real id)
 *   - Progress stream registry (keyed by `progressToken`)
 *   - Notification routing — `notifications/progress`,
 *     `notifications/subscription/event`, `notifications/subscription/closed`,
 *     `notifications/subscription/evicted`
 *   - Cursor tracking on incoming subscription events (for cursor-aware
 *     resume after reconnect — the subclass that needs reconnect just
 *     uses `activeSubscriptions`)
 *   - AbortSignal → `notifications/cancelled` emit on the wire
 *   - subscribe() → temp-id stream → server-allocated id re-key dance
 *   - progress(token) stream factory
 *
 * Subclasses fill in:
 *   - `protected abstract openConnection(): Promise<void>` — bring the
 *     wire up. Throws TransportError on failure.
 *   - `protected abstract closeConnection(): Promise<void>` — tear down.
 *   - `protected abstract sendFrame(frame): void | Promise<void>` — write
 *     a frame to the wire. For in-process: invoke the handler synchronously.
 *     For WS: `socket.send(JSON.stringify(frame))`.
 *
 * Subclasses receive inbound frames by calling `this.routeFrame(frame)`.
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
  SubscribeParams,
  SubscriptionScope,
  SubscriptionStream,
  TransportCapabilities,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec-next";
import { createNotifier } from "@agentick/pubsub-next";

import { MultiplexedStream } from "./multiplexed-stream.js";

/**
 * Active subscription bookkeeping. Subclasses with reconnect support
 * (WS) iterate `activeSubscriptions` to re-subscribe with each
 * subscription's `lastCursor`.
 */
export interface ActiveSubscription {
  readonly stream: MultiplexedStream<EventFrame>;
  readonly scope: SubscriptionScope;
  readonly query?: EventQuery;
  lastCursor?: Cursor;
}

/**
 * Reconnect policy shared by every transport that supports reconnect.
 * Exponential backoff with full jitter per AWS Builder's Library
 * "Timeouts, retries, and backoff with jitter".
 */
export interface ReconnectPolicy {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

export const DEFAULT_RECONNECT_POLICY: Required<ReconnectPolicy> = {
  enabled: true,
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  maxAttempts: Infinity,
};

/**
 * Exponential backoff with full jitter per AWS Builder's Library
 * "Timeouts, retries, and backoff with jitter" (Marc Brooker).
 *
 * Returns a uniform random delay in `[0, min(maxDelayMs, initialDelayMs * 2^attempt))`.
 * Free function form for property-based testing — the protected
 * `BaseClientTransport.computeBackoff` is a thin wrapper.
 *
 * @verifiedBy src/__tests__/backoff-jitter.spec.ts
 */
export function computeFullJitterBackoff(
  attempt: number,
  policy: Pick<Required<ReconnectPolicy>, "initialDelayMs" | "maxDelayMs">,
  random: () => number = Math.random,
): number {
  const exp = Math.min(policy.maxDelayMs, policy.initialDelayMs * 2 ** attempt);
  return random() * exp;
}

export abstract class BaseClientTransport implements ClientTransport {
  abstract readonly id: string;
  abstract readonly capabilities: TransportCapabilities;

  protected currentState: ClientState = "idle";
  private readonly stateListeners = createNotifier<ClientState>();

  // Generic notification observers keyed by method name — the fallback
  // path for `routeNotification`. Progress + subscription frames are
  // handled by the dedicated stream registries above; everything else
  // (auth/expired, capabilities/changed, future notifications) fans out
  // through this map.
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();

  // RPC correlation
  private nextRequestId = 1;
  protected readonly pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();

  // Multiplexed streams keyed by id
  protected readonly subscriptionStreams = new Map<string, MultiplexedStream<EventFrame>>();
  protected readonly progressStreams = new Map<string, MultiplexedStream<EventFrame>>();

  // Active subscriptions tracked for cursor-aware resubscribe (subclass uses)
  protected readonly activeSubscriptions = new Map<string, ActiveSubscription>();

  // Reconnect machinery — opt-in. Subclasses that don't reconnect
  // (in-process) leave `reconnectPolicy.enabled` at default (true) but
  // never call `handleConnectionDrop()` so reconnect never fires.
  protected reconnectPolicy: Required<ReconnectPolicy> = DEFAULT_RECONNECT_POLICY;
  protected explicitClose = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  get state(): ClientState {
    return this.currentState;
  }

  onStateChange(handler: (s: ClientState) => void): () => void {
    return this.stateListeners.subscribe(handler);
  }

  protected setState(s: ClientState): void {
    this.currentState = s;
    this.stateListeners.notify(s);
  }

  // ── lifecycle (subclass-provided) ────────────────────────────────────

  protected abstract openConnection(): Promise<void>;
  protected abstract closeConnection(): Promise<void>;

  /**
   * Write a frame to the wire. Subclasses for synchronous-handler
   * transports (in-process) MAY route inbound responses immediately
   * by calling `this.routeFrame(response)`. Network transports
   * (WS / HTTP / Unix-socket) write the frame and rely on their
   * inbound-message handler to call `routeFrame` later.
   */
  protected abstract sendFrame(frame: JsonRpcFrame): void | Promise<void>;

  async connect(): Promise<void> {
    if (this.currentState === "open") return;
    await this.openConnection();
  }

  async close(): Promise<void> {
    for (const s of this.subscriptionStreams.values()) await s.end(null);
    for (const s of this.progressStreams.values()) await s.end(null);
    this.subscriptionStreams.clear();
    this.progressStreams.clear();
    this.activeSubscriptions.clear();
    for (const p of this.pending.values()) {
      p.reject({ kind: "closed", message: "transport closing" });
    }
    this.pending.clear();
    await this.closeConnection();
    this.setState("closed");
  }

  // ── RPC dispatch ─────────────────────────────────────────────────────

  async request<M extends WireMethod>(
    method: M,
    params: WireParams<M>,
    signal?: AbortSignal,
  ): Promise<WireResult<M>> {
    if (this.currentState !== "open") {
      throw { kind: "connection" as const, message: `transport ${this.id} is not open` };
    }
    if (signal?.aborted) {
      throw { kind: "cancelled" as const, message: "aborted before send" };
    }

    const id = this.nextRequestId++ as JsonRpcId;
    const frame: JsonRpcFrame = {
      jsonrpc: "2.0",
      id,
      method,
      params: params as unknown,
    };

    // Listener is hoisted so we can remove it after settle — without this,
    // long-lived signals (e.g. one AbortController shared across many
    // requests) accumulate listeners with each call. `{ once: true }`
    // alone isn't enough: the listener must also detach when the response
    // arrives, not just when the signal fires.
    let onAbort: (() => void) | undefined;
    const promise = new Promise<WireResult<M>>((resolve, reject) => {
      const settle = (kind: "resolve" | "reject", value: unknown): void => {
        // Detach the abort listener on settle (success OR error) so it
        // doesn't outlive the request on a long-lived caller signal.
        if (signal !== undefined && onAbort !== undefined) {
          signal.removeEventListener("abort", onAbort);
        }
        if (kind === "resolve") resolve(value as WireResult<M>);
        else reject(value);
      };
      this.pending.set(id, {
        resolve: (v: unknown) => settle("resolve", v),
        reject: (e: unknown) => settle("reject", e),
      });
      if (signal !== undefined) {
        onAbort = (): void => {
          if (!this.pending.has(id)) return; // already settled
          this.pending.delete(id);
          // MCP convention — see ADR 33 §wire/cancellation.
          void this.sendNotification("notifications/cancelled", {
            requestId: id,
            reason: "aborted",
          });
          settle("reject", { kind: "cancelled", message: "aborted" });
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    // Mark the inner promise's rejection as observed at the Node level so
    // Node's unhandledRejection hook doesn't fire during the microtask gap
    // between a synchronous rejection (e.g. abort listener) and the outer
    // `return promise` adoption. The original `promise` still carries its
    // rejection state; the outer flow propagates it normally.
    promise.catch(() => {});

    try {
      await this.sendFrame(frame);
    } catch (err) {
      // Wire-write failed — clean up the pending entry so a later close()
      // doesn't reject an orphaned Promise that nobody's awaiting.
      // Otherwise the retry middleware (which sees the sendFrame error and
      // moves on) leaves the original `promise` behind; close() then fires
      // `{ kind: "closed" }` rejections with no handler → unhandled
      // rejection noise.
      this.pending.delete(id);
      throw err;
    }
    return promise;
  }

  /**
   * Emit a JSON-RPC notification (no id, no response). Used for
   * `notifications/cancelled` and any future client-originated
   * notifications.
   */
  protected async sendNotification(method: string, params: unknown): Promise<void> {
    if (this.currentState !== "open") return;
    await this.sendFrame({ jsonrpc: "2.0", method, params });
  }

  // ── subscribe / progress ─────────────────────────────────────────────

  subscribe(scope: SubscriptionScope, query?: EventQuery, fromCursor?: Cursor): SubscriptionStream {
    const tentativeId = `tentative-sub-${this.id}-${this.nextRequestId++}`;
    const stream = new MultiplexedStream<EventFrame>(tentativeId, async () => {
      const real = stream.id;
      this.subscriptionStreams.delete(real);
      this.activeSubscriptions.delete(real);
      if (this.currentState === "open") {
        try {
          await this.request("sub/unsubscribe", { subscriptionId: real });
        } catch {
          /* swallow */
        }
      }
    });
    this.subscriptionStreams.set(tentativeId, stream);

    // CRITICAL: re-key the stream SYNCHRONOUSLY when the subscribe response
    // arrives — not via `.then()`. EventEmitter delivers WS messages
    // synchronously in sequence; microtasks don't drain between them, so a
    // `.then()` re-key runs AFTER any same-tick notification frames have
    // already missed the stream lookup and been silently dropped.
    this.dispatchSubscribeFrame({ scope, query, fromCursor }, (serverId) => {
      if (serverId !== tentativeId) {
        this.subscriptionStreams.delete(tentativeId);
        stream.rekey(serverId);
        this.subscriptionStreams.set(serverId, stream);
      }
      this.activeSubscriptions.set(serverId, { stream, scope, query, lastCursor: fromCursor });
    });

    return Object.assign(stream, { subscriptionId: tentativeId });
  }

  /**
   * Issue a `subscribe` RPC with a SYNCHRONOUS post-response callback.
   * The callback fires inside `routeResponse` before the next inbound
   * frame is dispatched — preventing the back-to-back notification race
   * that hits when a server emits `[subscribe-response, event, event]`
   * in one TCP segment.
   *
   * The race: WS library emits 'message' events synchronously via
   * `EventEmitter.emit()`; microtasks don't drain between them. Using
   * `await req.then(...)` to re-key the stream therefore runs the
   * re-key AFTER subsequent same-tick events have missed the lookup
   * by server-allocated id.
   */
  private dispatchSubscribeFrame(
    params: SubscribeParams,
    onResolved: (serverId: string) => void,
  ): void {
    if (this.currentState !== "open") return;

    const id = this.nextRequestId++ as JsonRpcId;
    const frame: JsonRpcFrame = {
      jsonrpc: "2.0",
      id,
      method: "sub/subscribe",
      params: params as unknown,
    };

    this.pending.set(id, {
      // The synchronous re-key happens HERE — inside routeResponse's
      // call to pending.resolve, before any subsequent message handler
      // fires.
      resolve: (res: unknown) => {
        const serverId = (res as { subscriptionId?: string } | null | undefined)?.subscriptionId;
        if (typeof serverId === "string") onResolved(serverId);
      },
      reject: () => {
        /* swallow — caller doesn't wait on this Promise */
      },
    });

    void this.sendFrame(frame);
  }

  progress(progressToken: string): ProgressStream {
    const stream = new MultiplexedStream<EventFrame>(progressToken, async () => {
      this.progressStreams.delete(progressToken);
    });
    this.progressStreams.set(progressToken, stream);
    return Object.assign(stream, { progressToken });
  }

  // ── inbound frame routing (subclasses call this) ─────────────────────

  /**
   * Dispatch a decoded inbound frame to the right handler:
   *   - response → resolves the pending RPC by id
   *   - notification → routes to subscription / progress stream by token
   *
   * Subclasses MUST call this with frames they receive over the wire
   * (after validation). Untrusted JSON must run through
   * `validateJsonRpcInput` from spec before reaching this method.
   */
  protected routeFrame(frame: JsonRpcFrame): void {
    if ("id" in frame && ("result" in frame || "error" in frame)) {
      this.routeResponse(frame as JsonRpcResponse);
      return;
    }
    if ("method" in frame && !("id" in frame)) {
      const noteFrame = frame as { method: string; params?: unknown };
      this.routeNotification(noteFrame.method, noteFrame.params);
      return;
    }
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
        stream.push({
          cursor: params.cursor as Cursor,
          envelope: params.envelope as EventFrame["envelope"],
        });
        return;
      }
      case "notifications/subscription/event": {
        const subId = params.subscriptionId as string;
        const stream = this.subscriptionStreams.get(subId);
        if (!stream) return;
        const cursor = params.cursor as Cursor;
        const active = this.activeSubscriptions.get(subId);
        if (active) active.lastCursor = cursor;
        stream.push({ cursor, envelope: params.envelope as EventFrame["envelope"] });
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
      default: {
        // Fallback path — anything the transport doesn't handle
        // intrinsically fans out to `onNotification` subscribers keyed
        // by method. `params` may legitimately be `undefined` for
        // bare-payload notifications (capabilities/changed, initialized).
        const listeners = this.notificationHandlers.get(method);
        if (!listeners) return;
        for (const l of listeners) {
          try {
            l(paramsRaw);
          } catch {
            /* swallow — a bad listener must not poison the routing loop */
          }
        }
        return;
      }
    }
  }

  /**
   * Subscribe to arbitrary server-emitted notifications by method name.
   * Unlike `notifications/progress` and `notifications/subscription/*`
   * (which route to stream registries), everything reaching this
   * subscriber is a fire-and-forget frame — auth/expired,
   * capabilities/changed, and adopter-declared extension notifications.
   *
   * Multiple listeners per method are allowed; each is called in
   * registration order. A throwing listener is caught and does not
   * poison siblings.
   *
   * Returns an unsubscribe.
   */
  onNotification(method: string, listener: (params: unknown) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(listener);
    return () => {
      const s = this.notificationHandlers.get(method);
      if (!s) return;
      s.delete(listener);
      if (s.size === 0) this.notificationHandlers.delete(method);
    };
  }

  // ── helpers for subclasses with reconnect support ────────────────────

  /**
   * Subclasses with reconnect support call this when their wire drops.
   * Decides whether to schedule a reconnect attempt, transition to
   * closed (if explicit close or reconnect disabled), or move to
   * failed (if max attempts exhausted).
   *
   * Side effects:
   *   - Rejects all in-flight RPCs with `{ kind: "closed" }`
   *   - Transitions state to "closed" / "failed" / "reconnecting"
   *   - On "reconnecting", schedules a backoff-delayed
   *     `this.openConnection()` call
   *
   * Consolidated in Phase 33.C.2 — was duplicated identically in
   * WS / UDS / HTTP transports.
   */
  protected handleConnectionDrop(): void {
    for (const p of this.pending.values()) {
      p.reject({ kind: "closed", message: "wire closed mid-request" });
    }
    this.pending.clear();

    if (this.explicitClose) {
      this.setState("closed");
      return;
    }
    if (!this.reconnectPolicy.enabled) {
      this.setState("closed");
      return;
    }
    if (this.reconnectAttempts >= this.reconnectPolicy.maxAttempts) {
      this.setState({
        kind: "failed",
        error: { kind: "connection", message: "reconnect attempts exhausted" },
      });
      return;
    }
    this.scheduleReconnect();
  }

  /** Reset the reconnect attempt counter — call after a successful open. */
  protected resetReconnectAttempts(): void {
    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(): void {
    this.setState("reconnecting");
    const delay = this.computeBackoff(this.reconnectAttempts);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.openConnection().catch(() => {
        /* subclass's wire close handler retries via handleConnectionDrop */
      });
    }, delay);
  }

  /**
   * Exponential backoff with full jitter per AWS Builder's Library
   * "Timeouts, retries, and backoff with jitter". Returns a uniform
   * random delay in `[0, min(maxDelayMs, initialDelayMs * 2^attempt))`.
   */
  protected computeBackoff(attempt: number): number {
    return computeFullJitterBackoff(attempt, this.reconnectPolicy);
  }

  /** Cancel any pending reconnect timer. Subclass's `closeConnection` calls this. */
  protected cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  /**
   * Subclasses with reconnect (e.g., WebSocket) call this after the
   * connection re-opens. Re-subscribes every still-open subscription
   * from its last-seen cursor.
   */
  protected resubscribeAfterReconnect(): void {
    if (this.activeSubscriptions.size === 0) return;
    for (const [oldId, sub] of this.activeSubscriptions) {
      this.activeSubscriptions.delete(oldId);
      this.subscriptionStreams.delete(oldId);
      this.subscriptionStreams.set(oldId, sub.stream);
      // Same synchronous-rekey discipline as subscribe() — see the
      // comment on dispatchSubscribeFrame.
      this.dispatchSubscribeFrame(
        { scope: sub.scope, query: sub.query, fromCursor: sub.lastCursor },
        (newId) => {
          this.subscriptionStreams.delete(oldId);
          sub.stream.rekey(newId);
          this.subscriptionStreams.set(newId, sub.stream);
          this.activeSubscriptions.set(newId, sub);
        },
      );
    }
  }
}
