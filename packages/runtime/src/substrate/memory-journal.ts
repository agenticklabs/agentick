/**
 * In-process OperationJournal implementation.
 *
 * Append-only ring buffer with idempotency lookup and live-tail
 * subscribers. Bounded retention; oldest entries drop when capacity is
 * exceeded. Suitable for tests, examples, and single-process runtimes
 * where durability is not required.
 *
 * For durability switch to a backed implementation
 * (SqliteJournal/PostgresJournal/etc.) — they implement the same
 * `OperationJournal` interface.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The OperationJournal contract
 */

import { Effect, Stream } from "effect";
import type { EventQuery, JournalError, ProtocolEvent, TerminalEvent } from "@agentick/spec";
import type {
  FactoryDeps,
  JournalReadFrom,
  Lifecycle,
  Maybe,
  OperationJournal,
  OperationJournalFactory,
  OrphanedOperation,
  OrphanQuery,
} from "@agentick/spec";
import { compileQuery, type CompiledMatcher } from "./query.js";

interface TailListener {
  readonly query: EventQuery;
  /** Pre-compiled matcher closure (built at tail-subscribe time). */
  readonly matcher: CompiledMatcher;
  /** Push a matching event into the consumer's stream. */
  readonly onEvent: (event: ProtocolEvent) => void;
  /** Signal end-of-stream (journal closing). */
  readonly onDone: () => void;
}

export interface MemoryJournalOptions {
  /**
   * Maximum number of events retained. Oldest events drop on overflow.
   * Idempotency entries are preserved separately.
   *
   * Default: 10_000.
   */
  readonly capacity?: number;
}

export class MemoryJournal implements OperationJournal {
  private readonly capacity: number;
  private events: ProtocolEvent[] = [];
  /**
   * Absolute index of the oldest retained event. `events[i]` corresponds
   * to absolute offset `dropped + i`. Lets us expose stable offsets to
   * external consumers even after dropping.
   */
  private dropped = 0;
  /**
   * `(opId, phase)` keys we've already appended. Used to dedupe operation
   * lifecycle envelopes — appending the same (opId, phase) twice is a
   * no-op.
   */
  private appendedKeys = new Set<string>();
  /**
   * `opId` → terminal payload. Populated when a terminal envelope is
   * appended. Used by `lookupTerminal`.
   */
  private terminals = new Map<string, TerminalEvent>();
  /**
   * `opId` → earliest non-terminal envelope. Cleared once a terminal
   * is recorded. Used by `findOrphaned`.
   */
  private inFlight = new Map<string, ProtocolEvent>();

  private tailListeners = new Set<TailListener>();

  private closed = false;

  constructor(options: MemoryJournalOptions = {}) {
    this.capacity = options.capacity ?? 10_000;
  }

  /**
   * Build a per-session factory for {@link MemoryJournal}. The
   * returned factory is consumed by `AppHarnessOptions.journal` to
   * construct a fresh journal per session, with the journal's
   * `close()` auto-registered on the session's `Lifecycle.onClose`.
   *
   * Durable journals (SQLite, Postgres) ship their own `createFactory`
   * helpers in their respective adapter packages.
   *
   * @see docs/proposals/v2/blueprint/30-app-as-recipe.md
   */
  static createFactory(
    configFn?: (deps: FactoryDeps) => MemoryJournalOptions,
  ): OperationJournalFactory {
    const factory = (deps: FactoryDeps, lifecycle: Lifecycle): OperationJournal => {
      const journal = new MemoryJournal(configFn?.(deps));
      lifecycle.onClose(() => journal.close());
      return journal;
    };
    return Object.assign(factory, { operationJournalFactory: true as const });
  }

  append(event: ProtocolEvent): Effect.Effect<void, JournalError, never> {
    return Effect.try({
      try: () => this.appendSync(event),
      catch: (cause): JournalError => {
        if (isJournalError(cause)) return cause;
        return { _tag: "WriteFailed", cause };
      },
    });
  }

  appendBatch(events: readonly ProtocolEvent[]): Effect.Effect<void, JournalError, never> {
    return Effect.try({
      try: () => {
        for (const e of events) this.appendSync(e);
      },
      catch: (cause): JournalError => {
        if (isJournalError(cause)) return cause;
        return { _tag: "WriteFailed", cause };
      },
    });
  }

  private appendSync(event: ProtocolEvent): void {
    if (this.closed) {
      throw { _tag: "WriteFailed", cause: new Error("journal closed") } satisfies JournalError;
    }

    // Idempotency dedup on (opId, phase) for operation envelopes.
    if (event.opId) {
      const key = `${event.opId}::${event.phase}`;
      if (this.appendedKeys.has(key)) return;
      this.appendedKeys.add(key);

      if (event.phase === "terminal") {
        const terminal = extractTerminal(event);
        if (terminal) this.terminals.set(event.opId, terminal);
        this.inFlight.delete(event.opId);
      } else if (!this.terminals.has(event.opId)) {
        // Track earliest non-terminal sighting for orphan detection.
        if (!this.inFlight.has(event.opId)) this.inFlight.set(event.opId, event);
      }
    }

    this.events.push(event);
    if (this.events.length > this.capacity) {
      const overflow = this.events.length - this.capacity;
      const evicted = this.events.splice(0, overflow);
      this.dropped += overflow;

      // L7 — keep idempotency state bounded by the ring's drop point.
      // Each evicted event releases its (opId, phase) key plus the
      // terminals / inFlight maps it contributed to. MemoryJournal is
      // explicitly non-durable; losing dedup state when its visible
      // window scrolls is acceptable. Durable journals (sqlite, pg)
      // implement the dedup against their backing store and aren't
      // affected.
      for (const e of evicted) {
        if (!e.opId) continue;
        this.appendedKeys.delete(`${e.opId}::${e.phase}`);
        if (e.phase === "terminal") this.terminals.delete(e.opId);
        // Clear orphan tracking when its earliest sighting evicts.
        const tracked = this.inFlight.get(e.opId);
        if (tracked === e) this.inFlight.delete(e.opId);
      }
    }

    for (const listener of this.tailListeners) {
      if (listener.matcher(event)) listener.onEvent(event);
    }
  }

  read(
    query: EventQuery,
    from: JournalReadFrom,
  ): Stream.Stream<ProtocolEvent, JournalError, never> {
    return Stream.suspend(() => {
      const snapshot = this.events.slice();
      let startIndex: number;
      try {
        startIndex = this.resolveStart(from, snapshot.length);
      } catch (cause) {
        return Stream.fail<JournalError>(
          isJournalError(cause) ? cause : { _tag: "ReadFailed", cause },
        );
      }
      const matched: ProtocolEvent[] = [];
      const matcher = compileQuery(query);
      for (let i = startIndex; i < snapshot.length; i++) {
        const e = snapshot[i]!;
        if (matcher(e)) matched.push(e);
      }
      return Stream.fromIterable(matched);
    });
  }

  tail(query: EventQuery): Stream.Stream<ProtocolEvent, JournalError, never> {
    const journal = this;
    return Stream.asyncPush<ProtocolEvent>((emit) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          if (journal.closed) {
            emit.end();
            return undefined as TailListener | undefined;
          }
          const listener: TailListener = {
            query,
            matcher: compileQuery(query),
            onEvent: (event) => {
              void emit.single(event);
            },
            onDone: () => emit.end(),
          };
          journal.tailListeners.add(listener);
          return listener;
        }),
        (listener) =>
          Effect.sync(() => {
            if (listener) journal.tailListeners.delete(listener);
          }),
      ),
    );
  }

  lookupTerminal(opId: string): Effect.Effect<Maybe<TerminalEvent>, JournalError, never> {
    return Effect.sync(() => {
      const t = this.terminals.get(opId);
      return t ? ({ some: true, value: t } as const) : ({ some: false } as const);
    });
  }

  findOrphaned(
    query: OrphanQuery = {},
  ): Effect.Effect<readonly OrphanedOperation[], JournalError, never> {
    return Effect.sync(() => {
      const olderThan = query.olderThan;
      const surface = query.surface;
      const cutoff = olderThan === undefined ? Number.POSITIVE_INFINITY : Date.now() - olderThan;
      const out: OrphanedOperation[] = [];
      for (const [opId, earliest] of this.inFlight) {
        if (surface && earliest.surface !== surface) continue;
        // Find the latest seen envelope for this opId in our retained slice.
        let latest = earliest;
        for (let i = this.events.length - 1; i >= 0; i--) {
          const e = this.events[i]!;
          if (e.opId === opId) {
            latest = e;
            break;
          }
        }
        if (latest.timestamp > cutoff) continue;
        out.push({
          opId,
          surface: latest.surface,
          name: latest.name,
          latestTimestamp: latest.timestamp,
        });
      }
      return out;
    });
  }

  // ────────── helpers ──────────

  private resolveStart(from: JournalReadFrom, snapshotLen: number): number {
    if (from === "beginning") return 0;
    if (from === "latest") return snapshotLen;
    if (typeof from === "object" && "offset" in from) {
      const local = from.offset - this.dropped;
      if (local < 0) {
        throw {
          _tag: "OffsetOutOfRange",
          requested: from.offset,
          oldest: this.dropped,
        } satisfies JournalError;
      }
      return Math.min(local, snapshotLen);
    }
    return 0;
  }

  /** Close the journal — pending tail iterators terminate. Test-friendly. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const l of this.tailListeners) l.onDone();
    this.tailListeners.clear();
  }

  /** Diagnostic: total events ever appended (including dropped). */
  totalAppended(): number {
    return this.dropped + this.events.length;
  }
}

function extractTerminal(envelope: ProtocolEvent): TerminalEvent | undefined {
  if (envelope.phase !== "terminal" || !envelope.outcome) return undefined;
  const outcome = envelope.outcome;
  const payload = envelope.payload as Record<string, unknown> | undefined;
  switch (outcome) {
    case "succeeded":
      return { outcome, result: payload?.result };
    case "failed":
      return { outcome, error: payload?.error ?? envelope.error };
    case "canceled":
      return { outcome, reason: payload?.reason as string | undefined };
    case "vetoed":
      return { outcome, reason: payload?.reason as string | undefined };
    case "replaced":
      return {
        outcome,
        result: payload?.result,
        reason: payload?.reason as string | undefined,
      };
    case "deferred":
      return {
        outcome,
        retryAfter: payload?.retryAfter as number | undefined,
      };
  }
}

function isJournalError(value: unknown): value is JournalError {
  if (typeof value !== "object" || value === null) return false;
  const tag = (value as { _tag?: unknown })._tag;
  return tag === "WriteFailed" || tag === "ReadFailed" || tag === "OffsetOutOfRange";
}
