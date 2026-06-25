/**
 * `Cluster` — the materialized cluster value the framework consumes.
 *
 * Produced by a {@link ClusterFactory} (returned from `defineCluster`).
 * Exposes the wrapped substrate the framework swaps into the
 * containing harness (gateway / app), plus a thin read-only query
 * surface for adopters that need cluster state.
 *
 * Cluster is NOT a harness — it's the substrate-wrapping layer.
 * Diagnostic events flow via the wrapped bus (`surface: "cluster"`);
 * state queries flow through this value.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §1a
 */

import type { Effect } from "effect";
import type { EventBus, MessageInbox, OperationJournal } from "@agentick/spec-next";

import type { NodeId } from "./types.js";

/**
 * Materialized cluster: wrapped substrate + thin query surface.
 *
 * The framework reads `bus / inbox / journal` from this value when
 * constructing the containing harness's substrate slots. It also
 * registers `close()` via the parent's `onClose(...)` for ordered
 * teardown.
 *
 * Adopters that need to query cluster state at runtime (devtools
 * dashboards, management UIs, debugging probes) read it via the
 * read-only methods. There are intentionally no mutators — cluster
 * state changes happen INSIDE the cluster's adapters (transport
 * reconnects, membership transitions, partitioning rebalances), not
 * through external method calls.
 */
export interface Cluster {
  // ────────── Wrapped substrate (the load-bearing trio) ──────────

  /** Cluster-aware bus — wraps the local bus + transports
   *  broadcast/fan-out across nodes. Children of the
   *  cluster-defining harness see this in their `parent.bus`. */
  readonly bus: EventBus;

  /** Cluster-aware inbox — wraps the local inbox + transports
   *  point-to-point messages to the owning node. Children see this
   *  in `parent.inbox`. */
  readonly inbox: MessageInbox;

  /** Cluster-aware journal — either the local journal pass-through
   *  (when no durable journal adapter is configured) or a
   *  {@link DurableJournal} for rung (d) deployments. */
  readonly journal: OperationJournal;

  // ────────── Read-only query surface ──────────

  /** This node's identity within the cluster. */
  readonly currentNode: NodeId;

  /**
   * Snapshot of currently-live nodes. Includes `currentNode`. The
   * order is implementation-defined; not stable across calls.
   */
  nodes(): Promise<readonly NodeId[]>;

  /**
   * Resolve an address to its owning node via the configured
   * partitioning. Adopters use this for "where does session X
   * actually live?" UI queries. Routing decisions inside the
   * framework go through the cluster bus/inbox automatically;
   * this is purely for human/operational visibility.
   */
  ownerOf(address: string): Promise<NodeId>;

  /**
   * Cooperative shutdown. Drops all subscriptions, closes the
   * transport / membership / journal adapters, releases substrate
   * resources. Idempotent on double-close. Wired into the
   * containing harness's lifecycle via `parent.onClose(...)`.
   */
  close(): Promise<void>;
}

/**
 * Common parent shape a cluster factory accepts. The framework
 * supplies one of: `GatewayHarness` (canonical), `AppHarness`
 * (fallback), or a substrate-only shell (test scaffolding).
 *
 * All three carry the load-bearing fields the cluster wraps:
 * the local substrate and the parent's lifecycle hook.
 */
export interface ClusterParent {
  readonly id: string;
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly journal: OperationJournal;
  /** Lifecycle hook — cluster registers its `close()` here. */
  onClose(handler: () => Promise<void> | void): void;
}

/**
 * The factory shape `defineCluster(...)` returns. Per ADR 31's
 * `Factory<R, P>` primitive: takes a parent, returns the
 * materialized cluster (sync / Promise / Effect).
 *
 * Framework call sites invoke this at substrate-setup time inside
 * `createGateway` / `createApp`. The factory body runs the adapter
 * factories (transport, membership, ...) against the parent shell,
 * constructs the wrapped substrate, and returns the {@link Cluster}.
 */
export type ClusterFactory = (
  parent: ClusterParent,
) => Cluster | Promise<Cluster> | Effect.Effect<Cluster, never, never>;
