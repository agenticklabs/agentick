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

import type {
  EventQuery,
  ProtocolEvent,
  TerminalEvent,
} from "@agentick/spec";
import type {
  JournalReadFrom,
  Maybe,
  OperationJournal,
  OrphanedOperation,
  OrphanQuery,
} from "@agentick/spec";
import { matchesQuery } from "./query.js";

interface TailWaiter {
  readonly query: EventQuery;
  readonly signal?: AbortSignal;
  resolve: (e: ProtocolEvent | typeof DONE) => void;
}

const DONE = Symbol("journal-tail-done");

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

  private tailWaiters: TailWaiter[] = [];

  private closed = false;

  constructor(options: MemoryJournalOptions = {}) {
    this.capacity = options.capacity ?? 10_000;
  }

  async append(event: ProtocolEvent): Promise<void> {
    this.appendSync(event);
  }

  async appendBatch(events: readonly ProtocolEvent[]): Promise<void> {
    for (const e of events) this.appendSync(e);
  }

  private appendSync(event: ProtocolEvent): void {
    if (this.closed) {
      throw { _tag: "WriteFailed", cause: new Error("journal closed") };
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
      this.events.splice(0, overflow);
      this.dropped += overflow;
    }

    if (this.tailWaiters.length > 0) {
      const remaining: TailWaiter[] = [];
      for (const w of this.tailWaiters) {
        if (matchesQuery(event, w.query)) {
          w.resolve(event);
        } else {
          remaining.push(w);
        }
      }
      this.tailWaiters = remaining;
    }
  }

  read(query: EventQuery, from: JournalReadFrom): AsyncIterable<ProtocolEvent> {
    const snapshot = this.events.slice();
    const startIndex = this.resolveStart(from, snapshot.length);
    return iterate(snapshot, startIndex, query);
  }

  tail(query: EventQuery, signal?: AbortSignal): AsyncIterable<ProtocolEvent> {
    const journal = this;
    return {
      [Symbol.asyncIterator]() {
        let aborted = false;
        const onAbort = () => {
          aborted = true;
          for (const w of journal.tailWaiters) {
            if (w.signal === signal) w.resolve(DONE);
          }
          journal.tailWaiters = journal.tailWaiters.filter((w) => w.signal !== signal);
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        return {
          async next(): Promise<IteratorResult<ProtocolEvent>> {
            if (aborted || journal.closed) return { value: undefined, done: true };
            const next = await new Promise<ProtocolEvent | typeof DONE>((resolve) => {
              journal.tailWaiters.push({ query, signal, resolve });
            });
            if (next === DONE) return { value: undefined, done: true };
            return { value: next, done: false };
          },
          async return(): Promise<IteratorResult<ProtocolEvent>> {
            signal?.removeEventListener("abort", onAbort);
            onAbort();
            return { value: undefined, done: true };
          },
        };
      },
    };
  }

  async lookupTerminal(opId: string): Promise<Maybe<TerminalEvent>> {
    const t = this.terminals.get(opId);
    return t ? { some: true, value: t } : { some: false };
  }

  async findOrphaned(query: OrphanQuery = {}): Promise<readonly OrphanedOperation[]> {
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
  }

  // ────────── helpers ──────────

  private resolveStart(from: JournalReadFrom, snapshotLen: number): number {
    if (from === "beginning") return 0;
    if (from === "latest") return snapshotLen;
    if (typeof from === "object" && "offset" in from) {
      const local = from.offset - this.dropped;
      if (local < 0) {
        throw { _tag: "OffsetOutOfRange", requested: from.offset, oldest: this.dropped };
      }
      return Math.min(local, snapshotLen);
    }
    return 0;
  }

  /** Close the journal — pending tail iterators terminate. Test-friendly. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.tailWaiters) w.resolve(DONE);
    this.tailWaiters = [];
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

async function* iterate(
  snapshot: readonly ProtocolEvent[],
  startIndex: number,
  query: EventQuery,
): AsyncIterable<ProtocolEvent> {
  for (let i = startIndex; i < snapshot.length; i++) {
    const e = snapshot[i]!;
    if (matchesQuery(e, query)) yield e;
  }
}
