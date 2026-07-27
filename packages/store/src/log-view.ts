/**
 * `LogView<T>` — the harness-held, SYNCHRONOUS projection of a {@link LogStore}.
 * The LOG-archetype sibling of {@link View}: where `View` projects a keyed
 * {@link import("@agentick/spec").CollectionStore} (the collection
 * archetype), `LogView` projects an append-only {@link LogStore} (the log
 * archetype). Together they are the two projection primitives over the two store
 * archetypes.
 *
 * A store-backed *log* harness (timeline today; any future event-sourced entry
 * log) re-hand-rolled the SAME machine: a durable append-only tier, a
 * materialized projection tier that a compaction target diverges, monotonic
 * version counters, an identity-stable render-snapshot cache, a keyless render
 * {@link Notifier}, and a **write-behind pump** that keeps store latency off the
 * tick loop. `LogView` is that machine, extracted verbatim and made generic
 * over the entry type `T`.
 *
 * ## Two tiers — durable log + materialized projection
 *
 *   - **persisted** — the durable, append-only log. Only {@link append} mutates
 *     it; once an entry lands it is never removed or rewritten. The source of
 *     truth for "what happened."
 *   - **projection** — what {@link read} / {@link snapshot} expose. Normally a
 *     live mirror of persisted; {@link replaceProjection} (the compaction
 *     target) and {@link resetProjection} diverge / re-mirror it. Subsequent
 *     appends land at the tail of BOTH tiers — the natural "compacted prefix +
 *     recent" shape. The durable log is never rewritten by a projection
 *     mutation.
 *
 * ## The write-behind pump (moves whole)
 *
 * With `writePolicy: "behind"` (memory-authoritative), {@link append} updates
 * both tiers synchronously and buffers the durable write; a single-flight pump
 * drains the buffer to the store off the critical path. **The pump never
 * rejects** — a failed batch is absorbed into a latched `pumpError` so an
 * un-awaited pump can never become an unhandled rejection. {@link flush} is the
 * single barrier that surfaces that latched error, mapped through the injected
 * {@link LogViewConfig.wrapWriteError} into the adopter's typed boundary error.
 * With `writePolicy: "through"`, {@link append} awaits the store inline and
 * surfaces a failed write immediately (same wrapped error), for products that
 * demand zero loss at the cost of per-append latency.
 *
 * `StoreCtx` threads the runtime scope across the Effect→Promise boundary; the
 * view is Promise-shaped and never reads ambient context. The ctx passed to
 * {@link append} is captured for the pump batch it kicks.
 *
 * ## Genesis is the caller's (ADR 93)
 *
 * The view does NOT read the store to initialize itself. {@link seed} installs
 * entries the consuming harness's `hydrate(ctx)` seam produced — the whole log,
 * a bounded tail, a journal fold, synthetic ephemera. The view holds the machine;
 * the harness owns the policy.
 *
 * @see docs/proposals/v2/data-layer-plan.md
 * @see View — the collection-archetype sibling projection.
 * @verifiedBy packages/store/src/__tests__/log-view.spec.ts
 */

import type { LogStore, StoreCtx } from "@agentick/spec";
import { createNotifier, type Notifier, type Unsubscribe } from "@agentick/pubsub";

/**
 * Provenance of the last {@link LogView.replaceProjection} — recorded on the
 * snapshot so a later restore can describe / replay the projection divergence.
 * `source` names which tier the projection was folded from; `strategyMetadata`
 * is opaque adopter metadata (a compaction strategy id, a window size, …).
 */
export interface LogProjectionMeta {
  readonly at: number;
  readonly source: "persisted" | "projection";
  readonly entriesBefore: number;
  readonly entriesAfter: number;
  readonly strategyMetadata?: Readonly<Record<string, unknown>>;
}

/** The identity-stable render snapshot {@link LogView.snapshot} returns. */
export interface LogViewReadSnapshot<T> {
  readonly entries: readonly T[];
  /** Monotonic counter; bumps on every projection mutation. */
  readonly version: number;
}

/**
 * The serializable both-tiers snapshot {@link LogView.exportSnapshot} produces
 * and {@link LogView.importSnapshot} restores — the durable log, the projection,
 * both version counters, and the last-projection provenance. Generic over `T`;
 * `LogViewSnapshot<TimelineEntry>` is structurally the timeline harness's own
 * snapshot shape.
 */
export interface LogViewSnapshot<T> {
  /** Append-only log entries in order. */
  readonly persisted: readonly T[];
  /** The projection at snapshot time (may equal `persisted` if never diverged). */
  readonly projection: readonly T[];
  readonly persistedVersion: number;
  readonly projectionVersion: number;
  /** Provenance of the last `replaceProjection`, if any. */
  readonly lastCompaction?: LogProjectionMeta;
}

/**
 * How {@link LogView.importSnapshot} treats the snapshot's projection tier:
 *   - `"as-is"` (default) — trust the snapshot's projection + version + last
 *     provenance verbatim (fastest; no recomputation).
 *   - `"reset-projection"` — restore only the durable log; the projection
 *     re-initializes as a live mirror of persisted (the caller re-runs its own
 *     projection build afterwards if desired).
 */
export type LogViewImportMode = "as-is" | "reset-projection";

export interface LogViewConfig<T> {
  readonly store: LogStore<T>;
  /** The log partition to project (timeline's `logKey` is the `sessionId`). */
  readonly logKey: string;
  /**
   * `"behind"` — memory-authoritative write-behind pump (no store latency in
   * the tick loop; durability at the {@link LogView.flush} barrier).
   * `"through"` — every append awaits the store (zero loss, per-append latency).
   */
  readonly writePolicy: "behind" | "through";
  /**
   * Map a raw store-write rejection into the adopter's typed boundary error —
   * the error {@link LogView.flush} throws (write-behind) and {@link
   * LogView.append} rejects with (write-through). Defaults to passing an `Error`
   * cause through unchanged (wrapping a non-`Error` in `new Error(String(cause))`).
   */
  readonly wrapWriteError?: (cause: unknown) => Error;
}

export class LogView<T> {
  // ─── Two tiers ───
  // TODO(adr-93-d1b / data-layer §2.7): drop `_persisted` — the harness should
  // hold only the bounded projection and read the log through the store
  // (`readPersisted()` becomes an async store read). BLOCKED, not forgotten:
  // `exportSnapshot()` is SYNC, so a harness with no log tier cannot put
  // `persisted` on its snapshot — and the snapshot is today the ONLY transport
  // for a cross-store TRANSPLANT. See the kill/resume acceptance case
  // "snapshot→restore round-trip" (packages/session/src/testing/
  // kill-resume-acceptance.tsx): the destination session has a DISTINCT id AND a
  // DISTINCT store, so store+hydrate cannot supply the log. Landing §2.7 needs a
  // transplant story first (a store-to-store log copy verb, or fork sharing the
  // parent's logKey) — a design decision above this file's pay grade.
  /** The durable, append-only log — the source of truth. */
  private _persisted: T[] = [];
  /** The materialized projection — the read surface; diverges on compaction. */
  private _projection: T[] = [];
  private _persistedVersion = 0;
  private _projectionVersion = 0;
  private _lastCompaction?: LogProjectionMeta;

  /**
   * Cached render snapshot — `useSyncExternalStore` identity stability.
   * Re-allocated only when the projection mutates.
   */
  private _snapshot: LogViewReadSnapshot<T> = { entries: [], version: 0 };

  /** Keyless render pings ("something changed, re-read"). */
  private readonly listeners: Notifier = createNotifier();

  // ─── Durable backing + write-behind pump ───
  private readonly store: LogStore<T>;
  private readonly logKey: string;
  private readonly writePolicy: "behind" | "through";
  private readonly wrapWriteError: (cause: unknown) => Error;

  /** Entries appended to memory, not yet drained to the store. */
  private writeBuffer: T[] = [];
  /** The in-flight pump promise, or null when the buffer is empty and drained. */
  private pumpRunning: Promise<void> | null = null;
  /**
   * A captured write-behind failure. Set when a pump batch fails; surfaced
   * (and left set) by {@link flush}. The pump itself never rejects — it
   * absorbs the error here so an un-awaited pump can't become an unhandled
   * rejection, and so `flush()` is the single place a durability failure is
   * observed.
   */
  private pumpError: unknown = null;

  constructor(cfg: LogViewConfig<T>) {
    this.store = cfg.store;
    this.logKey = cfg.logKey;
    this.writePolicy = cfg.writePolicy;
    this.wrapWriteError =
      cfg.wrapWriteError ??
      ((cause) => (cause instanceof Error ? cause : new Error(String(cause))));
  }

  // ─────────── Synchronous reads ───────────

  /** The projection tier — the primary consumer view. */
  read(): readonly T[] {
    return this._projection;
  }

  /** The durable, append-only log tier. */
  readPersisted(): readonly T[] {
    return this._persisted;
  }

  /** Identity-stable render snapshot (`{ entries, version }`). */
  snapshot(): LogViewReadSnapshot<T> {
    return this._snapshot;
  }

  /** Subscribe to render pings (projection mutations). */
  subscribe(listener: () => void): Unsubscribe {
    return this.listeners.subscribe(listener);
  }

  // ─────────── Append (memory-authoritative + policy) ───────────

  /**
   * Append entries: update BOTH tiers synchronously (memory is authoritative —
   * the next read reflects them), bump both versions, refresh the snapshot, and
   * ping listeners. Then persist per the write policy:
   *   - `"through"` — await the store write inline; a failure rejects with the
   *     wrapped boundary error.
   *   - `"behind"` — buffer + kick the write-behind pump; durability is the
   *     {@link flush} barrier's job.
   * The `ctx` is captured for the pump batch this append kicks (write-behind).
   */
  async append(entries: readonly T[], ctx: StoreCtx): Promise<void> {
    this.applyAppend(entries);
    if (this.writePolicy === "through") {
      try {
        await this.store.append(this.logKey, entries, ctx);
      } catch (cause) {
        throw this.wrapWriteError(cause);
      }
    } else {
      this.enqueueWriteBehind(entries, ctx);
    }
  }

  /**
   * Await the write-behind pump — every appended entry is durable in the store
   * on resolution. A no-op in `"through"` mode (nothing is ever buffered).
   * Throws the wrapped boundary error if a buffered write failed; the error is
   * LEFT LATCHED — a view that has diverged from its store cannot silently
   * "recover."
   */
  async flush(): Promise<void> {
    // Loop: a write that arrived after the pump settled starts a fresh one.
    while (this.pumpRunning) {
      await this.pumpRunning;
    }
    if (this.pumpError !== null) {
      throw this.wrapWriteError(this.pumpError);
    }
  }

  /**
   * SEED both in-memory tiers from supplied entries — the genesis path (ADR 93).
   *
   * The caller decides WHAT the view opens on (the whole durable log, a bounded
   * tail, a journal fold, synthetic ephemera): genesis authority belongs to the
   * consuming harness's hydrator seam, not to the view. The view's job is only to
   * install the result.
   *
   * **The seed law:** entries are installed, NEVER appended — nothing is written
   * back to the store and the write-behind pump is not touched. Re-appending
   * genesis would duplicate the log on every resume.
   *
   * Replaces persisted + projection with `entries` (the projection reconstructs
   * by a subsequent projection build / compaction), bumps both versions,
   * refreshes the snapshot, and pings once.
   */
  seed(entries: readonly T[]): void {
    this._persisted = [...entries];
    this._projection = [...entries];
    this._persistedVersion += 1;
    this._projectionVersion += 1;
    this.refreshSnapshot();
    this.notify();
  }

  // ─────────── Projection mutations (projection tier only) ───────────

  /**
   * Replace the projection wholesale — the compaction target. Mutates ONLY the
   * projection tier (the durable log is never rewritten), bumps the projection
   * version, records `meta` as the last-projection provenance, refreshes the
   * snapshot, and pings.
   */
  replaceProjection(entries: readonly T[], meta?: LogProjectionMeta): void {
    this._projection = [...entries];
    this._projectionVersion += 1;
    this._lastCompaction = meta;
    this.refreshSnapshot();
    this.notify();
  }

  /**
   * Reset the projection to a live mirror of the durable log — clears any
   * compaction divergence. Bumps the projection version, clears the last
   * provenance, refreshes the snapshot, and pings.
   */
  resetProjection(): void {
    this._projection = [...this._persisted];
    this._projectionVersion += 1;
    this._lastCompaction = undefined;
    this.refreshSnapshot();
    this.notify();
  }

  // ─────────── Snapshot / restore ───────────

  exportSnapshot(): LogViewSnapshot<T> {
    return {
      persisted: [...this._persisted],
      projection: [...this._projection],
      persistedVersion: this._persistedVersion,
      projectionVersion: this._projectionVersion,
      ...(this._lastCompaction !== undefined ? { lastCompaction: this._lastCompaction } : {}),
    };
  }

  /**
   * Restore both tiers from a snapshot. The durable log is restored on EVERY
   * mode; {@link LogViewImportMode} selects how the projection is treated.
   * Synchronous — subscribers fire once at the end (the post-mutation state is
   * fully applied before any ping).
   */
  importSnapshot(snap: LogViewSnapshot<T>, opts?: { readonly mode?: LogViewImportMode }): void {
    const mode = opts?.mode ?? "as-is";

    // Restore the durable log on every mode.
    this._persisted = [...snap.persisted];
    this._persistedVersion = snap.persistedVersion;

    if (mode === "as-is") {
      this._projection = [...snap.projection];
      this._projectionVersion = snap.projectionVersion;
      this._lastCompaction = snap.lastCompaction;
      this.refreshSnapshot();
      this.notify();
      return;
    }

    // "reset-projection" — the projection re-initializes as a live mirror.
    this._projection = [...this._persisted];
    this._projectionVersion += 1;
    this._lastCompaction = undefined;
    this.refreshSnapshot();
    this.notify();
  }

  // ─────────── Internals ───────────

  private applyAppend(entries: readonly T[]): void {
    for (const entry of entries) {
      this._persisted.push(entry);
      this._projection.push(entry);
    }
    this._persistedVersion += 1;
    this._projectionVersion += 1;
    this.refreshSnapshot();
    this.notify();
  }

  /** Buffer entries for the write-behind pump and ensure it's running. */
  private enqueueWriteBehind(entries: readonly T[], ctx: StoreCtx): void {
    if (entries.length === 0) return;
    this.writeBuffer.push(...entries);
    if (!this.pumpRunning) this.pumpRunning = this.runPump(ctx);
  }

  /**
   * Drain the write-behind buffer to the store in order. Picks up entries
   * appended mid-drain (the buffer is re-checked each iteration), so a single
   * pump run persists everything enqueued up to the point it empties. Never
   * rejects — a store-write failure is absorbed into `pumpError` and surfaced
   * by {@link flush}.
   */
  private async runPump(ctx: StoreCtx): Promise<void> {
    try {
      while (this.writeBuffer.length > 0) {
        const batch = this.writeBuffer;
        this.writeBuffer = [];
        await this.store.append(this.logKey, batch, ctx);
      }
    } catch (err) {
      this.pumpError = err;
    } finally {
      this.pumpRunning = null;
    }
  }

  private refreshSnapshot(): void {
    // Clone entries so the snapshot's array reference changes on every
    // mutation — consumers that memoize on `entries` rely on the array identity
    // changing too. Cheap O(n) copy on infrequent writes.
    this._snapshot = { entries: [...this._projection], version: this._projectionVersion };
  }

  private notify(): void {
    this.listeners.notify();
  }
}
