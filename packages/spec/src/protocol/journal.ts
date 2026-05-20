/**
 * OperationJournal protocol.
 *
 * The journal is the durable, append-only record of envelopes flowing
 * through the system. The substrate underneath operations,
 * idempotency, crash recovery, replay, audit.
 *
 * Implementations:
 *   - MemoryJournal       (in-process; Phase 2)
 *   - SqliteJournal       (single-process durable; Phase 5)
 *   - PostgresJournal     (production durable; Phase 5)
 *   - RedisStreamsJournal (cluster-distributed; Phase 5)
 *   - ClusterJournal      (@effect/cluster-backed; Phase 7)
 *
 * ## Async return discipline
 *
 * Spec uses `Effect<R, E, never>` for one-shot async operations and
 * `Stream<E, F, never>` for streaming reads. This is the substrate that
 * 19-foundation specifies. Errors are typed in the `E` channel as
 * tagged-union values matching `JournalError`.
 *
 * Promise-shaped consumers cross at the runtime edge via
 * `Effect.runPromise`. Inside the substrate, FiberRef scope, structured
 * concurrency, and `Effect.withSpan` propagate automatically.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The OperationJournal contract
 */

import type { Effect, Stream } from "effect";
import type { ProtocolEvent, EventQuery, EventSurface } from "../data/events.js";
import type { TerminalEvent } from "../data/outcomes.js";
import type { JournalError } from "../data/errors.js";

/**
 * Read-cursor position for `read()`.
 */
export type JournalReadFrom = { readonly offset: number } | "latest" | "beginning";

/**
 * Operation found by `findOrphaned()` — an operation that emitted
 * `requested` (or `before`) but never reached `terminal`. Used at boot
 * for crash recovery.
 */
export interface OrphanedOperation {
  readonly opId: string;
  readonly surface: EventSurface;
  readonly name: string;
  /** ISO timestamp of the latest envelope seen for this op. */
  readonly latestTimestamp: number;
}

/**
 * Filter for orphan discovery.
 */
export interface OrphanQuery {
  readonly surface?: EventSurface;
  /** Only return ops with latestTimestamp before now - olderThan. */
  readonly olderThan?: number;
}

/**
 * Optional-value sentinel for `lookupTerminal()`. Spec uses a plain
 * discriminated union rather than depending on Effect's `Option`.
 */
export type Maybe<T> = { readonly some: true; readonly value: T } | { readonly some: false };

/**
 * The journal protocol.
 *
 * Errors flow through the Effect `E` channel as tagged-union
 * `JournalError` values.
 */
export interface OperationJournal {
  /**
   * Append an envelope to the journal. Idempotent on
   * `(opId, phase)` pairs for operation envelopes — appending the same
   * envelope twice is a no-op.
   */
  append(event: ProtocolEvent): Effect.Effect<void, JournalError, never>;

  /**
   * Append a batch atomically. Implementations that support transactional
   * append SHOULD use a single transaction. Implementations that don't
   * MAY fall back to sequential append.
   */
  appendBatch(events: readonly ProtocolEvent[]): Effect.Effect<void, JournalError, never>;

  /**
   * Read events matching a query starting from a given offset.
   *
   * Returns a `Stream` of envelopes terminating when the journal has no
   * more matching events at read time.
   */
  read(query: EventQuery, from: JournalReadFrom): Stream.Stream<ProtocolEvent, JournalError, never>;

  /**
   * Subscribe to ongoing events matching a query.
   *
   * Returns a `Stream` that yields new events as they are appended.
   * Implementations MUST clean up the subscription when the stream is
   * interrupted (Effect's structured concurrency handles this via
   * scoped finalizers).
   */
  tail(query: EventQuery): Stream.Stream<ProtocolEvent, JournalError, never>;

  /**
   * Idempotency lookup. Returns the cached terminal envelope's payload
   * if the operation has already terminated; otherwise `{ some: false }`.
   *
   * Used at command entry to short-circuit replays.
   */
  lookupTerminal(opId: string): Effect.Effect<Maybe<TerminalEvent>, JournalError, never>;

  /**
   * Find operations stuck in `requested` (or `before`) without a
   * `terminal`. Used at boot for crash recovery.
   */
  findOrphaned(
    query?: OrphanQuery,
  ): Effect.Effect<readonly OrphanedOperation[], JournalError, never>;
}
