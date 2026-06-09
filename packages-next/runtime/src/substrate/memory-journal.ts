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

import { Effect, Option, Stream } from "effect";
import type {
  Cursor,
  EventKey,
  EventQuery,
  JournalError,
  LogMetrics,
  ProtocolEvent,
  TerminalEvent,
} from "@agentick/spec-next";
import { CursorEvictedError } from "@agentick/spec-next";
import type {
  JournalReadFrom,
  Maybe,
  OperationJournal,
  OperationJournalFactory,
  OrphanedOperation,
  OrphanQuery,
} from "@agentick/spec-next";
import { compileQuery, type CompiledMatcher } from "./query.js";

/** Minimal parent-harness shape that `MemoryJournal.createFactory` consumes. */
export interface MemoryJournalFactoryParent {
  readonly journal?: OperationJournal;
  onClose(handler: () => void | Promise<void>): void;
}

/**
 * Cursor-based subscriber state. Phase C of ADR 29 unifies `tail` and
 * the new `read(cursor, matcher)` under one mechanism — both register
 * a `CursorSub`, both pull events from the journal's append sequence
 * via a wake-on-append signal.
 */
interface CursorSub {
  /** Pre-compiled matcher closure (built at subscribe time). */
  readonly matcher: CompiledMatcher;
  /** Position of the next event to read. Advances as events are yielded. */
  cursor: number;
  /** Resolver for the subscriber's wake. Set when parked at head. */
  resolveWake?: () => void;
  /** Once true, the subscriber's read loop terminates on next pull. */
  closed: boolean;
}

export interface MemoryJournalOptions {
  /**
   * Maximum number of events retained. Oldest events drop on overflow.
   * Idempotency entries are preserved separately.
   *
   * Default: 10_000.
   */
  readonly capacity?: number;
  /**
   * Upstream journal this MemoryJournal fans appends into, if any.
   * When set, every {@link append} additionally appends to the parent;
   * reads from THIS journal return only local entries. **Fan-in
   * writes, isolated reads.** Same composition semantic as
   * `LocalEventBus`.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md §Composable substrate primitives
   */
  readonly parent?: OperationJournal;
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

  /**
   * Active cursor-pull subscribers. Phase C — single mechanism for
   * both {@link tail} (live-from-head) and {@link read} (from any cursor).
   */
  private cursorSubs = new Set<CursorSub>();

  private closed = false;

  /** Running eviction count for {@link metrics}. */
  private evictionCount = 0;

  /** Construction time — used by metrics() for the long-run event-rate fallback. */
  private readonly creationTime = Date.now();

  /**
   * Upstream journal this MemoryJournal fans appends into, if any.
   * When set, every append additionally calls the parent's append;
   * reads on this journal return only local entries.
   */
  private readonly upstream?: OperationJournal;

  constructor(options: MemoryJournalOptions = {}) {
    this.capacity = options.capacity ?? 10_000;
    this.upstream = options.parent;
  }

  /**
   * Build a per-child factory for {@link MemoryJournal}. Consumed by
   * any harness's `journal` slot in the hierarchy. The factory
   * constructs a fresh journal per call and auto-registers its
   * `close()` on the supplied parent's `onClose`.
   *
   * If the parent harness has a `journal` field, it's threaded
   * through as the upstream by default — appends fan in to the parent;
   * reads stay local. To suppress this and construct a leaf journal,
   * the configFn returns `{ parent: undefined }` explicitly.
   *
   * Durable journals (SQLite, Postgres) ship their own `createFactory`
   * helpers in their respective adapter packages.
   *
   * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
   */
  static createFactory<P extends MemoryJournalFactoryParent>(
    configFn?: (parent: P) => MemoryJournalOptions,
  ): OperationJournalFactory<P> {
    return (parent: P): OperationJournal => {
      const options = configFn
        ? configFn(parent)
        : ({ parent: parent.journal } as MemoryJournalOptions);
      const journal = new MemoryJournal(options);
      parent.onClose(() => journal.close());
      return journal;
    };
  }

  /**
   * Static-options sugar over {@link createFactory}. Default fan-in:
   * `parent.journal` is threaded through as the upstream automatically
   * (appends fan in, reads stay local). Adopters pass
   * `{ parent: undefined }` to suppress.
   *
   * @example default — fans in to parent.journal:
   * ```ts
   * { journal: MemoryJournal.factory({ capacity: 50_000 }) }
   * ```
   *
   * @example explicit leaf (no upstream):
   * ```ts
   * { journal: MemoryJournal.factory({ parent: undefined, capacity: 50_000 }) }
   * ```
   */
  static factory<P extends MemoryJournalFactoryParent>(
    options?: MemoryJournalOptions,
  ): OperationJournalFactory<P> {
    return MemoryJournal.createFactory<P>((parent) => ({
      parent: parent.journal,
      ...(options ?? {}),
    }));
  }

  append(event: ProtocolEvent): Effect.Effect<void, JournalError, never> {
    const local = Effect.try({
      try: () => this.appendSync(event),
      catch: (cause): JournalError => {
        if (isJournalError(cause)) return cause;
        return { _tag: "WriteFailed", cause };
      },
    });
    // Fan-in to upstream when composed.
    return this.upstream
      ? Effect.all([local, this.upstream.append(event)], {
          discard: true,
          concurrency: "unbounded",
        })
      : local;
  }

  appendBatch(events: readonly ProtocolEvent[]): Effect.Effect<void, JournalError, never> {
    const local = Effect.try({
      try: () => {
        for (const e of events) this.appendSync(e);
      },
      catch: (cause): JournalError => {
        if (isJournalError(cause)) return cause;
        return { _tag: "WriteFailed", cause };
      },
    });
    if (!this.upstream) return local;
    // appendBatch may not be on every OperationJournal impl — fall
    // back to one-at-a-time for protocols that only expose `append`.
    const up = this.upstream;
    const upstreamBatch = up.appendBatch
      ? up.appendBatch(events)
      : Effect.forEach(events, (e) => up.append(e), { discard: true });
    return Effect.all([local, upstreamBatch], {
      discard: true,
      concurrency: "unbounded",
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
      this.evictionCount += overflow;

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

    // Wake every cursor subscriber. Each will check its cursor against
    // the new head on its next pullOne step and yield matching events.
    for (const sub of this.cursorSubs) {
      if (sub.closed) continue;
      const fn = sub.resolveWake;
      if (fn) {
        sub.resolveWake = undefined;
        fn();
      }
    }
  }

  // ============================================================================
  // EventLog<ProtocolEvent, JournalError>
  // ============================================================================

  read(
    cursor: Cursor,
    matcher: CompiledMatcher,
  ): Stream.Stream<ProtocolEvent, CursorEvictedError, never> {
    const j = this;
    return Stream.unwrapScoped(
      Effect.gen(function* () {
        if (j.closed) {
          return Stream.empty as Stream.Stream<ProtocolEvent, CursorEvictedError, never>;
        }

        // Bounds-check the requested cursor against current retention.
        // `dropped` is the cursor of the oldest retained event; anything
        // earlier has been evicted by the ring buffer's sliding window.
        if (cursor.value < j.dropped) {
          return Stream.fail(
            new CursorEvictedError({ value: cursor.value }, { value: j.dropped }),
          ) as Stream.Stream<ProtocolEvent, CursorEvictedError, never>;
        }

        const sub: CursorSub = {
          matcher,
          cursor: cursor.value,
          resolveWake: undefined,
          closed: false,
        };
        j.cursorSubs.add(sub);

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sub.closed = true;
            j.cursorSubs.delete(sub);
            const wake = sub.resolveWake;
            sub.resolveWake = undefined;
            if (wake) wake();
          }),
        );

        return Stream.unfoldEffect(undefined as void, () => j.pullOne(sub));
      }),
    );
  }

  hasSubscriberFor(_key: EventKey): boolean {
    // Journals don't ship a per-surface subscriber index — cursor subs
    // carry an opaque matcher, not a query shape. Conservative true
    // when any sub exists (false-negative would be a correctness bug;
    // conservative true is acceptable per the EventLog contract).
    if (this.closed) return false;
    for (const sub of this.cursorSubs) if (!sub.closed) return true;
    return false;
  }

  metrics(): LogMetrics {
    const now = Date.now();
    const elapsedSec = Math.max((now - this.creationTime) / 1000, 0.001);
    const headCursor = this.dropped + this.events.length;
    const eventsPerSecond = headCursor / elapsedSec;

    let activeSubs = 0;
    const lags: number[] = [];
    for (const sub of this.cursorSubs) {
      if (sub.closed) continue;
      activeSubs++;
      if (sub.cursor >= headCursor) {
        lags.push(0);
        continue;
      }
      // True wall-clock lag: now - timestamp of the event at the
      // subscriber's current cursor.
      const idx = sub.cursor - this.dropped;
      const ev = idx >= 0 && idx < this.events.length ? this.events[idx] : undefined;
      const ts = ev?.timestamp ?? 0;
      lags.push(ts > 0 ? Math.max(0, now - ts) : 0);
    }
    const cursorLagP99 = lags.length === 0 ? 0 : percentile(lags, 0.99);

    return {
      eventsPerSecond,
      subscriberCount: activeSubs,
      cursorLagP99,
      dropRate: headCursor === 0 ? 0 : this.evictionCount / headCursor,
      retentionEvents: this.events.length,
    };
  }

  // ============================================================================
  // Journal-specific surface (query-shaped reads + idempotency + orphans)
  // ============================================================================

  readByQuery(
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
    // Live tail = cursor-pull from the current head.
    // Map CursorEvictedError → JournalError so the journal's failure
    // channel stays uniform.
    const cursor: Cursor = { value: this.dropped + this.events.length };
    return this.read(cursor, compileQuery(query)).pipe(
      Stream.catchAll((err) =>
        Stream.fail<JournalError>({ _tag: "ReadFailed", cause: err }),
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

  /**
   * Close the journal. Pending cursor subscribers' streams terminate
   * cleanly via `pullOne`'s `closed` check (drains matching events
   * from cursor → head first, then ends the stream via `Option.none`).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    const wakes: (() => void)[] = [];
    for (const sub of this.cursorSubs) {
      sub.closed = true;
      if (sub.resolveWake) {
        wakes.push(sub.resolveWake);
        sub.resolveWake = undefined;
      }
    }
    this.cursorSubs.clear();
    for (const w of wakes) w();
  }

  /** Diagnostic: total events ever appended (including dropped). */
  totalAppended(): number {
    return this.dropped + this.events.length;
  }

  /**
   * One step of a cursor subscriber's read loop. Drains matching events
   * from `sub.cursor` up to current head; if caught up and closed,
   * ends the stream via `Option.none`; otherwise parks on wake;
   * surfaces `CursorEvictedError` if the cursor fell past retention.
   */
  private pullOne(
    sub: CursorSub,
  ): Effect.Effect<Option.Option<readonly [ProtocolEvent, void]>, CursorEvictedError, never> {
    const j = this;
    return Effect.gen(function* () {
      while (true) {
        if (sub.cursor < j.dropped) {
          return yield* Effect.fail(
            new CursorEvictedError({ value: sub.cursor }, { value: j.dropped }),
          );
        }

        const head = j.dropped + j.events.length;
        while (sub.cursor < head) {
          const idx = sub.cursor - j.dropped;
          const event = j.events[idx]!;
          sub.cursor++;
          if (sub.matcher(event)) return Option.some([event, undefined] as const);
        }

        if (sub.closed) return Option.none();

        yield* Effect.async<void, never, never>((resume) => {
          if (sub.closed || sub.cursor < j.dropped + j.events.length) {
            resume(Effect.void);
            return;
          }
          sub.resolveWake = () => {
            sub.resolveWake = undefined;
            resume(Effect.void);
          };
        });
      }
    });
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx]!;
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
