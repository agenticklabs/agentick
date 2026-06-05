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
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Per-surface policy
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
 * Per-surface batch policy. Producer-side accumulation: the bus buffers
 * matching events and flushes whichever trigger fires first.
 *
 * Keys in {@link JournalingPolicy.batch} are matched against the
 * `<surface>:<phase>` discriminator (`"executor:delta"`,
 * `"session:metric"`). Wildcard `*` for phase matches every phase
 * under that surface (`"executor:*"`). Exact match wins over wildcard.
 *
 * Both triggers are optional. If neither is set the policy entry has
 * no effect (equivalent to no batching). Setting only `flushAfterMs`
 * gives time-window batching with no count cap; setting only
 * `flushAfterCount` gives count-only batching with no upper time bound
 * (don't do this for low-cadence surfaces — the batch may never flush).
 *
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Per-surface policy
 */
export interface SurfaceBatchPolicy {
  /**
   * Flush after this many ms elapse since the first queued event
   * (per-surface). If unset, the flush is purely count-driven.
   */
  readonly flushAfterMs?: number;
  /**
   * Flush as soon as N events accumulate for this surface (per-surface
   * counter). Whichever trigger fires first wins.
   */
  readonly flushAfterCount?: number;
}

/**
 * Per-surface retention policy. Bounds the ring buffer's retained
 * history for a surface — late subscribers can resume from any cursor
 * within the retained range; cursors past it surface
 * {@link CursorEvictedError}.
 *
 * Both bounds are optional; either may apply. When both are set the
 * tighter of the two wins (oldest event is evicted as soon as either
 * limit is breached).
 *
 * Keys follow the same `<surface>:<phase>` convention as
 * {@link SurfaceBatchPolicy}.
 *
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §The shape we want
 */
export interface SurfaceRetentionPolicy {
  /** Maximum events retained for this surface (oldest evicted first). */
  readonly maxEvents?: number;
  /** Maximum age in ms; events older than this are evicted. */
  readonly maxAge?: number;
}

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

  /**
   * Per-surface batching policies. Keys are `<surface>:<phase>` (e.g.
   * `"executor:delta"`) or `<surface>:*` wildcards. Missing keys mean
   * no batching for that surface (immediate publish).
   *
   * Bus implementations consult this to accumulate matching events and
   * flush in groups. The semantic contract from a subscriber's
   * perspective is unchanged — events still arrive one at a time — only
   * the producer-side fan-out cost amortises across the batch.
   *
   * @see docs/proposals/v2/blueprint/29-bus-overhaul.md
   */
  readonly batch?: Readonly<Record<string, SurfaceBatchPolicy>>;

  /**
   * Per-surface retention policies. Bounds the bus's ring buffer for
   * late-subscriber replay. Cursors past the retained range surface
   * `CursorEvictedError`. Defaults to implementation-defined behavior
   * when omitted.
   */
  readonly retention?: Readonly<Record<string, SurfaceRetentionPolicy>>;
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
