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
import type { EventLog } from "./event-log.js";

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
 * `OperationJournal extends EventLog<ProtocolEvent>` — the journal is
 * a specialisation of the append-only log primitive. It inherits the
 * log methods (`append`, `appendBatch`, `read(cursor, matcher)`,
 * `hasSubscriberFor`, `metrics`) and adds journal-specific surface:
 * query-shaped historical reads (`readByQuery`), tail subscriptions
 * (`tail`), idempotency lookup (`lookupTerminal`), and orphan
 * discovery (`findOrphaned`).
 *
 * Errors on the log-primitive methods flow through their declared
 * `never` channel (matching the EventLog contract). Journal-specific
 * methods use `JournalError` as before.
 *
 * Phase C of ADR 29 unified the bus and journal under `EventLog<E>`.
 */
export interface OperationJournal extends EventLog<ProtocolEvent, JournalError> {
  /**
   * Idempotency lookup. Returns the cached terminal envelope's payload
   * if the operation has already terminated; otherwise `{ some: false }`.
   *
   * Used at command entry to short-circuit replays.
   */
  lookupTerminal(opId: string): Effect.Effect<Maybe<TerminalEvent>, JournalError, never>;

  /**
   * Read events matching a query starting from a given offset.
   *
   * Returns a `Stream` of envelopes terminating when the journal has no
   * more matching events at read time. Journal-specific historical-query
   * sugar over the {@link EventLog.read} cursor primitive — adopters
   * who already have a cursor pass it directly to `read(cursor, matcher)`.
   */
  readByQuery(
    query: EventQuery,
    from: JournalReadFrom,
  ): Stream.Stream<ProtocolEvent, JournalError, never>;

  /**
   * Subscribe to ongoing events matching a query.
   *
   * Returns a `Stream` that yields new events as they are appended.
   * Implementations MUST clean up the subscription when the stream is
   * interrupted (Effect's structured concurrency handles this via
   * scoped finalizers).
   *
   * Journal-specific sugar that wraps `read(latest-cursor, matcher)`
   * with `JournalError` translation.
   */
  tail(query: EventQuery): Stream.Stream<ProtocolEvent, JournalError, never>;

  /**
   * Find operations stuck in `requested` (or `before`) without a
   * `terminal`. Used at boot for crash recovery.
   */
  findOrphaned(
    query?: OrphanQuery,
  ): Effect.Effect<readonly OrphanedOperation[], JournalError, never>;
}

// ============================================================================
// OperationJournalFactory — deferred per-session construction (ADR 30)
// ============================================================================

import type { Factory } from "./factory.js";

/**
 * Per-child factory shape for {@link OperationJournal}. Adopters
 * supply the `journal` slot at any level of the harness hierarchy as
 * either an instance (shared across children) or a factory
 * (constructed per child via the recipe pattern).
 *
 * Use `MemoryJournal.createFactory(...)` from `@agentick/runtime` for
 * ergonomic factory construction with auto-registered close. Durable
 * journals (SQLite, Postgres) ship their own `createFactory` helpers
 * in their respective adapter packages.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
 */
export type OperationJournalFactory<P = unknown> = Factory<OperationJournal, P>;
