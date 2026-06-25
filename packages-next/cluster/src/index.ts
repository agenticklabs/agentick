/**
 * `@agentick/cluster-next` — cluster protocol package for Agentick v2.
 *
 * Provides:
 *   - Five typed seams adapter authors implement
 *     ({@link ClusterTransport}, {@link ClusterMembership},
 *     {@link ClusterPartitioning}, {@link DurableJournal},
 *     {@link ClusterCodec})
 *   - The materialized {@link Cluster} value and its {@link ClusterFactory}
 *     shape (per ADR 31's `Factory<R, P>` primitive)
 *   - `defineClusterX(impl)` adapter-authoring helpers (Phase 2)
 *     and `defineCluster(spec)` top-level factory (Phase 2)
 *
 * Does NOT provide:
 *   - Transport implementations — those ship as separate adapter
 *     packages (`@agentick/cluster-ipc-next`,
 *     `@agentick/cluster-redis-next`, `@agentick/cluster-nats-next`).
 *   - Wire serialization other than JSON — additional codecs ship
 *     as `@agentick/cluster-codec-msgpack-next`, etc.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md
 * @see docs/proposals/v2/blueprint/11-cluster.md
 */

// ────────── Shared protocol types ──────────
export type {
  AddressFilter,
  EventFilter,
  JournalEntry,
  JournalOffset,
  MembershipChange,
  NodeId,
} from "./types.js";

// ────────── Seams (interfaces implemented by adapter packages) ──────────
export type { ClusterTransport } from "./transport.js";
export type { ClusterMembership } from "./membership.js";
export type { ClusterPartitioning } from "./partitioning.js";
export type { ClusterCodec } from "./codec.js";
export type { DurableJournal } from "./journal.js";

// ────────── Materialized cluster + factory shape ──────────
export type { Cluster, ClusterFactory, ClusterParent } from "./cluster.js";

// ────────── Per-seam factory aliases (`Factory<R, P>` projections) ──────────
export type {
  ClusterCodecFactory,
  ClusterMembershipFactory,
  ClusterPartitioningFactory,
  ClusterTransportFactory,
  DurableJournalFactory,
} from "./factories.js";

// ────────── Adapter-authoring helpers (Phase 2 impls) ──────────
export {
  defineCluster,
  defineClusterCodec,
  defineClusterJournal,
  defineClusterMembership,
  defineClusterPartitioning,
  defineClusterTransport,
  type DefineClusterConfig,
} from "./define.js";

// ────────── Conformance suite (Phase 2 impl) ──────────
export {
  runClusterTransportConformance,
  type ClusterTransportConformanceConfig,
} from "./conformance.js";
