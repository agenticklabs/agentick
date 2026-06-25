/**
 * `defineCluster*` adapter-authoring helpers.
 *
 * Per ADR 36: every `defineX` returns a factory shape. Adapter
 * authors supply Promise-flavored implementations; the helper
 * bridges to the framework's internal Effect/Layer machinery.
 *
 * Phase 1 ships SIGNATURES only — the actual bridge logic lands in
 * Phase 2 alongside the JSON codec, `LocalClusterTransport`
 * fixture, and conformance suite. Helpers in this file throw
 * "not yet implemented" if called, so downstream packages can
 * import and type-check against them without the impl existing
 * yet.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §2, §4
 * @see docs/proposals/v2/blueprint/36-define-vs-create-convention.md
 */

import type { Cluster, ClusterFactory } from "./cluster.js";
import type { ClusterCodec } from "./codec.js";
import type {
  ClusterCodecFactory,
  ClusterMembershipFactory,
  ClusterPartitioningFactory,
  ClusterTransportFactory,
  DurableJournalFactory,
} from "./factories.js";
import type { DurableJournal } from "./journal.js";
import type { ClusterMembership } from "./membership.js";
import type { ClusterPartitioning } from "./partitioning.js";
import type { ClusterTransport } from "./transport.js";
import type { NodeId } from "./types.js";

// ============================================================================
// Top-level cluster spec
// ============================================================================

/**
 * Adopter-facing config for {@link defineCluster}. The factory
 * returned wraps the parent harness's substrate at the substrate
 * seam (see ADR 35 §1).
 */
export interface DefineClusterConfig {
  /**
   * Identity for THIS node. Static or lazy. Lazy thunk is resolved
   * at construction; common pattern is to derive from an env var.
   *
   *   nodeId: "node-1"                                  // static
   *   nodeId: () => process.env.NODE_ID ?? "default"    // lazy
   */
  readonly nodeId: NodeId | (() => NodeId | Promise<NodeId>);

  /** Required: cross-node wire. */
  readonly transport: ClusterTransportFactory;

  /** Required: who's in the cluster. */
  readonly membership: ClusterMembershipFactory;

  /**
   * Optional: address → owning node mapping. Defaults to consistent
   * hash on the scopeId extracted from each address. Adopters
   * override to shard by tenant / user / custom topology.
   */
  readonly partitioning?: ClusterPartitioningFactory;

  /**
   * Optional: durable journal for rung (d) deployments. Absent →
   * the parent's local journal is used (in-memory or whatever the
   * adopter wired). When present, the cluster's effective journal
   * is this one.
   */
  readonly journal?: DurableJournalFactory;

  /**
   * Optional: wire serialization codec. Defaults to JSON (bundled
   * in this package). Swap for MessagePack (perf), protobuf
   * (schemas), or a custom codec for non-standard wires.
   */
  readonly codec?: ClusterCodecFactory;

  /**
   * Default delivery mode for bus subscriptions. Adopters can
   * override per-subscription. Most adopters want node-local;
   * management dashboards explicitly subscribe cluster-wide.
   *
   *   "node-local-default" (default) — subscribers see only events
   *     published on the current node.
   *   "cluster-wide-default" — subscribers see events from all
   *     nodes.
   */
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}

// ============================================================================
// Adapter-authoring helpers — one per seam
// ============================================================================

/**
 * Wrap a Promise-flavored {@link ClusterTransport} implementation
 * into a `ClusterTransportFactory` the framework consumes.
 *
 * Adopter authors typically wrap this in a configurable factory:
 *
 *   export function redisTransport(opts: RedisOptions): ClusterTransportFactory {
 *     return defineClusterTransport({
 *       async send(toNode, env) { ... },
 *       async broadcast(env) { ... },
 *       subscribeInbox(filter, onMessage) { ... return () => {}; },
 *       subscribeBus(filter, onEvent) { ... return () => {}; },
 *       async close() { ... },
 *     });
 *   }
 *
 * Internal: the helper sets up an Effect.Scope so `close()` runs
 * on framework shutdown, wraps Promise methods in `Effect.tryPromise`
 * for fiber supervision, and projects callback subscriptions to
 * Stream-friendly form for internal consumers.
 *
 * @phase Phase 2 — implementation lands alongside the JSON codec.
 */
export function defineClusterTransport(_impl: ClusterTransport): ClusterTransportFactory {
  throw new Error(
    "defineClusterTransport: not yet implemented (Phase 2). " +
      "Phase 1 ships type signatures only — see ADR 35 phase plan.",
  );
}

/**
 * Wrap a Promise-flavored {@link ClusterMembership} implementation
 * into a `ClusterMembershipFactory`. Same authoring pattern as
 * {@link defineClusterTransport}.
 *
 * @phase Phase 2.
 */
export function defineClusterMembership(_impl: ClusterMembership): ClusterMembershipFactory {
  throw new Error("defineClusterMembership: not yet implemented (Phase 2).");
}

/**
 * Wrap a {@link ClusterPartitioning} implementation into a factory.
 * `shardKeyFor` is pure; `nodeFor` is async — the helper preserves
 * both shapes for the framework's internal consumers.
 *
 * @phase Phase 2.
 */
export function defineClusterPartitioning(_impl: ClusterPartitioning): ClusterPartitioningFactory {
  throw new Error("defineClusterPartitioning: not yet implemented (Phase 2).");
}

/**
 * Wrap a {@link DurableJournal} implementation into a factory.
 * Optional seam — only adopters opting into rung (d) durability
 * need to provide one.
 *
 * @phase Phase 2 (seam); rung (d) integration in v2.x.
 */
export function defineClusterJournal(_impl: DurableJournal): DurableJournalFactory {
  throw new Error("defineClusterJournal: not yet implemented (Phase 2).");
}

/**
 * Wrap a {@link ClusterCodec} implementation into a factory. The
 * bundled JSON codec ships alongside this helper in Phase 2.
 *
 * @phase Phase 2.
 */
export function defineClusterCodec(_impl: ClusterCodec): ClusterCodecFactory {
  throw new Error("defineClusterCodec: not yet implemented (Phase 2).");
}

// ============================================================================
// Top-level factory
// ============================================================================

/**
 * Compose seam factories into a top-level {@link ClusterFactory}.
 * The framework calls the returned factory at substrate-setup time
 * inside `createGateway` / `createApp`; the returned {@link Cluster}
 * wraps the parent's local substrate.
 *
 * @phase Phase 2 — composes the seam factories into a working
 *   Cluster value once the bridges in `defineClusterX(...)` helpers
 *   are filled in.
 */
export function defineCluster(_spec: DefineClusterConfig): ClusterFactory {
  return (_parent) => {
    throw new Error("defineCluster: not yet implemented (Phase 2).");
  };
}

// Re-export Cluster so adopters importing from `@agentick/cluster-next`
// see the materialized type alongside the helpers.
export type { Cluster };
