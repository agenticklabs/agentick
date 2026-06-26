/**
 * `BaseBroker` — wire-agnostic broker process that fan-outs cluster
 * traffic across connected clients.
 *
 * Concrete wire packages plug in a `Listener` that yields
 * `Connection` instances as clients connect. The broker owns:
 *
 *   - Handshake (consume `Hello`, reply with `Welcome`)
 *   - Routing table (nodeId → Connection)
 *   - Membership state + delta push (Join, Lost) on connect/disconnect
 *   - Subscription tracking per-connection (filter-aware fan-out)
 *   - Routing logic for `Send` / `Broadcast`
 *   - Heartbeat (responds to client pings; doesn't initiate by default)
 *
 * Frame validation happens at the wire boundary — anything failing
 * `isFrameShape` emits `cluster:broker:server:frame-malformed` and is
 * dropped. The broker NEVER trusts an unchecked payload past the
 * shape guard.
 *
 * Multi-tenant note: a single broker process serves all clients
 * uniformly. Multi-tenant isolation is achieved by adopters wiring
 * a custom `ClusterPartitioning` at the `cluster-next` layer (per
 * ADR 35 §7) — not by spinning up multiple brokers.
 */

import type {
  AddressFilter,
  ClusterCodec,
  EventFilter,
  MembershipChange,
  NodeId,
} from "@agentick/cluster-next";
import type { EventEnvelope, MessageEnvelope } from "@agentick/spec-next";
import { matchesAddressFilter, matchesEventFilter } from "@agentick/utils-next";

import { BoundedWriteQueue } from "./bounded-write-queue.js";
import { adaptClusterCodec, type BrokerCodec } from "./broker-codec.js";
import type { Connection, Listener } from "./connection.js";
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
} from "./wire-frames.js";

// ============================================================================
// Options
// ============================================================================

export interface BaseBrokerOptions {
  readonly listener: Listener;
  readonly codec: ClusterCodec;
  /**
   * Diagnostic emitter. Concrete wire impls bridge this into
   * `cluster-next`'s `DiagnosticEmitter`. Omitted → diagnostics are
   * silently discarded.
   */
  readonly onDiagnostic?: (name: string, payload?: unknown) => void;
  /**
   * Per-connection bounded outbound queue depth (frames). Default
   * 1024. When a connection's queue exceeds this, the OLDEST frame
   * is dropped + `cluster:broker:server:backpressure-drop` emits.
   * Prevents one slow client from stalling broker fan-out or
   * growing the broker heap unbounded.
   *
   * @see ./bounded-write-queue.ts
   */
  readonly maxQueueSize?: number;
}

// ============================================================================
// Internal state
// ============================================================================

interface ConnectedClient {
  readonly conn: Connection;
  /** Set once the client has sent Hello and we've sent Welcome. */
  nodeId?: NodeId;
  readonly inboxSubs: Map<string, AddressFilter>;
  readonly busSubs: Map<string, EventFilter>;
  /**
   * Per-conn bounded outbound queue. All broker → client frames go
   * through this; one slow client can't stall fan-out to others.
   */
  readonly writeQueue: BoundedWriteQueue<BrokerFrame>;
}

// ============================================================================
// BaseBroker
// ============================================================================

export class BaseBroker {
  private readonly listener: Listener;
  private readonly codec: BrokerCodec;
  private readonly onDiagnostic: (name: string, payload?: unknown) => void;
  private readonly maxQueueSize: number;

  /** Every accepted connection, pre- and post-handshake. Keyed by Connection.id. */
  private readonly clients = new Map<string, ConnectedClient>();

  /** Routing table: nodeId → Connection.id. Established post-handshake. */
  private readonly nodeRouting = new Map<NodeId, string>();

  private started = false;
  private closed = false;

  constructor(opts: BaseBrokerOptions) {
    this.listener = opts.listener;
    this.codec = adaptClusterCodec(opts.codec);
    this.onDiagnostic = opts.onDiagnostic ?? (() => {});
    this.maxQueueSize = opts.maxQueueSize ?? 1024;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.listener.onConnection((conn) => this.onClientConnected(conn));
    await this.listener.start();
    this.onDiagnostic("cluster:broker:server:started", { bound: this.listener.bound });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.onDiagnostic("cluster:broker:server:closing", { bound: this.listener.bound });
    // Send Goodbye to every connected client so they don't think
    // it's a network failure (clean shutdown vs remote-abort).
    // Enqueue is sync (Phase 4f.4 — bounded write queue); flush each
    // queue so the Goodbye actually lands on the wire before we tear
    // down the listener. Best-effort: flush has a 5s default
    // timeout; truly-stuck clients miss the Goodbye but other
    // clients are unaffected.
    for (const client of this.clients.values()) {
      try {
        this.writeFrame(client, { type: FRAME_GOODBYE });
      } catch {
        // ignore
      }
    }
    // Phase 4f.6 — graceful shutdown. Await flush across all
    // queues IN PARALLEL so one slow client doesn't dominate the
    // shutdown timeline. Each queue's flush is independent.
    await Promise.all(
      [...this.clients.values()].map((c) =>
        c.writeQueue.flush().catch(() => {
          // flush errors are non-fatal during shutdown
        }),
      ),
    );
    // Close queues + listener.
    for (const client of this.clients.values()) {
      client.writeQueue.close();
    }
    await this.listener.close();
    this.clients.clear();
    this.nodeRouting.clear();
    this.onDiagnostic("cluster:broker:server:closed", { bound: this.listener.bound });
  }

  /** Diagnostic accessor — currently-connected node ids. */
  nodes(): readonly NodeId[] {
    return [...this.nodeRouting.keys()];
  }

  // ==========================================================================
  // Connection handling
  // ==========================================================================

  private onClientConnected(conn: Connection): void {
    if (this.closed) {
      void conn.close();
      return;
    }
    const writeQueue = new BoundedWriteQueue<BrokerFrame>({
      conn,
      encode: (frame) => this.codec.encode(frame),
      maxQueueSize: this.maxQueueSize,
      onOverflow: (dropped, depth) => {
        this.onDiagnostic("cluster:broker:server:backpressure-drop", {
          connId: conn.id,
          droppedFrameType: dropped.type,
          queueDepthAfterDrop: depth,
        });
      },
      onSendError: (err) => {
        this.onDiagnostic("cluster:broker:server:write-failed", {
          connId: conn.id,
          reason: err instanceof Error ? err.message : String(err),
        });
      },
    });
    const client: ConnectedClient = {
      conn,
      inboxSubs: new Map(),
      busSubs: new Map(),
      writeQueue,
    };
    this.clients.set(conn.id, client);
    this.onDiagnostic("cluster:broker:server:client-connected", {
      connId: conn.id,
      remote: conn.remote,
    });
    conn.onMessage((bytes) => this.onClientMessage(client, bytes));
    conn.onClose((reason) => this.onClientDisconnected(client, reason));
  }

  private async onClientDisconnected(client: ConnectedClient, reason: string): Promise<void> {
    if (!this.clients.delete(client.conn.id)) return;
    client.writeQueue.close();
    const nodeId = client.nodeId;
    if (nodeId === undefined) {
      // Disconnect before Hello — nothing to clean up beyond the
      // local client entry.
      this.onDiagnostic("cluster:broker:server:pre-handshake-disconnected", {
        connId: client.conn.id,
        reason,
      });
      return;
    }
    this.nodeRouting.delete(nodeId);
    this.onDiagnostic("cluster:broker:server:client-disconnected", {
      connId: client.conn.id,
      nodeId,
      reason,
    });
    await this.fanoutMembership({
      kind: "lost",
      node: nodeId,
      at: new Date().toISOString(),
      reason: reason === "remote-graceful" ? "graceful" : "unknown",
    });
  }

  // ==========================================================================
  // Frame handling
  // ==========================================================================

  private async onClientMessage(client: ConnectedClient, bytes: Uint8Array): Promise<void> {
    let frame: unknown;
    try {
      frame = this.codec.decode(bytes);
    } catch (cause) {
      this.onDiagnostic("cluster:broker:server:frame-decode-failed", {
        connId: client.conn.id,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
      return;
    }
    if (!isFrameShape(frame)) {
      this.onDiagnostic("cluster:broker:server:frame-malformed", {
        connId: client.conn.id,
      });
      return;
    }
    // dispatchFrame may write to other clients' connections; if any
    // of those writes throw (slow client, EPIPE, etc.), the rejection
    // would otherwise propagate to unhandled-promise-rejection because
    // `conn.onMessage` calls this without awaiting. Catch + diagnose
    // so the broker stays alive.
    try {
      await this.dispatchFrame(client, frame);
    } catch (cause) {
      this.onDiagnostic("cluster:broker:server:dispatch-failed", {
        connId: client.conn.id,
        nodeId: client.nodeId,
        frameType: (frame as { type: string }).type,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  private async dispatchFrame(client: ConnectedClient, frame: AnyFrame): Promise<void> {
    switch (frame.type) {
      case FRAME_HELLO:
        await this.handleHello(client, frame.nodeId);
        return;
      case FRAME_SEND:
        await this.handleSend(client, frame.toNode, frame.envelope);
        return;
      case FRAME_BROADCAST:
        await this.handleBroadcast(client, frame.envelope);
        return;
      case FRAME_SUBSCRIBE_INBOX:
        client.inboxSubs.set(frame.subId, frame.filter);
        // Ack so the client's flush() can resolve. Without the ack
        // the SUBSCRIBE_INBOX → SEND race can drop deliveries when
        // adopters subscribe and immediately invoke work that
        // should land on the subscriber.
        this.writeFrame(client, { type: FRAME_SUBSCRIBE_ACK, subId: frame.subId });
        return;
      case FRAME_SUBSCRIBE_BUS:
        client.busSubs.set(frame.subId, frame.filter);
        this.writeFrame(client, { type: FRAME_SUBSCRIBE_ACK, subId: frame.subId });
        return;
      case FRAME_UNSUBSCRIBE:
        client.inboxSubs.delete(frame.subId);
        client.busSubs.delete(frame.subId);
        return;
      case FRAME_PING:
        this.writeFrame(client, { type: FRAME_PONG, seq: frame.seq });
        return;
      case FRAME_PONG:
        // Brokers don't initiate heartbeat by default — clients do.
        // A pong here is harmless; drop it.
        return;
      case FRAME_GOODBYE:
        await client.conn.close();
        return;
      case FRAME_ERROR:
        this.onDiagnostic("cluster:broker:server:client-error", {
          connId: client.conn.id,
          nodeId: client.nodeId,
          reason: frame.reason,
        });
        return;
      default:
        this.onDiagnostic("cluster:broker:server:unexpected-frame", {
          connId: client.conn.id,
          frameType: (frame as { type: string }).type,
        });
        return;
    }
  }

  // ==========================================================================
  // Frame handlers
  // ==========================================================================

  private async handleHello(client: ConnectedClient, nodeId: NodeId): Promise<void> {
    if (client.nodeId !== undefined) {
      this.writeError(client, "duplicate-hello");
      return;
    }
    if (this.nodeRouting.has(nodeId)) {
      // Two clients claiming the same nodeId. Reject the newcomer.
      this.writeError(client, `node-id-already-registered:${nodeId}`);
      await client.conn.close();
      return;
    }
    client.nodeId = nodeId;
    this.nodeRouting.set(nodeId, client.conn.id);
    this.writeFrame(client, {
      type: FRAME_WELCOME,
      nodes: this.nodes(),
    });
    this.onDiagnostic("cluster:broker:server:client-welcomed", {
      connId: client.conn.id,
      nodeId,
    });
    await this.fanoutMembership({
      kind: "joined",
      node: nodeId,
      at: new Date().toISOString(),
    });
  }

  private async handleSend(
    sender: ConnectedClient,
    toNode: NodeId,
    envelope: MessageEnvelope,
  ): Promise<void> {
    if (sender.nodeId === undefined) {
      this.writeError(sender, "send-before-hello");
      return;
    }
    const targetConnId = this.nodeRouting.get(toNode);
    if (targetConnId === undefined) {
      this.writeError(sender, `node-unreachable:${toNode}`);
      this.onDiagnostic("cluster:broker:server:routing-failed", {
        fromNode: sender.nodeId,
        toNode,
        messageId: envelope.messageId,
        reason: "node-not-registered",
      });
      return;
    }
    const target = this.clients.get(targetConnId);
    if (target === undefined) {
      // Routing-table entry without a live connection — shouldn't
      // happen since disconnect cleans the entry. Defensive log.
      this.onDiagnostic("cluster:broker:server:routing-inconsistent", {
        fromNode: sender.nodeId,
        toNode,
        messageId: envelope.messageId,
      });
      return;
    }
    // Filter check — deliver only to subscriptions whose address
    // filter matches. If no inbox subs registered (rare), deliver
    // unconditionally so the client can use a no-subscription mode
    // for ergonomic fallbacks. Conformance from `cluster-next` treats
    // empty-filter subscribes as match-all; we keep parity here.
    if (target.inboxSubs.size === 0) {
      this.writeFrame(target, { type: FRAME_INBOX_DELIVER, envelope });
      return;
    }
    let matched = false;
    for (const filter of target.inboxSubs.values()) {
      if (matchesAddressFilter(filter, envelope.addressedTo)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      this.writeFrame(target, { type: FRAME_INBOX_DELIVER, envelope });
    } else {
      this.onDiagnostic("cluster:broker:server:no-matching-subscription", {
        toNode,
        messageId: envelope.messageId,
        address: envelope.addressedTo,
      });
    }
  }

  private async handleBroadcast(sender: ConnectedClient, envelope: EventEnvelope): Promise<void> {
    if (sender.nodeId === undefined) {
      this.writeError(sender, "broadcast-before-hello");
      return;
    }
    // Fan out to every OTHER client whose bus subscription matches.
    // No self-echo (per ADR 35 conformance).
    for (const client of this.clients.values()) {
      if (client.conn.id === sender.conn.id) continue;
      if (client.nodeId === undefined) continue; // pre-handshake
      if (client.busSubs.size === 0) {
        this.writeFrame(client, { type: FRAME_BUS_DELIVER, envelope });
        continue;
      }
      let matched = false;
      for (const filter of client.busSubs.values()) {
        if (matchesEventFilter(filter, envelope)) {
          matched = true;
          break;
        }
      }
      if (matched) {
        this.writeFrame(client, { type: FRAME_BUS_DELIVER, envelope });
      }
    }
  }

  private async fanoutMembership(change: MembershipChange): Promise<void> {
    const frame: BrokerFrame = { type: FRAME_MEMBERSHIP, change };
    for (const client of this.clients.values()) {
      if (client.nodeId === undefined) continue; // pre-handshake
      try {
        this.writeFrame(client, frame);
      } catch (cause) {
        // A client closing during fan-out is normal; don't let it
        // block other deliveries.
        this.onDiagnostic("cluster:broker:server:membership-fanout-failed", {
          connId: client.conn.id,
          reason: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
  }

  // ==========================================================================
  // Frame I/O helpers
  // ==========================================================================

  /**
   * Enqueue a frame for delivery to `client`'s connection. Returns
   * synchronously; the per-conn `BoundedWriteQueue` drains on the
   * microtask queue. If the queue is full, the OLDEST frame is
   * dropped + `cluster:broker:server:backpressure-drop` emits.
   *
   * Phase 4f.4 replaced `await conn.send(...)` with a queue —
   * pre-4f.4, one slow client (kernel buffer full, drain pending)
   * blocked the broker's sequential fan-out loop. Now slow clients
   * stall locally; fan-out to others proceeds without delay.
   *
   * Phase 4f.5 introduced `BrokerCodec` — the cast away from
   * `MessageEnvelope` now lives in one place (`broker-codec.ts`'s
   * `adaptClusterCodec`). `writeFrame` here is straightforward.
   */
  private writeFrame(client: ConnectedClient, frame: BrokerFrame): void {
    client.writeQueue.enqueue(frame);
  }

  private writeError(client: ConnectedClient, reason: string): void {
    this.writeFrame(client, { type: FRAME_ERROR, reason });
  }
}
