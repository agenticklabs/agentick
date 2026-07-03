/**
 * `TimelineStore` — the durable backing for the timeline **persisted
 * tier** (ADR 49, "stores, not snapshots"). The flagship instance of the
 * store-port pattern generalized from `CredentialsStore`
 * (`packages-next/credentials/src/store.ts`).
 *
 * The persisted tier is an **append-only event log**. Recovery is a fold
 * over that log; there is deliberately **no `replace`** — rewriting the
 * log would make the event-sourcing claim false (an event log you rewrite
 * is mutable state with extra steps). Compaction operates on the
 * *projection* tier only and never touches the store. The one destructive
 * operation, {@link TimelineStore.prune}, is for retention / GDPR-class
 * erasure and is **never called by compaction**.
 *
 * One store instance serves every session the harness hosts; entries are
 * keyed by `sessionId`. All operations are Promise-shaped — real backends
 * hit disk / network; the bundled in-memory default resolves synchronously
 * inside Promises.
 *
 * ## `seq` — the ordering identity (frozen contract, #133)
 *
 * Every appended entry is assigned a **`seq`**: a per-session integer that
 * is **strictly increasing, never reused, and stable across `prune`**. It
 * is the durable ordering key — a Postgres `BIGSERIAL`, a JSONL line
 * ordinal, the offset in a Kafka partition. This is pinned on the port
 * *before* any DB adapter exists on purpose: schema-on-read versioning
 * protects opaque payloads, not a missing ordering column, and a serial
 * column cannot reproduce positional/renumbering semantics after the fact.
 *
 * The guarantees, and only these (the start value + contiguity are
 * implementation-defined so a `BIGSERIAL` adapter is conformant):
 *
 *   - **strictly increasing** within a session — a later append gets a
 *     higher `seq` than any earlier one;
 *   - **never reused** — `prune`-ing entries or emptying a session never
 *     lets a future append reuse a retired `seq`;
 *   - **stable across `prune`** — a surviving entry keeps the `seq` it was
 *     assigned; a cursor held before a `prune` stays valid.
 *
 * `seq` is **store-assigned, not a field on `TimelineEntry`** — it is the
 * store's ordering key, surfaced as the return of {@link append} and the
 * argument to {@link prune}. Cursored reads (`load({ fromSeq })`,
 * seq-tagged entries, `history()` paging) are the deferred **additive**
 * extension the frozen `seq` unlocks; they are not part of this contract.
 *
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 * @see MemoryTimelineStore — the bundled zero-dep default.
 */

import type { TimelineEntry } from "@agentick/spec-next";

/**
 * Adopter-pluggable durable backing for the timeline persisted tier — an
 * APPEND-ONLY event log keyed by `sessionId`, ordered by `seq`.
 *
 * Reference adapters ship as separate packages (ADR 49 §"reference
 * adapters"): `@agentick/timeline-fs-next` (JSONL, local pole),
 * `@agentick/timeline-sqlite-next` (recommended first durable, native dep
 * so never bundled), `@agentick/timeline-postgres-next` (cloud pole). The
 * bundled default is {@link MemoryTimelineStore}.
 */
export interface TimelineStore {
  /**
   * Full ordered read of a session's persisted entries — the fold input
   * for hydration. Returns `[]` for a session the store has never seen.
   */
  load(sessionId: string): Promise<readonly TimelineEntry[]>;

  /**
   * Append entries for a session, in order. Called by the write-behind
   * pump (batched) or per-append in write-through mode. **The only
   * write** — the persisted tier is otherwise append-only.
   *
   * Returns the **`seq` assigned to each entry**, in input order (the
   * `INSERT ... RETURNING seq` shape). Empty for an empty append. The
   * seqs are strictly increasing and never reused (see the port docs).
   *
   * On failure, **reject with any error** (`ENOSPC`, a driver error, a
   * network error). The harness wraps the rejection into the typed
   * `TimelineWriteFailed` at its boundary — adapters need not import spec
   * error types. `load` follows the same rule.
   */
  append(sessionId: string, entries: readonly TimelineEntry[]): Promise<readonly number[]>;

  /**
   * Enumerate the sessions this store holds entries for.
   *
   * **Foundational** per the `enumeration-is-foundational` rule: an
   * adopter inspecting durable state (a "resume which session?" UI, a
   * cluster node deciding what it can rehydrate) needs this without prior
   * knowledge of any specific id. Order is not specified. A session whose
   * entries were all `prune`-d away is not listed (it holds nothing),
   * though its `seq` counter continues if it is appended to again.
   */
  sessions(): Promise<readonly string[]>;

  /**
   * Remove a session's entries entirely — session lifecycle end. Idempotent:
   * deleting an unknown session resolves normally. Returns `true` if entries
   * were actually removed, `false` if the session was absent. Unlike
   * {@link prune}, this ends the session: a subsequent append starts a
   * fresh `seq` sequence.
   */
  delete(sessionId: string): Promise<boolean>;

  /**
   * DESTRUCTIVE retention / GDPR-class erasure — drop the entries of
   * `sessionId` whose **absolute `seq` is strictly below `before.seq`**.
   * Returns the count removed. Surviving entries keep their `seq`, and the
   * session's `seq` counter is unaffected — a later append continues from
   * where it left off, never reusing an erased `seq`.
   *
   * **Never called by compaction** — the log is otherwise append-only.
   * Optional: adapters with no erasure requirement omit it.
   */
  prune?(sessionId: string, before: { seq: number }): Promise<number>;

  /** Self-identifying backend label for observability (e.g. `"memory"`, `"fs"`). */
  readonly backend: string;
}

/** Per-session record: the live entries plus the `seq` of `entries[0]`. */
interface SessionLog {
  entries: TimelineEntry[];
  /** Absolute `seq` of `entries[0]`. Advances as leading entries are pruned. */
  baseSeq: number;
}

/**
 * Bundled, zero-dependency {@link TimelineStore} — an in-process
 * append-only log per session. The default when no store is injected;
 * `:memory:` semantics (lost on process exit).
 *
 * `seq` is tracked as `baseSeq + index`: the log holds a contiguous window
 * of the session's history, and `baseSeq` (the absolute `seq` of the first
 * live entry) advances on `prune` so survivors keep their `seq` and the
 * next append never reuses one. This is the reference the conformance
 * suite validates every adapter against.
 *
 * Suitable for tests and the ephemeral local pole.
 */
export class MemoryTimelineStore implements TimelineStore {
  readonly backend = "memory";
  private readonly logs = new Map<string, SessionLog>();

  load(sessionId: string): Promise<readonly TimelineEntry[]> {
    const rec = this.logs.get(sessionId);
    // Defensive copy — callers must not mutate our backing array, and our
    // append must not be visible through a reference the caller retained.
    return Promise.resolve(rec ? [...rec.entries] : []);
  }

  append(sessionId: string, entries: readonly TimelineEntry[]): Promise<readonly number[]> {
    if (entries.length === 0) return Promise.resolve([]);
    let rec = this.logs.get(sessionId);
    if (!rec) {
      rec = { entries: [], baseSeq: 0 };
      this.logs.set(sessionId, rec);
    }
    // nextSeq = baseSeq + entries.length (the seq the first new entry gets).
    const start = rec.baseSeq + rec.entries.length;
    rec.entries.push(...entries);
    return Promise.resolve(entries.map((_, i) => start + i));
  }

  sessions(): Promise<readonly string[]> {
    // Only sessions that currently hold entries — a pruned-empty session
    // retains its `seq` counter but has nothing to enumerate.
    const held: string[] = [];
    for (const [id, rec] of this.logs) {
      if (rec.entries.length > 0) held.push(id);
    }
    return Promise.resolve(held);
  }

  delete(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.logs.delete(sessionId));
  }

  prune(sessionId: string, before: { seq: number }): Promise<number> {
    const rec = this.logs.get(sessionId);
    if (!rec) return Promise.resolve(0);
    // Erase entries with absolute seq < before.seq. entries[i] has absolute
    // seq baseSeq + i, so cut = clamp(before.seq - baseSeq, 0, length).
    const cut = Math.max(0, Math.min(before.seq - rec.baseSeq, rec.entries.length));
    if (cut === 0) return Promise.resolve(0);
    rec.entries.splice(0, cut);
    // Advance baseSeq so survivors keep their absolute seq and the next
    // append continues monotonically. The record is retained even when now
    // empty — the session lives; only `delete` ends the seq sequence.
    rec.baseSeq += cut;
    return Promise.resolve(cut);
  }
}
