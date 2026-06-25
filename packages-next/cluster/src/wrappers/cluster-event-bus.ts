/**
 * `ClusterEventBus` — wraps a local {@link EventBus} with cluster-aware
 * broadcast/republish behavior.
 *
 * Composition (not inheritance):
 *   - Local appends flow to the inner bus (subscribers see them as
 *     before) AND to {@link ClusterTransport.broadcast} (so peer nodes
 *     can observe them).
 *   - Inbound remote events arrive via {@link ClusterTransport.subscribeBus};
 *     the wrapper re-injects them into the inner bus so local
 *     subscribers see them through the same source-of-truth.
 *
 * Fanout semantics:
 *   - `cluster-wide-default` — every inbound remote event is republished
 *     into the inner bus; subscribers see the cluster's combined stream.
 *   - `node-local-default` — inbound remote events are dropped at the
 *     wrapper boundary; subscribers only see events originating on this
 *     node. (Phase 3 limitation: a future per-subscription `scope:
 *     "cluster-wide"` opt-in path will let select subscribers see remote
 *     events even in node-local-default mode. For now, switch the mode
 *     if you need remote visibility.)
 *
 * Loop avoidance:
 *   - The transport contract promises "broadcast does NOT echo back to
 *     the sending node" (see conformance). As a defense-in-depth, the
 *     wrapper also drops inbound events whose `scope.nodeId === currentNode`.
 *
 * Transport failures:
 *   - `transport.broadcast` rejections emit
 *     `cluster:transport:broadcast:failed` on the local bus; the local
 *     `append` still completes successfully (the broadcast contract is
 *     best-effort). Adopters who need stricter delivery semantics
 *     subscribe to the diagnostic.
 *
 * Diagnostic events (see {@link DiagnosticEmitter}): emits
 * `cluster:wrap:installed` / `cluster:wrap:disposed` /
 * `cluster:transport:broadcast:failed`.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §6
 */

import { Effect, type Stream } from "effect";
import type {
  CompiledMatcher,
  Cursor,
  CursorEvictedError,
  EventBus,
  EventKey,
  EventQuery,
  LogMetrics,
  ProtocolEvent,
  SubscribeOptions,
} from "@agentick/spec-next";

import type { ClusterTransport } from "../transport.js";
import type { NodeId } from "../types.js";
import { DiagnosticEmitter, makeDiagnostics } from "./diagnostics.js";

export interface ClusterEventBusOptions {
  /** Inner local bus — the wrapper composes its EventBus contract from this. */
  readonly local: EventBus;
  /** Cross-node wire — outbound broadcasts and inbound subscribe. */
  readonly transport: ClusterTransport;
  /** This node's identity — stamped on outbound events; filter on inbound. */
  readonly currentNode: NodeId;
  /**
   * Cluster-wide-default — republish remote events into the local bus.
   * Node-local-default — drop remote events at the wrapper boundary.
   */
  readonly fanoutMode: "node-local-default" | "cluster-wide-default";
}

export class ClusterEventBus implements EventBus {
  private readonly local: EventBus;
  private readonly transport: ClusterTransport;
  private readonly currentNode: NodeId;
  private readonly fanoutMode: ClusterEventBusOptions["fanoutMode"];
  private readonly diag: DiagnosticEmitter;

  /** Transport-level unsubscribe; runs on close(). */
  private inboundUnsubscribe: (() => Promise<void>) | null = null;
  private closed = false;

  constructor(opts: ClusterEventBusOptions) {
    this.local = opts.local;
    this.transport = opts.transport;
    this.currentNode = opts.currentNode;
    this.fanoutMode = opts.fanoutMode;
    this.diag = makeDiagnostics({ localBus: opts.local, currentNode: opts.currentNode });

    // Wire inbound republish. The transport contract promises no
    // self-echo on broadcast; we still gate on scope.nodeId for
    // defense-in-depth.
    this.inboundUnsubscribe = this.transport.subscribeBus({}, (env) => {
      void this.onRemoteEvent(env);
    });

    this.diag.emit("cluster:wrap:installed", { kind: "bus", fanoutMode: this.fanoutMode });
  }

  // ============================================================================
  // EventLog<ProtocolEvent>
  // ============================================================================

  append(event: ProtocolEvent): Effect.Effect<void, never, never> {
    if (this.closed) return Effect.void;
    const stamped = this.stamp(event);
    return Effect.flatMap(this.local.append(stamped), () =>
      Effect.sync(() => {
        this.broadcastWithDiag(stamped);
      }),
    );
  }

  appendBatch(events: ReadonlyArray<ProtocolEvent>): Effect.Effect<void, never, never> {
    if (this.closed || events.length === 0) return Effect.void;
    const stamped = events.map((e) => this.stamp(e));
    return Effect.flatMap(this.local.appendBatch(stamped), () =>
      Effect.sync(() => {
        // Per-event broadcast — the transport's per-source FIFO
        // contract preserves order within a batch. A future
        // `transport.broadcastBatch` seam would let adapters bulk-
        // ship; tracked for Phase 4's adapter design.
        for (const e of stamped) this.broadcastWithDiag(e);
      }),
    );
  }

  read(
    cursor: Cursor,
    matcher: CompiledMatcher<ProtocolEvent>,
  ): Stream.Stream<ProtocolEvent, CursorEvictedError, never> {
    return this.local.read(cursor, matcher);
  }

  hasSubscriberFor(key: EventKey): boolean {
    return this.local.hasSubscriberFor(key);
  }

  metrics(): LogMetrics {
    return this.local.metrics();
  }

  // ============================================================================
  // Bus surface
  // ============================================================================

  publishLazy(key: EventKey, build: () => ProtocolEvent): Effect.Effect<void, never, never> {
    if (this.closed) return Effect.void;
    // In node-local-default mode, no remote node will see the event,
    // so the local short-circuit is correct.
    if (this.fanoutMode === "node-local-default" && !this.local.hasSubscriberFor(key)) {
      return Effect.void;
    }
    // In cluster-wide mode, remote subscribers MAY care. Build + append.
    // Known limitation: we can't probe remote subscriber indexes from
    // here, so this over-builds when no node has a matching subscriber.
    // Phase 5+ may gossip subscriber indexes; tracked in README.
    return this.append(build());
  }

  subscribe(
    query: EventQuery,
    options?: SubscribeOptions,
  ): Stream.Stream<ProtocolEvent, CursorEvictedError, never> {
    return this.local.subscribe(query, options);
  }

  // ============================================================================
  // Lifecycle
  // ============================================================================

  /**
   * Cooperative close. Drops the inbound transport subscription and
   * emits a final diagnostic. Idempotent.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Emit BEFORE tearing down the inbound subscription so observers
    // see the disposal even if they're inspecting via the local bus.
    this.diag.emit("cluster:wrap:disposed", { kind: "bus" });

    const unsub = this.inboundUnsubscribe;
    this.inboundUnsubscribe = null;
    if (unsub) await unsub();
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private stamp(event: ProtocolEvent): ProtocolEvent {
    if (event.scope?.nodeId === this.currentNode) return event;
    return {
      ...event,
      scope: { ...event.scope, nodeId: this.currentNode },
    };
  }

  /**
   * Best-effort broadcast with diagnostic emission on failure. The
   * surrounding local `append` already succeeded; broadcast failures
   * are reported but never bubble up.
   */
  private broadcastWithDiag(event: ProtocolEvent): void {
    void this.transport.broadcast(event).catch((cause) => {
      this.diag.emit("cluster:transport:broadcast:failed", {
        eventId: event.id,
        eventName: event.name,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    });
  }

  private async onRemoteEvent(env: ProtocolEvent): Promise<void> {
    if (this.closed) return;
    // Defense-in-depth: drop self-echo even if a transport adapter
    // misbehaves. The conformance suite requires no echo, but we
    // don't trust the wire to enforce it.
    if (env.scope?.nodeId === this.currentNode) return;
    if (this.fanoutMode === "node-local-default") return;
    // cluster-wide-default: republish remote events into the local
    // bus so every local subscriber sees them uniformly.
    await Effect.runPromise(this.local.append(env));
  }
}
