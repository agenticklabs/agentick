/**
 * Cluster conformance suite — verifies adapter implementations
 * against the protocol contract.
 *
 * Phase 1 ships SIGNATURES only — Phase 2 fills the suite body in.
 * Adapter packages will import `runClusterTransportConformance(...)`
 * and pass their factory + a `LocalClusterTransport` fixture peer
 * for the cross-node cases the suite needs to test.
 *
 * @phase Phase 2 — implementation alongside `LocalClusterTransport`.
 * @see docs/proposals/v2/blueprint/35-cluster-protocol.md (Conformance)
 */

import type { ClusterTransportFactory } from "./factories.js";

/**
 * Configuration passed to {@link runClusterTransportConformance}.
 * Adapter tests typically pass two factories — one for the
 * adapter-under-test and one for a peer (most often the
 * `LocalClusterTransport` fixture from `./testing`).
 */
export interface ClusterTransportConformanceConfig {
  /** The adapter being tested. */
  readonly transport: ClusterTransportFactory;
  /**
   * Optional peer factory for cross-node assertions. When omitted,
   * the suite spins up two instances of `transport` itself.
   */
  readonly peerTransport?: ClusterTransportFactory;
}

/**
 * Adapter-side test entrypoint. Adapter packages call this in
 * their conformance spec file with their `xxxTransport(...)`
 * factory; the suite verifies ordering, delivery, lifecycle,
 * filter semantics, and resource cleanup.
 *
 * Phase 2 will implement the suite body using vitest's `describe`
 * / `it` so adapter packages can integrate via standard test
 * runner discovery.
 *
 * @phase Phase 2.
 */
export function runClusterTransportConformance(_config: ClusterTransportConformanceConfig): void {
  throw new Error(
    "runClusterTransportConformance: not yet implemented (Phase 2). " +
      "The conformance suite lands alongside LocalClusterTransport in Phase 2.",
  );
}
