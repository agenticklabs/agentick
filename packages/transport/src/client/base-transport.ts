/**
 * `BaseClientTransport` — abstract base every `@agentick/transport-*`
 * client transport subclasses.
 *
 * Owns:
 *   - Connection state machine + listener registry
 *   - RPC correlation via JSON-RPC `id` (pending map, in-flight ids)
 *   - Subscription stream registry (keyed by the CLIENT-allocated
 *     `subscriptionId` this class mints and the server adopts)
 *   - Progress stream registry (keyed by `progressToken`)
 *   - Notification routing — `notifications/progress`,
 *     `notifications/subscription/event`, `notifications/subscription/closed`,
 *     `notifications/subscription/evicted`
 *   - Cursor tracking on incoming subscription events (for cursor-aware
 *     resume after reconnect — the subclass that needs reconnect just
 *     uses `activeSubscriptions`)
 *   - AbortSignal → `notifications/cancelled` emit on the wire
 *   - subscribe() → id allocation → stream registered before the frame is sent
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
import { ErrorCode, isClientStateFailed } from "@agentick/spec";
import { createNotifier } from "@agentick/pubsub";
import { computeFullJitterBackoff } from "@agentick/utils";

import { MultiplexedStream } from "./multiplexed-stream.js";
import { toTransportError, transportError } from "./transport-failure.js";

export { computeFullJitterBackoff };

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
  /**
   * When the CURRENT resubscribe campaign began, and how many attempts it has
   * spent. Both reset on every reconnect — see {@link resubscribeAfterReconnect}
   * and `ReconnectPolicy.resubscribeGraceMs`.
   */
  resubscribeStartedAt?: number;
  resubscribeAttempts?: number;
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
  /**
   * How long a dial may go UNANSWERED before it is abandoned and retried.
   *
   * The loop above is armed by a dial that fails. A dial that neither succeeds
   * nor fails arms nothing — and that is not exotic, it is what a backend
   * behind a live proxy looks like: a dev-server proxy, an ingress, or a load
   * balancer accepts the TCP connection and then never completes the upgrade
   * because the upstream is not there. The socket sits in `CONNECTING`, no
   * event ever fires, and a transport with no deadline waits in `connecting`
   * for the life of the tab — including long after the backend came up.
   *
   * So the dial is bounded. On expiry the half-open wire is discarded
   * ({@link BaseClientTransport.discardWire}) and the failure re-arms the
   * backoff loop like any other. `Infinity` disables the deadline.
   *
   * @verifiedBy ../../../transport-websocket/src/__tests__/reconnect-to-new-gateway.spec.ts
   */
  readonly dialTimeoutMs?: number;
  /**
   * How long a reconnected transport keeps re-asking for a subscription whose
   * SCOPE the peer does not (yet) have.
   *
   * A gateway that restarted comes back with an empty session registry. The
   * wire is back in milliseconds — well before the adopter's create-or-resume
   * has rebuilt anything — so the automatic resubscribe below asks for a
   * session that will exist shortly and does not exist now. Treating that
   * answer as final is how a client reconnects to a live wire and never
   * receives another event; treating it as a race, and re-asking on the same
   * backoff curve, is what makes the subscription heal on its own.
   *
   * The window is finite because the two cases are indistinguishable at the
   * instant of the answer: a session being rebuilt and a session that is
   * genuinely gone both say "not found". When it expires the stream ends with
   * that error, so a consumer is told rather than left waiting forever. Only
   * "not found" is retried — a refusal (forbidden, invalid, no such method) is
   * a verdict, and ends the stream immediately.
   *
   * @verifiedBy ../../../transport-websocket/src/__tests__/reconnect-to-new-gateway.spec.ts
   */
  readonly resubscribeGraceMs?: number;
}

export const DEFAULT_RECONNECT_POLICY: Required<ReconnectPolicy> = {
  enabled: true,
  initialDelayMs: 100,
  maxDelayMs: 30_000,
  maxAttempts: Infinity,
  dialTimeoutMs: 10_000,
  resubscribeGraceMs: 30_000,
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

/** Ceiling on the resubscribe retry delay — see `computeResubscribeBackoff`. */
const RESUBSCRIBE_MAX_DELAY_MS = 2_000;

export const DEFAULT_KEEPALIVE_POLICY: Required<KeepalivePolicy> = {
  enabled: true,
  intervalMs: 30_000,
  timeoutMs: 10_000,
};

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
  /** The dial currently in flight, if any — see {@link dial}. */
  private dialInFlight: Promise<void> | null = null;
  /** Pending resubscribe retries, keyed by subscription id. */
  private readonly resubscribeTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Stamp identifying the CURRENT dial attempt. Bumped by every arm, so a
   * late failure from a superseded dial can recognise itself and stay out of
   * the way — see {@link onDialFailed}.
   */
  private dialGeneration = 0;

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

  /**
   * Dial the wire. Rejects with the dial's own failure so a caller gets an
   * answer instead of blocking on a loop whose default `maxAttempts` is
   * `Infinity` — but rejecting is not giving up: the backoff loop is armed by
   * that same failure and keeps dialing (see {@link ReconnectPolicy}).
   *
   * Arming it HERE rather than leaving it to each subclass's wire-failure path
   * is what makes the guarantee uniform. A dial that fails before a socket
   * exists (`ENOENT` on a Unix socket path, a `fetch` that never got a
   * response) has no close event to report it, and a transport whose only
   * re-arm trigger is that event stops trying after one failure — the
   * "connects, then silently stops" mode. {@link armLoopAfterFailedDial}
   * no-ops when the wire's own path already armed it.
   */
  async connect(): Promise<void> {
    if (this.currentState === "open") return;
    try {
      await this.dial();
    } catch (err) {
      this.armLoopAfterFailedDial();
      throw err;
    }
  }

  /**
   * The ONE way a dial happens — single-flight, and bounded by
   * `ReconnectPolicy.dialTimeoutMs`.
   *
   * Single-flight because a second concurrent dial is never what anyone
   * wanted. `connect()` is public and adopters call it again — a retry button,
   * a bootstrap effect that re-runs, a reconnect loop whose timer fires while
   * the caller's own dial is still in flight — and each call used to open its
   * own socket. The subclass's staleness guard then MUTES every listener on
   * whichever socket lost: the loser's promise never settles (so the caller
   * that awaited `connect()` waits forever, on a transport that may already be
   * open) and its socket is never closed (so a connection the client cannot
   * read stays open on the server). Joining the dial already in flight removes
   * both, and costs the second caller nothing — it wanted a connection, not a
   * particular socket.
   */
  protected dial(): Promise<void> {
    const existing = this.dialInFlight;
    if (existing) return existing;
    let attempt: Promise<void>;
    try {
      attempt = Promise.resolve(this.openConnection());
    } catch (err) {
      // A subclass whose `openConnection` throws synchronously still gets a
      // rejected promise out of here — every caller awaits, none catches.
      return Promise.reject(err);
    }
    const tracked = this.underDialDeadline(attempt).finally(() => {
      if (this.dialInFlight === tracked) this.dialInFlight = null;
    });
    this.dialInFlight = tracked;
    return tracked;
  }

  /**
   * Reject a dial that has gone unanswered past the deadline, discarding the
   * half-open wire on the way out so the redial does not compete with a socket
   * that will never answer. Unbounded (`Infinity`) passes the dial through.
   */
  private underDialDeadline(attempt: Promise<void>): Promise<void> {
    const ms = this.reconnectPolicy.dialTimeoutMs;
    if (!Number.isFinite(ms) || ms <= 0) return attempt;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          this.discardWire();
        } catch {
          // Releasing a wire that never came up is best-effort; what matters
          // is that the rejection below still arms the loop.
        }
        reject(
          transportError({
            kind: "timeout",
            message: `dial on transport ${this.id} went unanswered for ${ms}ms; abandoning it and retrying`,
            afterMs: ms,
          }),
        );
      }, ms);
      // A dial deadline must never be the reason a process refuses to exit.
      (timer as { unref?: () => void }).unref?.();
      attempt.then(
        () => {
          clearTimeout(timer);
          resolve();
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  async close(): Promise<void> {
    // Deliberate close: disarm liveness AND the dial loop before tearing the
    // wire down, so nothing redials behind the caller's back. `explicitClose`
    // (set by the subclass's `closeConnection`) is what keeps the wire's own
    // close event from re-arming it.
    this.stopKeepalive();
    this.cancelReconnect();
    this.cancelResubscribeRetries();
    // A dial abandoned mid-flight never settles (its listeners are muted by
    // the subclass's staleness guard), so leaving it here would have the next
    // `connect()` join a promise that can never resolve.
    this.dialInFlight = null;
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
          // MCP convention — see ADR 33 §wire/cancellation. Best-effort: the
          // caller already has its answer (the reject below), and a wire that
          // cannot carry the courtesy notification must not turn an abort
          // into an unhandled rejection.
          void this.sendNotification("notifications/cancelled", {
            requestId: id,
            reason: "aborted",
          }).catch(() => {});
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
    // THE CLIENT allocates the id, and the server adopts it. Both registrations
    // below therefore happen under the FINAL id, before `dispatchSubscribeFrame`
    // writes the request — which is the whole mechanism: a frame that overtakes
    // the response finds its stream in `subscriptionStreams` (routable, not
    // dropped) AND its `activeSubscriptions` entry, which is where
    // `routeNotification` records `lastCursor`, so even a pre-response frame
    // leaves cursor tracking correct for the next reconnect.
    const subscriptionId = `sub-${this.id}-${this.nextRequestId++}`;
    const stream = new MultiplexedStream<EventFrame>(subscriptionId, async () => {
      this.subscriptionStreams.delete(subscriptionId);
      this.activeSubscriptions.delete(subscriptionId);
      this.clearResubscribeTimer(subscriptionId);
      if (this.currentState === "open") {
        try {
          await this.request("sub/unsubscribe", { subscriptionId });
        } catch {
          /* swallow */
        }
      }
    });
    this.subscriptionStreams.set(subscriptionId, stream);
    this.activeSubscriptions.set(subscriptionId, { stream, scope, query, lastCursor: fromCursor });

    this.dispatchSubscribeFrame({ subscriptionId, scope, query, fromCursor }, (error) => {
      // A subscription the server never acknowledged receives nothing, ever.
      // Ending the stream is what turns a permanent silent hang into an error
      // the caller's `for await` can act on; dropping both registrations is
      // what keeps a reconnect from reviving it.
      this.subscriptionStreams.delete(subscriptionId);
      this.activeSubscriptions.delete(subscriptionId);
      void stream.end(error);
    });

    return Object.assign(stream, { subscriptionId });
  }

  /**
   * Issue a `sub/subscribe` RPC whose only outcome is FAILURE. Success needs no
   * callback: `params.subscriptionId` is the id the caller already registered
   * its stream under, so there is nothing left to learn from the response but
   * that the server honored it.
   *
   * That is what replaced this method's original job. It used to re-key the
   * stream from a tentative client id to a server-allocated one, and to do it
   * SYNCHRONOUSLY inside `routeResponse` — because a WS library emits 'message'
   * events synchronously via `EventEmitter.emit()` with no microtask drain
   * between them, so a `.then()` re-key ran after any same-tick
   * `[subscribe-response, event, event]` burst had already missed the lookup.
   * The re-key is gone with the tentative id, and so is the defence: ordering
   * is now irrelevant by construction rather than raced against. It had to be —
   * the defence only ever worked where the response and the notifications share
   * one ordered channel, which over `@agentick/transport-http` (POST body vs. a
   * separate SSE GET) they do not.
   *
   * The failure path stays, and stays load-bearing: nobody awaits this RPC, so
   * a subscribe that fails and says nothing is a stream that hangs for the life
   * of the process. An echo that does not match what was sent counts as a
   * failure — the server broke the adoption contract, and no frame it sends
   * afterwards will route.
   */
  private dispatchSubscribeFrame(
    params: SubscribeParams,
    onFailed: (error: TransportError & Error) => void,
  ): void {
    if (this.currentState !== "open") {
      onFailed(
        transportError({
          kind: "connection",
          message: `cannot subscribe: transport ${this.id} is not open (state: ${describeState(this.currentState)})`,
        }),
      );
      return;
    }

    const id = this.nextRequestId++ as JsonRpcId;
    const frame: JsonRpcFrame = {
      jsonrpc: "2.0",
      id,
      method: "sub/subscribe",
      params: params as unknown,
    };

    this.pending.set(id, {
      resolve: (res: unknown) => {
        const echoed = (res as { subscriptionId?: string } | null | undefined)?.subscriptionId;
        if (echoed === params.subscriptionId) return; // adopted — nothing to do
        onFailed(
          transportError({
            kind: "protocol",
            message: `subscribe response echoed subscriptionId ${JSON.stringify(echoed)} — expected ${JSON.stringify(params.subscriptionId)}`,
            cause: res,
          }),
        );
      },
      // Nobody awaits this Promise, which is exactly why the rejection has to
      // go somewhere: a subscribe that fails and says nothing is a stream that
      // hangs for the life of the process.
      reject: (err: unknown) => onFailed(toTransportError(err)),
    });

    // `sendFrame` is `void | Promise<void>` — HTTP POSTs it. Both a
    // synchronous throw and a rejected promise have to reach `onFailed`, or a
    // wire-write failure becomes another silent permanent hang (and, for the
    // promise, an unhandled rejection).
    try {
      const written = this.sendFrame(frame);
      if (written instanceof Promise) {
        void written.catch((err: unknown) => {
          if (!this.pending.delete(id)) return; // already settled by a response
          onFailed(toTransportError(err));
        });
      }
    } catch (err) {
      this.pending.delete(id);
      onFailed(toTransportError(err));
    }
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
   * **Reporting the same dead wire twice is harmless, by construction.** A
   * second report arrives while a dial is already scheduled, and this method
   * returns early on exactly that condition — otherwise the second
   * `scheduleReconnect` would overwrite `reconnectTimer` and orphan the timer
   * already counting down, leaving two competing dial loops. Two reports for
   * one death is not exotic: {@link declareWireDead} reports a wire the socket
   * will ALSO report a moment later via its close event, and a failed dial
   * surfaces both as a rejected promise ({@link onDialFailed}) and as a close
   * event. Subclasses still drop events from a wire they no longer hold — see
   * the staleness guards in the WS and UDS `openSocket`, and HTTP's
   * `signal.aborted` check — because a zombie's events must not disturb the
   * healthy connection that replaced it; but the dial loop no longer depends
   * on their getting the count exactly right.
   */
  protected handleConnectionDrop(cause?: TransportError): void {
    this.stopKeepalive();
    // Nothing can be resubscribed on a wire that is gone; the reconnect owns
    // recovery, and `resubscribeAfterReconnect` starts a fresh campaign on the
    // way back.
    this.cancelResubscribeRetries();

    const failure = transportError(cause ?? { kind: "closed", message: "wire closed mid-request" });
    for (const p of this.pending.values()) p.reject(failure);
    this.pending.clear();

    // A PROGRESS stream cannot survive this, and — unlike a subscription — it
    // cannot be re-opened either: its `progressToken` names one in-flight
    // operation on a connection that is gone, and no verb re-attaches to it.
    // So the wire drop is the last thing that will ever happen to it, and
    // saying nothing leaves the consumer's `for await` blocked on a stream
    // that will not produce another frame or a `done` for the life of the
    // process. That is a UI stuck rendering a turn forever: the send's own RPC
    // rejects here with everything else in `pending`, but a caller consuming
    // `events()` is not awaiting that promise — it is awaiting this iterator.
    //
    // Ended with the failure rather than cleanly, because the two are not the
    // same fact and the consumer acts differently on them: a clean end means
    // the operation finished, and this one means the stream died while the
    // operation may well still be RUNNING on the server. The honest recovery
    // is to reconnect and re-read what it committed — which a consumer can
    // only choose if it was told which of the two happened.
    for (const stream of this.progressStreams.values()) void stream.end(failure);
    this.progressStreams.clear();

    // A dial is ALREADY scheduled, so this wire's death is old news: while the
    // backoff timer counts down there is no wire, and the only thing that can
    // report one dying is a zombie or a second reporter for the same death (a
    // failed dial that surfaces both as a rejected promise and as a `close`
    // event). Re-arming would overwrite `reconnectTimer` and orphan the timer
    // already counting down — two dial loops, one of them invisible. Note this
    // is NOT a latch: an in-flight dial clears the timer before it runs, so a
    // drop during a dial still arms the next attempt.
    if (this.reconnectTimer !== null) return;

    if (this.explicitClose) {
      this.setState("closed");
      return;
    }
    if (!this.reconnectPolicy.enabled) {
      this.setState("closed");
      return;
    }
    if (this.reconnectAttempts >= this.reconnectPolicy.maxAttempts) {
      // TERMINAL, and deliberately loud: `maxAttempts` is `Infinity` by
      // default, so reaching this line means an adopter asked for a finite
      // budget and spent it. The `failed` state is the only signal that the
      // transport has stopped trying — nothing else fires afterwards.
      this.setState({
        kind: "failed",
        error: {
          kind: "connection",
          message: `reconnect attempts exhausted after ${this.reconnectAttempts} dial(s); transport ${this.id} has stopped trying (reconnect.maxAttempts = ${this.reconnectPolicy.maxAttempts})`,
        },
      });
      return;
    }
    this.scheduleReconnect();
  }

  /**
   * Arm the dial loop for a dial that failed WITHOUT the wire reporting it.
   * No-ops when the wire's own failure path already got there (the common
   * case: a WS `close` event runs `handleConnectionDrop` synchronously before
   * the dial promise settles), when the caller closed deliberately, when a
   * later dial already won, or when the loop is already terminal.
   */
  private armLoopAfterFailedDial(): void {
    if (this.explicitClose) return;
    if (this.currentState === "open") return;
    if (isClientStateFailed(this.currentState)) return;
    // Already armed — either mid-backoff or a timer is pending.
    if (this.reconnectTimer !== null || this.currentState === "reconnecting") return;
    this.handleConnectionDrop({ kind: "connection", message: "dial failed" });
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
    // A probe that rejects must not take the interval — or, under Node's
    // default unhandled-rejection policy, the process — with it. The probe
    // handles its own wire failures; this catch is for the ones it can't
    // (a `discardWire` that throws, a listener that throws under `setState`).
    const timer = setInterval(() => void this.probeLiveness().catch(() => {}), intervalMs);
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
    try {
      this.discardWire();
    } catch {
      // Releasing a wire that is already unusable is best-effort. What must
      // not happen is the throw skipping the drop path below and leaving the
      // transport parked in `open` on a wire nobody is listening to.
    }
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
    const generation = ++this.dialGeneration;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // `dial()` is single-flight and never throws synchronously — a subclass
      // whose `openConnection` throws would otherwise escape this timer
      // callback as an uncaught exception, taking the loop (and, under Node's
      // default policy, the process) with it. It also joins a dial an adopter's
      // own `connect()` already has in flight rather than opening a second
      // socket beside it.
      void this.dial().catch((err: unknown) => this.onDialFailed(generation, err));
    }, delay);
  }

  /**
   * A dial armed by the backoff loop failed. The wire's own close event
   * normally reports this and re-arms the loop, which is why the failure is
   * not rethrown — but "normally" is not "always": a dial that fails before
   * there is a socket to close reports nothing, and a loop that stops because
   * nobody told it to continue is precisely the never-reconnects bug.
   *
   * So the loop re-arms itself here, guarded by a `dialGeneration` stamp: the
   * close path bumps the generation on its way through `scheduleReconnect`, so
   * whichever path gets there first wins and the other becomes a no-op. That
   * is what keeps two competing dial loops (and the orphaned timer they leave
   * behind) from being the cure for the wedge.
   */
  private onDialFailed(generation: number, _error: unknown): void {
    if (generation !== this.dialGeneration) return; // superseded by another arm
    if (this.reconnectTimer !== null) return; // the wire's path already re-armed
    if (this.currentState === "open") return; // a later dial won
    if (this.explicitClose) return;
    if (isClientStateFailed(this.currentState)) return; // budget already spent
    this.handleConnectionDrop({ kind: "connection", message: "reconnect dial failed" });
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
    // The id survives the reconnect: it was the client's to begin with, so the
    // new wire re-opens the SAME subscription and both registries stay as they
    // are. Snapshot anyway — a failure callback can fire synchronously and
    // delete the entry being iterated.
    for (const [subscriptionId, sub] of [...this.activeSubscriptions]) {
      // A fresh wire starts a fresh campaign: the grace window is measured
      // from the reconnect, not from whatever a previous one spent.
      this.clearResubscribeTimer(subscriptionId);
      sub.resubscribeStartedAt = Date.now();
      sub.resubscribeAttempts = 0;
      this.sendResubscribe(subscriptionId, sub);
    }
  }

  /**
   * One resubscribe attempt. Runs inside the subclass's `open` handler (or a
   * retry timer) — a throw there would abort that handler, leaving
   * `connect()`'s promise unsettled and, on a socket-event path, surfacing as
   * an uncaught exception. One bad subscription must not cost the connection.
   */
  private sendResubscribe(subscriptionId: string, sub: ActiveSubscription): void {
    try {
      this.dispatchSubscribeFrame(
        { subscriptionId, scope: sub.scope, query: sub.query, fromCursor: sub.lastCursor },
        (error) => this.onResubscribeFailed(subscriptionId, sub, error),
      );
    } catch (err) {
      this.onResubscribeFailed(subscriptionId, sub, toTransportError(err));
    }
  }

  /**
   * A subscription did not survive the reconnect. Which of the two things that
   * means is decided by the failure:
   *
   *   - The WIRE went again (`connection` / `closed` / `timeout`). Nothing is
   *     wrong with the subscription, so it stays registered under its id and
   *     the NEXT successful reconnect resubscribes it. Deleting it here —
   *     which is what the pre-#263 code did by removing it before the response
   *     arrived — is how a subscription disappears permanently after a drop
   *     that happens to land mid-resubscribe.
   *   - The SERVER refused it (`rpc`) or answered something unusable
   *     (`protocol`). Redialing will not change that answer, and a consumer
   *     blocked on `for await` would wait forever, so the stream ends with the
   *     reason.
   *
   *   - The peer does not HAVE the scope (`AppNotFound` / `SessionNotFound`).
   *     Between the two above: the answer is final for this instant and very
   *     likely wrong a moment later, because a gateway that just restarted
   *     answers exactly this way until the adopter's create-or-resume has run.
   *     Retried on the backoff curve for `resubscribeGraceMs`, then ended with
   *     the error like any other refusal.
   *
   * TODO(wire-resume): the honest fix for the first case is server-side resume
   * (`ServerCapabilities.cursorResume` is still false — see the
   * `TODO(wire-resume)` trailhead in `@agentick/gateway`). Until a server can
   * replay from a cursor, a subscription that survives a drop can still MISS
   * events emitted while the wire was down; only its liveness is restored here,
   * not its continuity.
   */
  private onResubscribeFailed(
    subscriptionId: string,
    sub: ActiveSubscription,
    error: TransportError & Error,
  ): void {
    // Transient — left registered for the next reconnect, `lastCursor`
    // untouched, so the retry still asks from where the consumer left off.
    if (error.kind !== "rpc" && error.kind !== "protocol") return;
    if (isScopeMissing(error) && this.withinResubscribeGrace(sub)) {
      this.scheduleResubscribeRetry(subscriptionId, sub);
      return;
    }
    this.clearResubscribeTimer(subscriptionId);
    this.activeSubscriptions.delete(subscriptionId);
    this.subscriptionStreams.delete(subscriptionId);
    void sub.stream.end(error);
  }

  /** Is this campaign still inside `ReconnectPolicy.resubscribeGraceMs`? */
  private withinResubscribeGrace(sub: ActiveSubscription): boolean {
    const grace = this.reconnectPolicy.resubscribeGraceMs;
    if (!Number.isFinite(grace)) return grace > 0;
    if (grace <= 0) return false;
    return Date.now() - (sub.resubscribeStartedAt ?? Date.now()) < grace;
  }

  /**
   * Ask again, later, on the same backoff curve the dial loop uses. Guarded at
   * fire time rather than at schedule time: the wire can go again, and the
   * consumer can walk away, between arming this and its firing.
   */
  // TODO(subscription-observability): a subscription that is mid-campaign is
  // indistinguishable from a healthy one from outside — the stream is simply
  // quiet, and the only report is the stream ENDING if the grace window
  // expires. `ClientEvent`'s `subscription` surface is the declared home for
  // this (`ClientEventSurfaces` in `@agentick/spec`) and still has no live
  // source; the emit sites are here and in `subscribe`/`onResubscribeFailed`.
  private scheduleResubscribeRetry(subscriptionId: string, sub: ActiveSubscription): void {
    const attempt = sub.resubscribeAttempts ?? 0;
    sub.resubscribeAttempts = attempt + 1;
    this.clearResubscribeTimer(subscriptionId);
    const timer = setTimeout(() => {
      this.resubscribeTimers.delete(subscriptionId);
      // The wire owns recovery once it is gone; the reconnect starts a fresh
      // campaign on the way back.
      if (this.currentState !== "open") return;
      // The consumer stopped iterating — its `onClose` reaped the registration
      // and there is nothing left to re-open.
      if (!this.activeSubscriptions.has(subscriptionId)) return;
      this.sendResubscribe(subscriptionId, sub);
    }, this.computeResubscribeBackoff(attempt));
    (timer as { unref?: () => void }).unref?.();
    this.resubscribeTimers.set(subscriptionId, timer);
  }

  /**
   * The dial curve, capped short. A resubscribe is one small frame on a wire
   * that is already UP, so it has none of the reasons a dial backs off toward
   * 30s — and at the dial's cap a 30s grace window would be spent in two or
   * three attempts, which is not a window at all.
   */
  private computeResubscribeBackoff(attempt: number): number {
    return computeFullJitterBackoff(attempt, {
      initialDelayMs: this.reconnectPolicy.initialDelayMs,
      maxDelayMs: Math.min(this.reconnectPolicy.maxDelayMs, RESUBSCRIBE_MAX_DELAY_MS),
    });
  }

  private clearResubscribeTimer(subscriptionId: string): void {
    const timer = this.resubscribeTimers.get(subscriptionId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.resubscribeTimers.delete(subscriptionId);
  }

  private cancelResubscribeRetries(): void {
    for (const timer of this.resubscribeTimers.values()) clearTimeout(timer);
    this.resubscribeTimers.clear();
  }
}

/**
 * Did the peer answer "I do not have that scope"? The one refusal that is
 * routinely a RACE rather than a verdict — a gateway that restarted says it
 * about every session it is about to rebuild.
 */
function isScopeMissing(error: TransportError): boolean {
  if (error.kind !== "rpc") return false;
  const code = error.error.code;
  return code === ErrorCode.AppNotFound || code === ErrorCode.SessionNotFound;
}
