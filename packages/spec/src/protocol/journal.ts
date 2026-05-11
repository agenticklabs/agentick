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
 * Spec uses `Promise` and `AsyncIterable` as canonical async return
 * types. This preserves `@agentick/spec`'s zero-dependency claim and
 * matches the blueprint's pattern (compiler-react is Effect-free; the
 * runtime bridges to Effect at its boundary).
 *
 * Implementations using Effect convert at the protocol boundary:
 *
 *   class MemoryJournal implements OperationJournal {
 *     append(event: ProtocolEvent): Promise<void> {
 *       return Effect.runPromise(this.appendEffect(event));
 *     }
 *     private appendEffect(event: ProtocolEvent):
 *       Effect.Effect<void, JournalError, never> { ... }
 *   }
 *
 * Errors are thrown (rejected); typed via JSDoc `@throws` annotations
 * and runtime tag checks. Implementations should reject with values
 * matching the corresponding error type (e.g., `JournalError`).
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The OperationJournal contract
 */

import type { ProtocolEvent, EventQuery, EventSurface } from "../data/events.js";
import type { TerminalEvent } from "../data/outcomes.js";

/**
 * Read-cursor position for `read()`.
 */
export type JournalReadFrom =
  | { readonly offset: number }
  | "latest"
  | "beginning";

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
 * @throws {JournalError} on write/read failures (as rejection value).
 */
export interface OperationJournal {
  /**
   * Append an envelope to the journal. Idempotent on
   * `(opId, phase)` pairs for operation envelopes — appending the same
   * envelope twice is a no-op.
   */
  append(event: ProtocolEvent): Promise<void>;

  /**
   * Append a batch atomically. Implementations that support transactional
   * append SHOULD use a single transaction. Implementations that don't
   * MAY fall back to sequential append.
   */
  appendBatch(events: readonly ProtocolEvent[]): Promise<void>;

  /**
   * Read events matching a query starting from a given offset.
   * Returns an AsyncIterable for streaming. The iterable terminates
   * when the journal has no more matching events at read time.
   */
  read(query: EventQuery, from: JournalReadFrom): AsyncIterable<ProtocolEvent>;

  /**
   * Subscribe to ongoing events matching a query. Returns an
   * AsyncIterable that yields new events as they are appended.
   *
   * Implementations MUST clean up the subscription when the consumer
   * stops iterating (e.g., via for-await early return). Use
   * `AbortSignal` for explicit cancellation.
   */
  tail(query: EventQuery, signal?: AbortSignal): AsyncIterable<ProtocolEvent>;

  /**
   * Idempotency lookup. Returns the cached terminal envelope's payload
   * if the operation has already terminated; otherwise `{ some: false }`.
   *
   * Used at command entry to short-circuit replays.
   */
  lookupTerminal(opId: string): Promise<Maybe<TerminalEvent>>;

  /**
   * Find operations stuck in `requested` (or `before`) without a
   * `terminal`. Used at boot for crash recovery.
   */
  findOrphaned(query?: OrphanQuery): Promise<readonly OrphanedOperation[]>;
}
