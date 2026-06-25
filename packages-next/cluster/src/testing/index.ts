/**
 * Cluster testing fixtures — Meszaros doubles for the
 * conformance suite + adopter integration tests that need
 * cross-cluster behavior without infrastructure.
 *
 *   - `createLocalClusterRegistry()` — shared in-memory routing state
 *   - `localClusterTransport(opts)` — fake `ClusterTransport` backed
 *     by the registry; pure JS, no I/O, microtask-scheduled delivery
 *     for deterministic ordering
 *   - `localClusterMembership(opts)` — fake `ClusterMembership` backed
 *     by the same registry; emits snapshot + transition deltas
 *
 * Use these in tests that need REAL transport behavior (subscription
 * lifecycle, ordering, filter matching) without standing up real
 * infrastructure. Adapter packages also use them as the peer
 * transport in their conformance tests.
 */

export type { LocalClusterRegistry } from "./local-cluster-registry.js";
export { createLocalClusterRegistry } from "./local-cluster-registry.js";

export type { LocalClusterTransportOptions } from "./local-cluster-transport.js";
export { localClusterTransport } from "./local-cluster-transport.js";

export type { LocalClusterMembershipOptions } from "./local-cluster-membership.js";
export { localClusterMembership } from "./local-cluster-membership.js";
