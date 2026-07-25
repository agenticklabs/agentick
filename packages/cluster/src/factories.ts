/**
 * Factory type aliases for each cluster seam. Per ADR 31's
 * `Factory<R, P>` primitive — every `defineClusterX(impl)` helper
 * returns one of these.
 *
 * The parent type per factory varies: transport/membership/
 * partitioning/journal/codec all receive a `ClusterParent`-shaped
 * shell during construction. The shell is provided by the
 * top-level cluster factory body when it composes the seams.
 *
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md §2
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md (Factory<R, P>)
 */

import type { ClusterCodec } from "./codec.js";
import type { ClusterParent } from "./cluster.js";
import type { DurableJournal } from "./journal.js";
import type { ClusterMembership } from "./membership.js";
import type { ClusterPartitioning } from "./partitioning.js";
import type { ClusterTransport } from "./transport.js";

/**
 * Generic factory shape, parameterized by `R` (the constructed
 * thing) and `P` (the parent context). Matches `Factory<R, P>`
 * from `@agentick/spec/protocol/factory.ts`.
 *
 * Sync OR Promise returns. `Effect.Effect<R, never, never>` returns
 * are NOT supported at runtime — `resolveFactoryAsync` throws on
 * Effect-shaped values. The Factory type narrowly admits only what
 * the runtime can actually execute. When Effect-typed factories
 * land (post-Phase-4), this union widens and `resolveFactoryAsync`
 * picks up an Effect.runPromise arm.
 */
type Factory<R, P> = (parent: P) => R | Promise<R>;

export type ClusterTransportFactory = Factory<ClusterTransport, ClusterParent>;
export type ClusterMembershipFactory = Factory<ClusterMembership, ClusterParent>;
export type ClusterPartitioningFactory = Factory<ClusterPartitioning, ClusterParent>;
export type DurableJournalFactory = Factory<DurableJournal, ClusterParent>;
export type ClusterCodecFactory = Factory<ClusterCodec, ClusterParent>;
