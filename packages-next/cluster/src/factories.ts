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

import type { Effect } from "effect";

import type { ClusterCodec } from "./codec.js";
import type { ClusterParent } from "./cluster.js";
import type { DurableJournal } from "./journal.js";
import type { ClusterMembership } from "./membership.js";
import type { ClusterPartitioning } from "./partitioning.js";
import type { ClusterTransport } from "./transport.js";

/**
 * Generic factory shape, parameterized by `R` (the constructed
 * thing) and `P` (the parent context). Matches `Factory<R, P>`
 * from `@agentick/spec-next/protocol/factory.ts`.
 */
type Factory<R, P> = (parent: P) => R | Promise<R> | Effect.Effect<R, never, never>;

export type ClusterTransportFactory = Factory<ClusterTransport, ClusterParent>;
export type ClusterMembershipFactory = Factory<ClusterMembership, ClusterParent>;
export type ClusterPartitioningFactory = Factory<ClusterPartitioning, ClusterParent>;
export type DurableJournalFactory = Factory<DurableJournal, ClusterParent>;
export type ClusterCodecFactory = Factory<ClusterCodec, ClusterParent>;
