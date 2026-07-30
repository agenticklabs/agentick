/**
 * `BaseClientTransport` — abstract base every `@agentick/transport-*`
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
  TransportError,
  WireMethod,
  WireParams,
  WireResult,
} from "@agentick/spec";
import { createNotifier } from "@agentick/pubsub";

import { MultiplexedStream } from "./multiplexed-stream.js";
import { transportError } from "./transport-failure.js";

/** Render a `ClientState` for an error message (the failed variant is an object). */
function describeState(state: ClientState): string {
  return typeof state === "string" ? state : `failed (${state.error.kind})`;
}

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
 *
 * ## Scope: this policy covers the FIRST dial too
 *
 * `connect()` rejects as soon as its own dial fails — an adopter awaiting it
 * gets an answer immediately rather than blocking on a loop whose default
 * `maxAttempts` is `Infinity`. But rejecting is not giving up: when this
 * policy is `enabled`, the transport ALSO arms the backoff loop and keeps
 * dialing, so a client pointed at a server that is still booting comes up on
 * its own. The rejection says so explicitly, and the recovery is observable
 * on {@link ClientTransport.onStateChange} (`reconnecting` → `open`).
 *
 * Two consequences worth knowing:
 *   - A rejected `connect()` does NOT mean the transport is dead. Either
 *     await `client.whenReady()` / watch `onStateChange`, or pass
 *     `enabled: false` if you want a single dial and nothing more.
 *   - With `enabled: false`, a failed `connect()` IS terminal.
 *
 * @verifiedBy ../../../transport-websocket/src/__tests__/reconnect-e2e.spec.ts
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
 * Liveness policy — how a transport notices a wire that died SILENTLY.
 *
 * The reconnect loop above is armed by one thing: the wire reporting that it
 * closed. Every drop that produces a FIN, an RST, or a close frame is
 * therefore covered. The drop that produces NONE of those is not: laptop
 * sleep, NAT/conntrack eviction, a cellular handoff, a load balancer that
 * stops forwarding without resetting. The socket stays in `OPEN`, no event
 * ever fires, and a transport with no liveness probe sits in `state: "open"`
 * forever while every request hangs unanswered — the wire is gone and the
 * client is the last to know.
 *
 * So the transport asks. A `ping` RPC goes out every `intervalMs`; if no
 * answer arrives within `timeoutMs`, the wire is declared dead, in-flight
 * requests reject, and the reconnect loop above takes over. `ping` is the
 * MCP-convention keepalive and every gateway serves it, so this costs one
 * tiny frame per interval and needs no capability negotiation.
 *
 * Set `enabled: false` when something else already guarantees liveness (an
 * in-process handler, a test double). Note that the WS protocol's own
 * ping/pong is NOT a substitute: the browser `WebSocket` API cannot send a
 * ping, and a server-side ping into a blackholed path detects the death only
 * on the server's side, which cannot tell a client that cannot hear it.
 *
 * @verifiedBy ../../../transport-websocket/src/__tests__/reconnect-e2e.spec.ts
 */
export interface KeepalivePolicy {
  readonly enabled?: boolean;
  /** Interval between liveness probes while the wire is open. */
  readonly intervalMs?: number;
  /** How long a probe may go unanswered before the wire is declared dead. */
  readonly timeoutMs?: number;
}

export const DEFAULT_KEEPALIVE_POLICY: Required<KeepalivePolicy> = {
  enabled: true,
  intervalMs: 30_000,
  timeoutMs: 10_000,
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

  // Liveness machinery — armed by `markWireUp()`, disarmed on drop/close.
  protected keepalivePolicy: Required<KeepalivePolicy> = DEFAULT_KEEPALIVE_POLICY;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private probeInFlight = false;

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
    // Deliberate close: disarm liveness AND the dial loop before tearing the
    // wire down, so nothing redials behind the caller's back. `explicitClose`
    // (set by the subclass's `closeConnection`) is what keeps the wire's own
    // close event from re-arming it.
    this.stopKeepalive();
    this.cancelReconnect();
    for (const s of this.subscriptionStreams.values()) await s.end(null);
    for (const s of this.progressStreams.values()) await s.end(null);
    this.subscriptionStreams.clear();
    this.progressStreams.clear();
    this.activeSubscriptions.clear();
    const closing = transportError({ kind: "closed", message: "transport closing" });
    for (const p of this.pending.values()) p.reject(closing);
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
      throw transportError({
        kind: "connection",
        message: `transport ${this.id} is not open (state: ${describeState(this.currentState)})`,
      });
    }
    if (signal?.aborted) {
      throw transportError({ kind: "cancelled", message: "aborted before send" });
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
          settle("reject", transportError({ kind: "cancelled", message: "aborted" }));
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
      pending.reject(transportError({ kind: "rpc", error: response.error }));
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
      case "notifications/progress/complete": {
        // End of stream for this token. `close()` ends the iterator (the
        // buffered tail still drains — `MultiplexedStream.next` empties the
        // buffer before signalling done) and its onClose reaps the
        // registration, so a completed send leaves nothing in the map.
        const token = params.progressToken as string;
        const stream = this.progressStreams.get(token);
        if (!stream) return;
        void stream.close();
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
      default:
        // Unrecognized notification — no dedicated stream, no handler.
        // Silently ignored (forward-compat: a newer server may emit
        // frames this client doesn't model).
        return;
    }
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
   *
   * **Call this exactly once per dead wire.** Twice for the same wire arms two
   * competing dial loops (the second `scheduleReconnect` overwrites
   * `reconnectTimer`, orphaning the first timer's socket). That is easy to trip
   * now that {@link declareWireDead} can report a death the wire itself will
   * ALSO report a moment later via its close event. Deduplicating belongs at
   * the wire, not here: only the subclass knows whether an inbound event came
   * from the socket it still holds or from one it already discarded, and a
   * latch in this method cannot tell that apart from the next dial's failure
   * (which MUST re-arm the loop). Every subclass therefore drops events from a
   * wire it no longer holds — see the staleness guards in the WS transport's
   * `openSocket`, the UDS `close` listener, and HTTP's `signal.aborted` check.
   */
  protected handleConnectionDrop(cause?: TransportError): void {
    this.stopKeepalive();

    const failure = transportError(cause ?? { kind: "closed", message: "wire closed mid-request" });
    for (const p of this.pending.values()) p.reject(failure);
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

  /**
   * Subclasses call this from their successful-open path. Resets the backoff
   * counter and arms the liveness probe — both correct only once the wire is
   * actually carrying frames, and both easy to forget one of (an un-armed
   * probe leaves the transport blind to a silent death again).
   */
  protected markWireUp(): void {
    this.reconnectAttempts = 0;
    this.startKeepalive();
  }

  // ── liveness ─────────────────────────────────────────────────────────

  /**
   * Arm the liveness probe. Idempotent — re-arming replaces the timer, so a
   * redial never leaves two probes running.
   */
  protected startKeepalive(): void {
    this.stopKeepalive();
    const { enabled, intervalMs } = this.keepalivePolicy;
    if (!enabled || !Number.isFinite(intervalMs) || intervalMs <= 0) return;
    const timer = setInterval(() => void this.probeLiveness(), intervalMs);
    // A keepalive must never be the reason a process refuses to exit; the
    // open socket it is probing already holds the loop.
    (timer as { unref?: () => void }).unref?.();
    this.keepaliveTimer = timer;
  }

  protected stopKeepalive(): void {
    if (this.keepaliveTimer === null) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  /**
   * One liveness probe: a `ping` RPC under a deadline. No answer in time means
   * the wire is gone regardless of what the socket claims, so declare it dead
   * and let the reconnect loop redial.
   *
   * `AbortSignal.timeout` supplies the deadline — `request()` already honors a
   * signal, so this needs no timeout plumbing of its own.
   */
  private async probeLiveness(): Promise<void> {
    if (this.currentState !== "open" || this.probeInFlight) return;
    this.probeInFlight = true;
    try {
      await this.request("ping", {}, AbortSignal.timeout(this.keepalivePolicy.timeoutMs));
    } catch {
      // A drop detected by the wire itself already ran the drop path (and
      // rejected this probe with it) — `handleConnectionDrop` is idempotent,
      // but skip the redundant teardown when the state already moved.
      if (this.currentState !== "open") return;
      this.declareWireDead(`liveness probe unanswered after ${this.keepalivePolicy.timeoutMs}ms`);
    } finally {
      this.probeInFlight = false;
    }
  }

  /**
   * Declare an apparently-open wire dead. Unlike the wire's own close event
   * this runs while the socket still claims to be `OPEN`, so the zombie is
   * discarded first ({@link discardWire}) — otherwise `sendFrame` keeps
   * writing into it and the redial competes with a socket that will never
   * answer.
   */
  protected declareWireDead(reason: string): void {
    this.stopKeepalive();
    this.discardWire();
    this.handleConnectionDrop({ kind: "connection", message: reason });
  }

  /**
   * Abruptly discard the current wire without marking an explicit close.
   * Default is a no-op — override in subclasses that hold a socket the
   * liveness probe can find dead. A graceful close is the wrong tool here: it
   * waits for a peer close-frame that a blackholed path will never deliver.
   */
  protected discardWire(): void {}

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
