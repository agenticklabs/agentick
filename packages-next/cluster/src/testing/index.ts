/**
 * Cluster testing fixtures — Meszaros doubles, used by the
 * conformance suite and by adopters writing cross-cluster
 * integration tests without infrastructure.
 *
 * Phase 1 ships an empty re-export. Phase 2 lands:
 *   - `localClusterTransport()` — in-memory multi-node simulator
 *     routing via shared `LocalEventBus` between fake nodes
 *   - `localClusterMembership()` — in-memory membership tracker
 *   - `spyClusterTransport(...)` — recorder spy wrapping any
 *     transport factory, for assertion-friendly tests
 *
 * @phase Phase 2.
 */

export {};
