/**
 * `EventLog<E>` — append-only log primitive that both {@link EventBus} and
 * {@link OperationJournal} are specialisations of.
 *
 * Phase C of ADR 29's bus overhaul. The primitive is one shape: an
 * append-only sequence with cursor-based reads. Local in-memory ring
 * buffer, durable SQLite/Postgres, and `@effect/cluster`-backed
 * distributed logs all satisfy the same contract. Adopter code that
 * targets `EventLog<E>` works against any backend.
 *
 * **Phase rollout for the spec extends:**
 *
 *   - C.1 (this file) — type surface defined; nothing extends yet.
 *   - C.2 — `EventBus extends EventLog<ProtocolEvent>` once LocalEventBus
 *     ships ring buffer + cursor pull. `OperationJournal` stays
 *     unchanged in this commit (its existing `read(query, from)`
 *     signature would collide with `EventLog.read(cursor, matcher)`;
 *     alignment is a separate pass).
 *   - C.3 — `OperationJournal extends EventLog<ProtocolEvent>` once the
 *     journal's read surface is aligned to the cursor primitive.
 *
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §The shape we want
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Phase C
 */

import type { Effect, Stream } from "effect";
import type { EventKey } from "./bus.js";

// ============================================================================
// Cursor
// ============================================================================

/**
 * Position within an {@link EventLog}. Monotonic across all appends to
 * a single log. Two cursors from different logs are NOT comparable —
 * cursor identity is log-scoped.
 *
 * Subscribers pass a cursor to {@link EventLog.read} to resume from a
 * specific point. The conventional values:
 *
 *   - `{ value: 0 }`        — read from the beginning (replay everything
 *                              still retained)
 *   - `{ value: <prev> }`   — resume from after a previously observed
 *                              event (cursor from the last drained event)
 *   - implementation-specific "tail" — read live, no replay (each impl
 *                              documents its own value; commonly the
 *                              log's `head` at subscribe time)
 *
 * Adopters DO NOT construct cursors arithmetically beyond the simple
 * "previous + 1" pattern — the cursor's `value` is an opaque
 * monotonic offset, not a guaranteed array index. Distributed log
 * backends may sparsify it.
 */
export interface Cursor {
  /** Opaque monotonic position. Log-scoped; not comparable across logs. */
  readonly value: number;
}

// ============================================================================
// CompiledMatcher<E> — per-event filter closure
// ============================================================================

/**
 * Pre-compiled per-event filter. Constructed at subscribe time so the
 * hot read loop pays a closure call (~30 ns) instead of walking a
 * query union per event (~100 ns for typical shapes; ~2× for composite).
 *
 * The runtime's `compileQuery(query: EventQuery): CompiledMatcher<ProtocolEvent>`
 * is the canonical builder for protocol events. Generic over `E` so
 * future log specialisations (typed channel events, etc.) can supply
 * their own matchers.
 *
 * @see packages/runtime/src/substrate/query.ts
 */
export type CompiledMatcher<E> = (event: E) => boolean;

// ============================================================================
// CursorEvictedError — subscriber lag past retention
// ============================================================================

/**
 * Surfaced through {@link EventLog.read}'s failure channel when a
 * subscriber's cursor has fallen behind the log's retained range.
 *
 * Two scenarios produce this error:
 *
 *   1. **Resubscribe past retention.** A subscriber persisted its cursor
 *      across a disconnect, returned later, and the log has evicted
 *      events at or after that cursor. The error is raised before any
 *      event is yielded.
 *   2. **In-flight lag.** A long-lived subscriber drained slowly enough
 *      that incoming appends pushed retention past its cursor. The error
 *      is raised on the next pull after eviction crosses the cursor.
 *
 * Loud failure is intentional (ADR 29 Phase B/C design decision —
 * silent skip-ahead is the worse failure mode for an audit-shaped
 * substrate). Adopters who want skip-ahead semantics catch this error
 * and resubscribe with `oldestAvailable` as the new cursor.
 *
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Open design decisions §Cursor semantics on resubscribe past retention
 */
export class CursorEvictedError extends Error {
  readonly _tag = "CursorEvictedError" as const;
  /** The cursor the subscriber requested or had at the time of eviction. */
  readonly requested: Cursor;
  /** The oldest cursor still available in the log. Use as the resubscribe point. */
  readonly oldestAvailable: Cursor;
  constructor(requested: Cursor, oldestAvailable: Cursor) {
    super(
      `Cursor evicted: requested=${requested.value}, oldest available=${oldestAvailable.value}`,
    );
    this.name = "CursorEvictedError";
    this.requested = requested;
    this.oldestAvailable = oldestAvailable;
  }
}

// ============================================================================
// LogMetrics — instantaneous read of log state
// ============================================================================

/**
 * Instantaneous snapshot of {@link EventLog} state. Adopters poll
 * `log.metrics()` for observability; values reflect the moment of the
 * call (not a streaming feed). The fields:
 *
 *   - `eventsPerSecond`   sliding-window throughput over the last 5
 *                         seconds (per-impl window size). Approximate.
 *   - `subscriberCount`   active live subscribers (cursor-pulling).
 *   - `cursorLagP99`      p99 wall-clock lag across active subscribers,
 *                         in milliseconds. For each lagging subscriber,
 *                         lag = `now - timestamp(events[sub.cursor])`.
 *                         0 when all subscribers are caught up. Empty
 *                         when no subscribers exist.
 *   - `dropRate`          ratio of evictions (cursor-past-retention) to
 *                         appends over the same window as
 *                         `eventsPerSecond`. 0 when no subscribers have
 *                         been evicted.
 *   - `retentionEvents`   current count of events retained in the log.
 *                         Bounded by the active retention policy.
 *
 * Distributed log backends may approximate any field. The contract is
 * "best-effort snapshot, not a transactional read."
 */
export interface LogMetrics {
  readonly eventsPerSecond: number;
  readonly subscriberCount: number;
  /** Milliseconds. p99 across active subscribers; 0 when none lag. */
  readonly cursorLagP99: number;
  /** Unitless ratio in `[0, 1]`. */
  readonly dropRate: number;
  readonly retentionEvents: number;
}

// ============================================================================
// EventLog<E>
// ============================================================================

/**
 * Append-only log primitive. Both {@link EventBus} (live observation)
 * and {@link OperationJournal} (durable audit) become specialisations
 * of this interface in Phase C of ADR 29.
 *
 * Parameterized by:
 *   - `E`            the event type
 *   - `AppendError`  the error channel of `append`/`appendBatch`.
 *                    Bus uses `never` (in-memory, infallible). Journal
 *                    uses `JournalError` (storage can fail).
 *
 * The read-side error channel is fixed to {@link CursorEvictedError};
 * cursor eviction is the only failure mode common to every log.
 *
 * Operations:
 *
 *   - `append(event)`               write one event; assigns the next
 *                                    cursor position
 *   - `appendBatch(events)`         write N events atomically (single
 *                                    cursor block; subscribers see them
 *                                    one-at-a-time)
 *   - `read(cursor, matcher)`       pull stream starting from `cursor`,
 *                                    yielding only events the matcher
 *                                    accepts. The stream fails with
 *                                    {@link CursorEvictedError} when
 *                                    the cursor falls behind retention.
 *   - `hasSubscriberFor(key)`       construction-on-demand probe — true
 *                                    iff a future read with a matching
 *                                    cursor would yield envelopes for
 *                                    `key`. Lets publishers skip
 *                                    envelope construction when no
 *                                    subscriber wants it (the "enabled"
 *                                    pattern from Rust's `tracing` crate).
 *   - `metrics()`                   instantaneous {@link LogMetrics}.
 *
 * Constraints on implementations:
 *
 *   1. Appends are totally ordered within a log; cursor values are
 *      monotonically non-decreasing.
 *   2. `appendBatch` MUST preserve insertion order on delivery; the
 *      batch is one logical transaction even if the underlying store
 *      breaks it into multiple writes.
 *   3. `read` MUST NOT block the producer; subscribers pull at their
 *      own pace. Subscribers that fall behind retention surface
 *      `CursorEvictedError` rather than silently skipping.
 *   4. `hasSubscriberFor` MUST NOT return `false` for a key an active
 *      subscriber's matcher would accept. Conservative `true` returns
 *      are acceptable (false positives are paper-cut over-builds);
 *      false negatives are correctness bugs.
 *   5. `metrics()` is a snapshot, not a transaction. Distributed
 *      backends MAY approximate.
 *
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md
 */
export interface EventLog<E, AppendError = never> {
  append(event: E): Effect.Effect<void, AppendError, never>;
  appendBatch(events: ReadonlyArray<E>): Effect.Effect<void, AppendError, never>;
  read(
    cursor: Cursor,
    matcher: CompiledMatcher<E>,
  ): Stream.Stream<E, CursorEvictedError, never>;
  hasSubscriberFor(key: EventKey): boolean;
  metrics(): LogMetrics;
}
