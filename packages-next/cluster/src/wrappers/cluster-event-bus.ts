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
 *     node. (Phase 3 limitation: a future "cluster-wide subscriber"
 *     opt-in path will let select subscribers see remote events even
 *     in node-local-default mode. For now, switch the mode if you need
 *     remote visibility.)
 *
 * Loop avoidance:
 *   - The transport contract promises "broadcast does NOT echo back to
 *     the sending node" (see conformance). As a defense-in-depth, the
 *     wrapper also drops inbound events whose `scope.nodeId === currentNode`.
 *
 * Diagnostic events: emits `surface: "cluster"` lifecycle events on
 * the inner bus so operators can observe the wrapper's state.
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

/**
 * Lightweight id generator for diagnostic events. Not a true ULID —
 * deliberate, to keep the wrapper free of runtime-next dependencies.
 * Diagnostic ids only need to be locally-unique for log correlation.
 */
function diagId(): string {
  const t = Date.now().toString(36);
  const r = Math.floor(Math.random() * 0xffffff).toString(36);
  return `cluster-diag-${t}-${r}`;
}

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

  /** Transport-level unsubscribe; runs on close(). */
  private inboundUnsubscribe: (() => Promise<void>) | null = null;
  private closed = false;

  constructor(opts: ClusterEventBusOptions) {
    this.local = opts.local;
    this.transport = opts.transport;
    this.currentNode = opts.currentNode;
    this.fanoutMode = opts.fanoutMode;

    // Wire inbound republish. The transport contract promises no
    // self-echo on broadcast; we still gate on scope.nodeId for
    // defense-in-depth.
    this.inboundUnsubscribe = this.transport.subscribeBus({}, (env) => {
      void this.onRemoteEvent(env);
    });

    // Diagnostic: announce the wrap on the local bus so observers can
    // see when cluster mode is active for this node.
    Effect.runFork(
      this.local.append({
        id: diagId(),
        surface: "cluster",
        name: "cluster:wrap:installed",
        phase: "terminal",
        timestamp: Date.now(),
        scope: { nodeId: this.currentNode },
        payload: { fanoutMode: this.fanoutMode },
      }),
    );
  }

  // ============================================================================
  // EventLog<ProtocolEvent>
  // ============================================================================

  append(event: ProtocolEvent): Effect.Effect<void, never, never> {
    if (this.closed) return Effect.void;
    const stamped = this.stamp(event);
    return Effect.flatMap(this.local.append(stamped), () =>
      Effect.promise(() => this.transport.broadcast(stamped).catch(() => {})),
    );
  }

  appendBatch(events: ReadonlyArray<ProtocolEvent>): Effect.Effect<void, never, never> {
    if (this.closed || events.length === 0) return Effect.void;
    const stamped = events.map((e) => this.stamp(e));
    return Effect.flatMap(this.local.appendBatch(stamped), () =>
      Effect.promise(async () => {
        // Per-event broadcast — the transport's per-source FIFO
        // contract preserves order within a batch.
        for (const e of stamped) {
          await this.transport.broadcast(e).catch(() => {});
        }
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
    await Effect.runPromise(
      this.local.append({
        id: diagId(),
        surface: "cluster",
        name: "cluster:wrap:disposed",
        phase: "terminal",
        timestamp: Date.now(),
        scope: { nodeId: this.currentNode },
      }),
    );

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
