/**
 * Per-phase journaling policy.
 *
 * Not every event needs to be durable. The journal is the
 * recovery + audit layer; the bus is the live observability stream.
 * They diverge on high-cadence events.
 *
 * Per-surface tunable via `BaseHarness` configuration.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §Backpressure and the write-path policy
 */

import type { EventPhase } from "./events.js";

/**
 * Behavior of the bounded journal-write queue when full.
 *
 *   suspend  — producer waits (preserves durability, costs latency)
 *   sliding  — drop oldest entry (preserves recent events, lossy)
 *   dropping — drop newest entry (preserves throughput, lossy)
 */
export type OverflowStrategy = "suspend" | "sliding" | "dropping";

/**
 * Per-event-name override:
 *   "always"    — always journal regardless of phase rules
 *   "bus-only"  — never journal; bus only
 *   "drop"      — neither journal nor bus
 */
export type EventNameOverride = "always" | "bus-only" | "drop";

/**
 * Journaling policy. Configured per harness; may have per-event-name
 * overrides.
 */
export interface JournalingPolicy {
  /** Phases that always go to journal (and bus). */
  readonly alwaysJournal: readonly EventPhase[];

  /** Phases that go to bus only by default. */
  readonly busOnly: readonly EventPhase[];

  /**
   * Per-event-name overrides. Keys MAY be exact names or prefix
   * patterns (the substrate decides matching strategy).
   */
  readonly override?: Readonly<Record<string, EventNameOverride>>;

  /** Backpressure strategy when the journal write queue is full. */
  readonly overflow: OverflowStrategy;

  /** Bounded queue capacity. */
  readonly queueCapacity: number;
}

/**
 * Sensible defaults. Adjust per-surface as needed.
 *
 *   alwaysJournal: requested + terminal  (recovery + audit spine)
 *   busOnly:       before + delta        (observability noise)
 *   overflow:      sliding               (favor harness throughput)
 *   queueCapacity: 4096
 */
export const DEFAULT_JOURNALING_POLICY: JournalingPolicy = {
  alwaysJournal: ["requested", "terminal"],
  busOnly: ["before", "delta"],
  overflow: "sliding",
  queueCapacity: 4096,
};
