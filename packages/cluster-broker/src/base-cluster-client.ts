/**
 * `BaseClusterClient` — wire-agnostic `ClusterTransport` impl.
 *
 * Concrete wire packages (@agentick/cluster-net for TCP/Unix, @agentick/cluster-ws
 * for WebSocket) construct one of these per node, plugging in a
 * `Connector` that knows how to open a `Connection` over the chosen
 * wire. This class owns everything wire-agnostic:
 *
 *   - Handshake (Hello → Welcome)
 *   - Heartbeat (custom ping/pong; miss-N = dead connection)
 *   - Reconnect with exponential backoff + full jitter
 *   - Subscription registry + auto-re-subscribe on reconnect
 *   - Outbound queueing semantics (fail-fast while disconnected)
 *   - Frame parsing + dispatch
 *
 * Diagnostics: emitted via the optional `onDiagnostic` callback
 * (wire impls bridge this into `@agentick/cluster`'s `DiagnosticEmitter`
 * over the parent's local bus). The base never imports `EventBus`
 * directly — keeps it framework-substrate-agnostic.
 *
 * Conformance: the resulting transport satisfies
 * `runClusterTransportConformance` from `@agentick/cluster` once
 * paired with a real wire impl (validated end-to-end in Phase 4b).
 */

import type {
  AddressFilter,
  ClusterCodec,
  ClusterTransport,
  EventFilter,
  MembershipChange,
  NodeId,
} from "@agentick/cluster";
import type { EventEnvelope, MessageEnvelope } from "@agentick/spec";
import { matchesAddressFilter, matchesEventFilter, ulid } from "@agentick/utils";

import { adaptClusterCodec, type BrokerCodec } from "./broker-codec.js";
import type { Connection, Connector } from "./connection.js";
import {
  FRAME_BROADCAST,
  FRAME_BUS_DELIVER,
  FRAME_ERROR,
  FRAME_GOODBYE,
  FRAME_HELLO,
  FRAME_INBOX_DELIVER,
  FRAME_MEMBERSHIP,
  FRAME_PING,
  FRAME_PONG,
  FRAME_SEND,
  FRAME_SUBSCRIBE_ACK,
  FRAME_SUBSCRIBE_BUS,
  FRAME_SUBSCRIBE_INBOX,
  FRAME_UNSUBSCRIBE,
  FRAME_WELCOME,
  isFrameShape,
  type AnyFrame,
  type BrokerFrame,
  type ClientFrame,
} from "./wire-frames.js";

// ============================================================================
// Options
// ============================================================================

export interface BaseClusterClientOptions {
  readonly nodeId: NodeId;
  readonly connector: Connector;
  /**
   * Codec for serializing frames to bytes. Concrete wire impls pass
   * either the bundled JSON codec (`jsonCodec()`) or a swap-in
   * MessagePack/protobuf codec from a `@agentick/cluster-codec-*` package.
   */
  readonly codec: ClusterCodec;
  /**
   * Heartbeat ping interval in ms. Default: 30_000.
   * Missing N consecutive pongs (default 3) is treated as a dead
   * connection — triggers Connection close + reconnect cycle.
   */
  readonly heartbeatMs?: number;
  /** Number of consecutive missed pongs before declaring dead. Default: 3. */
  readonly missedPongLimit?: number;
  /**
   * Reconnect backoff knobs. Defaults mirror `@agentick/transport`:
   *   - initial 500 ms, doubling each attempt, capped at 30_000 ms,
   *   - full jitter (random 0..delay).
   */
  readonly reconnect?: {
    readonly initialMs?: number;
    readonly maxMs?: number;
    /**
     * Max reconnect attempts before giving up. 0 / undefined = unlimited.
     */
    readonly maxAttempts?: number;
  };
  /**
   * Diagnostic emitter. Concrete wire impls bridge this into
   * `@agentick/cluster`'s `DiagnosticEmitter` over the parent's local bus.
   * Omitted → diagnostics are silently discarded (testable mode).
   */
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
  /**
   * Override `Math.random()` for full-jitter calculation. Tests pass
   * a deterministic value to remove backoff flakiness.
   */
  readonly random?: () => number;
}

// ============================================================================
// Internal state
// ============================================================================

type ConnState =
  | { readonly tag: "disconnected" }
  | { readonly tag: "connecting" }
  | { readonly tag: "handshaking"; readonly conn: Connection }
  | { readonly tag: "connected"; readonly conn: Connection }
  | { readonly tag: "closed" };

interface InboxSubscription {
  readonly subId: string;
  readonly filter: AddressFilter;
  readonly handler: (env: MessageEnvelope) => void;
}

interface BusSubscription {
  readonly subId: string;
  readonly filter: EventFilter;
  readonly handler: (env: EventEnvelope) => void;
}

// ============================================================================
// BaseClusterClient
// ============================================================================

export class BaseClusterClient implements ClusterTransport {
  private readonly nodeId: NodeId;
  private readonly connector: Connector;
  private readonly codec: BrokerCodec;
  private readonly heartbeatMs: number;
  private readonly missedPongLimit: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly reconnectMaxAttempts: number;
  private readonly onDiagnostic: (name: string, payload?: unknown) => void;
  private readonly random: () => number;

  private state: ConnState = { tag: "disconnected" };
  /**
   * Reconnect attempts across the lifetime of the client. Lives on
   * the instance rather than inside the state machine so it survives
   * the transient `connecting` state between attempts. Pre-Phase-4a.1
   * the counter was reset on every `disconnected → connecting`
   * transition — infinite-retry bug that the give-up test caught.
   */
  private reconnectAttempts = 0;
  /** Current backoff delay; doubles on each failure up to reconnectMaxMs. */
  private currentBackoffMs = 0;

  private readonly inboxSubs = new Map<string, InboxSubscription>();
  private readonly busSubs = new Map<string, BusSubscription>();

  /**
   * Cluster membership as last reported by the broker. Updated by
   * the initial Welcome snapshot and subsequent Membership delta
   * frames. Membership consumers (e.g., the membership seam from
   * @agentick/cluster-net) subscribe via {@link onMembershipChange} +
   * read the snapshot via {@link nodes}.
   */
  private memberNodes = new Set<NodeId>();
  private readonly membershipHandlers = new Set<(change: MembershipChange) => void>();

  /**
   * Per-pending-subscription Promise + resolver pair. When the
   * broker echoes back {@link FRAME_SUBSCRIBE_ACK}, the resolver
   * fires and the entry is dropped. {@link flush} awaits every
   * pending Promise — the call returns only after every in-flight
   * subscription has been recorded at the broker.
   */
  private readonly pendingSubscribeAcks = new Map<
    string,
    { readonly promise: Promise<void>; readonly resolve: () => void }
  >();

  /** Heartbeat machinery. Reset on every (re-)connect. */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private nextPingSeq = 0;
  private outstandingPings = 0;

  /** Reconnect deferred timer. Tracked so close() can cancel cleanly. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Resolves on the first successful handshake (Welcome received).
   * Adopters waiting for "client is actually connected" await this
   * — without it the only signal is the diagnostic stream.
   * Re-resolves with the same value across the client's lifetime;
   * it does NOT reset on reconnect (the contract is "we made it
   * online at least once").
   */
  private readyResolve: ((value: void) => void) | null = null;
  /** @see {@link ready} */
  readonly ready: Promise<void>;

  constructor(opts: BaseClusterClientOptions) {
    this.nodeId = opts.nodeId;
    this.connector = opts.connector;
    this.codec = adaptClusterCodec(opts.codec);
    this.heartbeatMs = opts.heartbeatMs ?? 30_000;
    this.missedPongLimit = opts.missedPongLimit ?? 3;
    this.reconnectInitialMs = opts.reconnect?.initialMs ?? 500;
    this.reconnectMaxMs = opts.reconnect?.maxMs ?? 30_000;
    this.reconnectMaxAttempts = opts.reconnect?.maxAttempts ?? 0;
    this.onDiagnostic = opts.onDiagnostic ?? (() => {});
    this.random = opts.random ?? Math.random;

    this.ready = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });
    this.currentBackoffMs = this.reconnectInitialMs;

    // Kick off the first connect on next microtask so subscribers
    // registered immediately after construction don't race with the
    // handshake.
    queueMicrotask(() => {
      void this.connectLoop();
    });
  }

  // ==========================================================================
  // Public diagnostics surface
  // ==========================================================================

  /**
   * Connection-state tag, for tests + adopter health checks.
   * (`disconnected` / `connecting` / `handshaking` / `connected` /
   * `closed`.) Adopters who want a stable Promise-shaped "are we
   * online?" signal use {@link ready}.
   */
  get connectionState(): ConnState["tag"] {
    return this.state.tag;
  }

  /**
   * Snapshot of currently-known cluster nodes (per the broker's
   * last membership update). Used by the membership seam paired
   * with this client; also exposed for adopter diagnostics.
   */
  nodes(): readonly NodeId[] {
    return [...this.memberNodes];
  }

  /**
   * Register a handler for cluster membership changes. The handler
   * fires for:
   *   - The initial snapshot extracted from the Welcome frame
   *     (kind: "snapshot")
   *   - Every subsequent membership delta from the broker
   *     (joined / lost)
   *
   * The returned function detaches. Multiple handlers may attach;
   * each receives every event.
   */
  onMembershipChange(handler: (change: MembershipChange) => void): () => void {
    this.membershipHandlers.add(handler);
    return () => {
      this.membershipHandlers.delete(handler);
    };
  }

  // ==========================================================================
  // ClusterTransport surface
  // ==========================================================================

  async send(toNode: NodeId, env: MessageEnvelope): Promise<void> {
    await this.writeOrFail({ type: FRAME_SEND, toNode, envelope: env });
  }

  async broadcast(env: EventEnvelope): Promise<void> {
    await this.writeOrFail({ type: FRAME_BROADCAST, envelope: env });
  }

  subscribeInbox(
    filter: AddressFilter,
    onMessage: (env: MessageEnvelope) => void,
  ): () => Promise<void> {
    // Phase 4b: the subscribe-before-send race is resolved via the
    // broker's SUBSCRIBE_ACK round-trip. subscribeInbox returns
    // synchronously (preserving the ergonomic ClusterTransport
    // contract); adopters that need ordering call `transport.flush()`
    // before issuing work that should land on the subscriber.
    const subId = ulid();
    const sub: InboxSubscription = { subId, filter, handler: onMessage };
    this.inboxSubs.set(subId, sub);
    this.trackPendingAck(subId);
    void this.tryWriteIgnoringDisconnect({
      type: FRAME_SUBSCRIBE_INBOX,
      subId,
      filter,
    });
    return async () => {
      if (!this.inboxSubs.delete(subId)) return;
      this.resolvePendingAck(subId); // drop any stale pending entry
      await this.tryWriteIgnoringDisconnect({ type: FRAME_UNSUBSCRIBE, subId });
    };
  }

  subscribeBus(filter: EventFilter, onEvent: (env: EventEnvelope) => void): () => Promise<void> {
    // Same subscribe-ack mechanism as subscribeInbox.
    const subId = ulid();
    const sub: BusSubscription = { subId, filter, handler: onEvent };
    this.busSubs.set(subId, sub);
    this.trackPendingAck(subId);
    void this.tryWriteIgnoringDisconnect({
      type: FRAME_SUBSCRIBE_BUS,
      subId,
      filter,
    });
    return async () => {
      if (!this.busSubs.delete(subId)) return;
      this.resolvePendingAck(subId);
      await this.tryWriteIgnoringDisconnect({ type: FRAME_UNSUBSCRIBE, subId });
    };
  }

  /**
   * Resolve when every in-flight subscription registration has
   * been acknowledged by the broker. Implements the
   * `ClusterTransport.flush()` contract — adopters use this after
   * a subscribe and before triggering work that should land on the
   * new subscriber.
   *
   * Idempotent and cheap when nothing is pending.
   */
  async flush(): Promise<void> {
    if (this.pendingSubscribeAcks.size === 0) return;
    // Snapshot the pending Promises and await them. Each entry's
    // resolver fires from applySubscribeAck when the broker echoes
    // back SUBSCRIBE_ACK; multiple concurrent flush() callers share
    // the same Promise so they all unblock together.
    const promises = [...this.pendingSubscribeAcks.values()].map((e) => e.promise);
    await Promise.all(promises);
  }

  async close(): Promise<void> {
    if (this.state.tag === "closed") return;
    // Stop heartbeat + cancel any pending reconnect FIRST so they
    // don't fire during teardown.
    this.stopHeartbeat();
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Unblock any flush() callers — close means no more wire
    // round-trips, so pending subscriptions will never be acked.
    for (const [, entry] of this.pendingSubscribeAcks) entry.resolve();
    this.pendingSubscribeAcks.clear();
    const prior = this.state;
    this.state = { tag: "closed" };
    if (prior.tag === "connected" || prior.tag === "handshaking") {
      // Best-effort goodbye on the way out. Failures are silent —
      // the connection is closing anyway.
      try {
        await this.writeFrameRaw(prior.conn, { type: FRAME_GOODBYE });
      } catch {
        // ignore
      }
      await prior.conn.close();
    }
    this.onDiagnostic("cluster:broker:client:closed", { nodeId: this.nodeId });
  }

  // ==========================================================================
  // Connection lifecycle
  // ==========================================================================

  private async connectLoop(): Promise<void> {
    if (this.state.tag === "closed") return;
    this.state = { tag: "connecting" };
    this.onDiagnostic("cluster:broker:client:connecting", {
      nodeId: this.nodeId,
      target: this.connector.target,
    });
    let conn: Connection;
    try {
      conn = await this.connector.connect();
    } catch (cause) {
      this.onDiagnostic("cluster:broker:client:connect-failed", {
        nodeId: this.nodeId,
        target: this.connector.target,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      this.scheduleReconnect();
      return;
    }
    if ((this.state as ConnState).tag === "closed") {
      await conn.close();
      return;
    }
    this.state = { tag: "handshaking", conn };
    conn.onMessage((bytes) => this.onInbound(bytes));
    conn.onClose((reason) => this.onConnectionClosed(reason));
    try {
      await this.writeFrameRaw(conn, {
        type: FRAME_HELLO,
        nodeId: this.nodeId,
      });
    } catch (cause) {
      this.onDiagnostic("cluster:broker:client:handshake-failed", {
        nodeId: this.nodeId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      await conn.close();
      this.scheduleReconnect();
    }
    // We stay in `handshaking` until Welcome arrives in onInbound.
  }

  private onConnectionClosed(reason: string): void {
    if (this.state.tag === "closed") return;
    this.stopHeartbeat();
    this.onDiagnostic("cluster:broker:client:disconnected", {
      nodeId: this.nodeId,
      reason,
    });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.state.tag === "closed") return;
    // TODO(phase-4b): "fast first retry" — TCP production deployments
    // typically want a 0ms first reattempt (transient network blip)
    // before backoff kicks in. Currently the first reconnect uses
    // currentBackoffMs = reconnectInitialMs (default 500ms) which
    // adds latency for the common case. Consider: if attempts === 1,
    // schedule with 0ms; otherwise apply backoff.
    this.reconnectAttempts += 1;
    if (this.reconnectMaxAttempts > 0 && this.reconnectAttempts > this.reconnectMaxAttempts) {
      this.onDiagnostic("cluster:broker:client:reconnect-gave-up", {
        nodeId: this.nodeId,
        attempts: this.reconnectAttempts - 1,
        maxAttempts: this.reconnectMaxAttempts,
      });
      this.state = { tag: "closed" };
      return;
    }
    // Full jitter — uniform [0, currentBackoffMs). Standard practice
    // for backoff; reduces thundering-herd reconnect storms.
    const jittered = Math.floor(this.random() * this.currentBackoffMs);
    this.currentBackoffMs = Math.min(this.currentBackoffMs * 2, this.reconnectMaxMs);
    this.state = { tag: "disconnected" };
    this.onDiagnostic("cluster:broker:client:reconnect-scheduled", {
      nodeId: this.nodeId,
      attempt: this.reconnectAttempts,
      delayMs: jittered,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connectLoop();
    }, jittered);
  }

  // ==========================================================================
  // Frame I/O
  // ==========================================================================

  private async onInbound(bytes: Uint8Array): Promise<void> {
    let frame: unknown;
    try {
      frame = this.codec.decode(bytes);
    } catch (cause) {
      this.onDiagnostic("cluster:broker:client:frame-decode-failed", {
        nodeId: this.nodeId,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    if (!isFrameShape(frame)) {
      this.onDiagnostic("cluster:broker:client:frame-malformed", { nodeId: this.nodeId });
      return;
    }
    await this.dispatchFrame(frame);
  }

  private async dispatchFrame(frame: AnyFrame): Promise<void> {
    switch (frame.type) {
      case FRAME_WELCOME:
        await this.onWelcome(frame.nodes);
        return;
      case FRAME_INBOX_DELIVER:
        this.dispatchInboxDeliver(frame.envelope);
        return;
      case FRAME_BUS_DELIVER:
        this.dispatchBusDeliver(frame.envelope);
        return;
      case FRAME_MEMBERSHIP:
        this.applyMembershipDelta(frame.change);
        return;
      case FRAME_SUBSCRIBE_ACK:
        this.resolvePendingAck(frame.subId);
        return;
      case FRAME_PING:
        // Reply to broker-initiated heartbeat.
        await this.tryWriteIgnoringDisconnect({ type: FRAME_PONG, seq: frame.seq });
        return;
      case FRAME_PONG:
        this.outstandingPings = 0;
        return;
      case FRAME_ERROR:
        this.onDiagnostic("cluster:broker:client:broker-error", {
          nodeId: this.nodeId,
          reason: frame.reason,
          correlationId: frame.correlationId,
        });
        return;
      case FRAME_GOODBYE:
        // Broker is going down. Close cleanly; reconnect loop will
        // retry per backoff.
        if (this.state.tag === "connected" || this.state.tag === "handshaking") {
          await this.state.conn.close();
        }
        return;
      default:
        // Unexpected client-bound frame (e.g., the broker mistakenly
        // sending a SEND back). Drop with diagnostic.
        this.onDiagnostic("cluster:broker:client:unexpected-frame", {
          nodeId: this.nodeId,
          frameType: (frame as { type: string }).type,
        });
        return;
    }
  }

  private async onWelcome(welcomedNodes: readonly NodeId[]): Promise<void> {
    if (this.state.tag !== "handshaking") {
      // Welcome after we transitioned out of handshaking — could be a
      // late-arriving frame from a previous connection. Ignore.
      return;
    }
    const conn = this.state.conn;
    this.state = { tag: "connected", conn };
    // Reset backoff so a future drop starts fresh — long-lived
    // clients survive arbitrarily-many transient disconnects.
    this.reconnectAttempts = 0;
    this.currentBackoffMs = this.reconnectInitialMs;
    // Apply the initial membership snapshot from Welcome. Subsequent
    // Membership delta frames update incrementally.
    this.memberNodes = new Set(welcomedNodes);
    this.fireMembershipChange({
      kind: "snapshot",
      nodes: [...welcomedNodes],
      at: new Date().toISOString(),
    });
    this.startHeartbeat();
    this.onDiagnostic("cluster:broker:client:connected", { nodeId: this.nodeId });
    // Resolve the `ready` Promise on first successful handshake.
    // Subsequent reconnects don't re-create the Promise (the contract
    // is "we made it online at least once") — adopters watching the
    // diagnostic stream see reconnect transitions.
    if (this.readyResolve) {
      this.readyResolve();
      this.readyResolve = null;
    }
    // Re-establish every active subscription on (re-)connect. The
    // wire registry on the broker is per-connection; new connection
    // = fresh registry. Each re-subscribe gets a fresh pending-ack
    // entry so flush() after reconnect can detect when all
    // subscriptions have re-registered.
    for (const sub of this.inboxSubs.values()) {
      this.trackPendingAck(sub.subId);
      await this.tryWriteIgnoringDisconnect({
        type: FRAME_SUBSCRIBE_INBOX,
        subId: sub.subId,
        filter: sub.filter,
      });
    }
    for (const sub of this.busSubs.values()) {
      this.trackPendingAck(sub.subId);
      await this.tryWriteIgnoringDisconnect({
        type: FRAME_SUBSCRIBE_BUS,
        subId: sub.subId,
        filter: sub.filter,
      });
    }
  }

  /**
   * Register a pending subscribe-ack for `subId`. Idempotent: if an
   * entry already exists, the existing Promise is preserved so any
   * `flush()` caller already awaiting it gets resolved when the
   * broker eventually acks.
   *
   * This matters when an adopter subscribes before the client has
   * finished its first handshake. The original subscribe write is
   * deferred until `onWelcome` re-issues it on the freshly-connected
   * socket — both call sites hit `trackPendingAck(subId)`, but the
   * Promise observed by `flush()` is the one created at subscribe
   * time, so we MUST keep it through the re-issue.
   */
  private trackPendingAck(subId: string): void {
    if (this.pendingSubscribeAcks.has(subId)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    this.pendingSubscribeAcks.set(subId, { promise, resolve });
  }

  /** Resolve a pending subscribe-ack and drop the entry. */
  private resolvePendingAck(subId: string): void {
    const entry = this.pendingSubscribeAcks.get(subId);
    if (!entry) return;
    entry.resolve();
    this.pendingSubscribeAcks.delete(subId);
  }

  /**
   * Apply a membership delta from the broker. Updates the local
   * snapshot then fires registered handlers. `snapshot` deltas
   * replace the set wholesale; `joined` / `lost` add or remove.
   */
  private applyMembershipDelta(change: MembershipChange): void {
    if (change.kind === "snapshot") {
      this.memberNodes = new Set(change.nodes);
    } else if (change.kind === "joined") {
      this.memberNodes.add(change.node);
    } else {
      // kind === "lost"
      this.memberNodes.delete(change.node);
    }
    this.fireMembershipChange(change);
  }

  private fireMembershipChange(change: MembershipChange): void {
    for (const handler of [...this.membershipHandlers]) {
      try {
        handler(change);
      } catch (cause) {
        this.onDiagnostic("cluster:broker:client:membership-handler-threw", {
          nodeId: this.nodeId,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  private dispatchInboxDeliver(env: MessageEnvelope): void {
    for (const sub of this.inboxSubs.values()) {
      if (matchesAddressFilter(sub.filter, env.addressedTo)) {
        try {
          sub.handler(env);
        } catch (cause) {
          this.onDiagnostic("cluster:broker:client:handler-threw", {
            nodeId: this.nodeId,
            subId: sub.subId,
            kind: "inbox",
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
  }

  private dispatchBusDeliver(env: EventEnvelope): void {
    for (const sub of this.busSubs.values()) {
      if (matchesEventFilter(sub.filter, env)) {
        try {
          sub.handler(env);
        } catch (cause) {
          this.onDiagnostic("cluster:broker:client:handler-threw", {
            nodeId: this.nodeId,
            subId: sub.subId,
            kind: "bus",
            reason: cause instanceof Error ? cause.message : String(cause),
          });
        }
      }
    }
  }

  // ==========================================================================
  // Outbound write helpers
  // ==========================================================================

  /**
   * Write while connected; reject if not. This is the contract for
   * `send` and `broadcast` — fail fast so adopter Effects see real
   * routing failures instead of silently buffering.
   */
  private async writeOrFail(frame: ClientFrame): Promise<void> {
    if (this.state.tag !== "connected") {
      this.onDiagnostic("cluster:broker:client:write-while-disconnected", {
        nodeId: this.nodeId,
        state: this.state.tag,
        frameType: frame.type,
      });
      throw new Error(`cluster-broker: cannot write ${frame.type} — client is ${this.state.tag}`);
    }
    await this.writeFrameRaw(this.state.conn, frame);
  }

  /**
   * Write if connected; silently no-op otherwise. Used for
   * subscribe/unsubscribe registrations — the active subscription
   * Map is the source of truth; wire registrations are best-effort
   * and re-established on every handshake.
   */
  private async tryWriteIgnoringDisconnect(frame: ClientFrame | BrokerFrame): Promise<void> {
    if (this.state.tag !== "connected" && this.state.tag !== "handshaking") return;
    try {
      await this.writeFrameRaw(this.state.conn, frame);
    } catch {
      // Best-effort — let reconnect re-establish.
    }
  }

  private async writeFrameRaw(conn: Connection, frame: AnyFrame): Promise<void> {
    // Encode goes through the centralized BrokerCodec adapter
    // (`broker-codec.ts`); the cast away from envelopes lives there
    // in one place. The TODO(phase-5) about a real typed codec also
    // lives there.
    const bytes = this.codec.encode(frame);
    await conn.send(bytes);
  }

  // ==========================================================================
  // Heartbeat
  // ==========================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    if (this.heartbeatMs <= 0) return;
    this.outstandingPings = 0;
    this.heartbeatTimer = setInterval(() => {
      void this.tickHeartbeat();
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.outstandingPings = 0;
  }

  private async tickHeartbeat(): Promise<void> {
    if (this.state.tag !== "connected") return;
    this.outstandingPings += 1;
    // Declare dead when we've accumulated `missedPongLimit` outstanding
    // pings without a pong — i.e., on the missedPongLimit-th tick, not
    // the (missedPongLimit+1)-th. README says "miss-N = dead".
    if (this.outstandingPings >= this.missedPongLimit) {
      this.onDiagnostic("cluster:broker:client:heartbeat-missed", {
        nodeId: this.nodeId,
        missed: this.outstandingPings,
        limit: this.missedPongLimit,
      });
      // Force-close the connection — onConnectionClosed kicks
      // reconnect.
      const conn = this.state.conn;
      await conn.close();
      return;
    }
    const seq = ++this.nextPingSeq;
    await this.tryWriteIgnoringDisconnect({ type: FRAME_PING, seq });
  }
}
