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
 * @see docs/proposals/v2/blueprint/49-stores-not-snapshots.md
 * @see MemoryTimelineStore — the bundled zero-dep default.
 */

import type { TimelineEntry } from "@agentick/spec-next";

/**
 * Adopter-pluggable durable backing for the timeline persisted tier — an
 * APPEND-ONLY event log keyed by `sessionId`.
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
   * On failure, **reject with any error** (`ENOSPC`, a driver error, a
   * network error). The harness wraps the rejection into the typed
   * `TimelineWriteFailed` at its boundary — adapters need not import spec
   * error types. `load` follows the same rule.
   */
  append(sessionId: string, entries: readonly TimelineEntry[]): Promise<void>;

  /**
   * Enumerate the sessions this store holds.
   *
   * **Foundational** per the `enumeration-is-foundational` rule: an
   * adopter inspecting durable state (a "resume which session?" UI, a
   * cluster node deciding what it can rehydrate) needs this without prior
   * knowledge of any specific id. Order is not specified.
   */
  sessions(): Promise<readonly string[]>;

  /**
   * Remove a session's entries entirely — session lifecycle end. Idempotent:
   * deleting an unknown session resolves normally. Returns `true` if entries
   * were actually removed, `false` if the session was absent.
   */
  delete(sessionId: string): Promise<boolean>;

  /**
   * DESTRUCTIVE retention / GDPR-class erasure — drop the entries of
   * `sessionId` whose sequence position is strictly below `before.seq`
   * (the number of leading entries to erase). Returns the count removed.
   *
   * **Never called by compaction** — the log is otherwise append-only.
   * Optional: adapters with no erasure requirement omit it.
   */
  prune?(sessionId: string, before: { seq: number }): Promise<number>;

  /** Self-identifying backend label for observability (e.g. `"memory"`, `"fs"`). */
  readonly backend: string;
}

/**
 * Bundled, zero-dependency {@link TimelineStore} — an in-process
 * `Map<sessionId, TimelineEntry[]>`. The default when no store is
 * injected; `:memory:` semantics (lost on process exit).
 *
 * Suitable for tests, the ephemeral local pole, and as the reference the
 * conformance suite validates itself against.
 */
export class MemoryTimelineStore implements TimelineStore {
  readonly backend = "memory";
  private readonly logs = new Map<string, TimelineEntry[]>();

  load(sessionId: string): Promise<readonly TimelineEntry[]> {
    const log = this.logs.get(sessionId);
    // Defensive copy — callers must not mutate our backing array, and our
    // append must not be visible through a reference the caller retained.
    return Promise.resolve(log ? [...log] : []);
  }

  append(sessionId: string, entries: readonly TimelineEntry[]): Promise<void> {
    if (entries.length === 0) return Promise.resolve();
    const log = this.logs.get(sessionId);
    if (log) log.push(...entries);
    else this.logs.set(sessionId, [...entries]);
    return Promise.resolve();
  }

  sessions(): Promise<readonly string[]> {
    return Promise.resolve([...this.logs.keys()]);
  }

  delete(sessionId: string): Promise<boolean> {
    return Promise.resolve(this.logs.delete(sessionId));
  }

  prune(sessionId: string, before: { seq: number }): Promise<number> {
    const log = this.logs.get(sessionId);
    if (!log) return Promise.resolve(0);
    const cut = Math.max(0, Math.min(before.seq, log.length));
    if (cut === 0) return Promise.resolve(0);
    log.splice(0, cut);
    if (log.length === 0) this.logs.delete(sessionId);
    return Promise.resolve(cut);
  }
}
