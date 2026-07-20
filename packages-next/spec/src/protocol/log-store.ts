/**
 * LOG archetype — the append-only, ordered, cursored store port. **No nominal
 * `Store` base** (rejected over-taxonomy, data-layer plan §2.1): two structural
 * archetypes (log, collection) share a small set of characteristics (`backend`,
 * an enumerate verb, an optional `prune`, a per-store query, a conformance
 * suite). This file owns the **log** archetype port; its sibling is
 * {@link CollectionStore} (`./store.js`, keyed upsert + query).
 *
 * `LogStore<T>` is the **Promise-shaped adopter store** — the durable backing a
 * store-backed *log* harness reads from and appends to (timeline today; any
 * event-sourced entry log next). It is deliberately NOT {@link
 * import("./event-log.js").EventLog}: `EventLog<E>` is the Effect-flavored
 * substrate primitive (bus + journal, `Effect`/`Stream`, live cursor pull);
 * `LogStore<T>` is the persistence port on the collection side of the
 * `Effect ↔ Promise` boundary (data-layer plan §E13). They share the **`Cursor`
 * concept** — a monotonic, never-reused, log-scoped position — but a `LogStore`
 * surfaces it as the concrete, frozen `seq: number` ordering identity (below),
 * and every method returns a `Promise`. Adopter code targets `LogStore`; Effect
 * stays confined to the substrate.
 *
 * Port home is spec-next (data-layer plan §6-D): the cross-package contract —
 * the harness consumes it, adapter packages implement it, only spec-next is a
 * shared dep. Defaults + conformance live in the substrate / harness packages
 * (`MemoryLog` + `runStoreConformance` in `@agentick/store-next`;
 * `runTimelineStoreConformance` in `@agentick/timeline-next`).
 *
 * ## `seq` — the ordering identity (frozen contract, #133)
 *
 * Every appended entry is assigned a **`seq`**: a per-`logKey` integer that is
 * **strictly increasing, never reused, and stable across {@link
 * LogStore.prune}**. It is the durable ordering key — a Postgres `BIGSERIAL`, a
 * JSONL line ordinal, the offset in a Kafka partition. This is the concrete
 * realization of the {@link import("./event-log.js").Cursor} concept for the
 * Promise-shaped store side. The guarantees, and only these (the start value +
 * contiguity are implementation-defined so a `BIGSERIAL` adapter is
 * conformant):
 *
 *   - **strictly increasing** within a log — a later append gets a higher `seq`
 *     than any earlier one;
 *   - **never reused** — pruning entries or emptying a log never lets a future
 *     append reuse a retired `seq`;
 *   - **stable across `prune`** — a surviving entry keeps the `seq` it was
 *     assigned; a cursor held before a `prune` stays valid.
 *
 * `seq` is **store-assigned, not a field on the entry `T`** — it is the store's
 * ordering key, surfaced as the return of {@link LogStore.append}, the tag on
 * {@link SeqTagged}, and the argument to {@link LogStore.prune}.
 *
 * @see docs/proposals/v2/data-layer-plan.md §2.1, §2.7
 */

import type { StoreCtx } from "./store-ctx.js";

/**
 * An entry tagged with its store-assigned ordering identity (`seq`) — the unit
 * a cursored {@link LogStore.history} read returns. Generic over the payload
 * `T` so each log archetype (timeline entries today) tags its own type.
 */
export interface SeqTagged<T> {
  /** The store-assigned ordering identity (see the port docs' `seq` contract). */
  readonly seq: number;
  /** The stored entry, preserved opaquely by the store. */
  readonly entry: T;
}

/**
 * LOG archetype — an **append-only, ordered, cursored** log keyed by a generic
 * `logKey: string`, ordered by `seq`. Backs timeline (whose `logKey` is the
 * `sessionId`) and any future event-sourced entry log. The default in-memory
 * backing is `MemoryLog<T>` (`@agentick/store-next`); a durable adapter (JSONL,
 * SQLite, Postgres, …) conforms to this SAME port.
 *
 * Type parameter:
 *   - `T` — the stored entry. The store treats it as an opaque blob; only
 *           `seq` (store-assigned) carries ordering meaning.
 *
 * The persisted log is otherwise append-only: there is deliberately **no
 * `replace`** — rewriting the log would make the event-sourcing claim false.
 * The one destructive operation, {@link prune}, is for retention / GDPR-class
 * erasure. All operations are Promise-shaped — real backends hit disk /
 * network; the bundled in-memory default resolves synchronously inside
 * Promises.
 */
export interface LogStore<T> {
  /**
   * Append entries for a log, in order. **The only write** — the log is
   * otherwise append-only.
   *
   * Returns the **`seq` assigned to each entry**, in input order (the
   * `INSERT ... RETURNING seq` shape). Empty for an empty append. The seqs are
   * strictly increasing and never reused (see the port docs' `seq` contract).
   *
   * On failure, **reject with any error** (`ENOSPC`, a driver error, a network
   * error) — a consuming harness wraps the rejection into its typed boundary
   * error; adapters need not import spec error types.
   */
  append(logKey: string, entries: readonly T[], ctx: StoreCtx): Promise<readonly number[]>;

  /**
   * Full ordered read of a log's persisted entries — the fold input for
   * hydration. Returns `[]` for a `logKey` the store has never seen. Returns a
   * defensive copy: mutating the result never mutates the store.
   */
  read(logKey: string, ctx: StoreCtx): Promise<readonly T[]>;

  /**
   * OPTIONAL cursored read (#187) — the additive extension the frozen `seq`
   * contract exists for. Returns seq-tagged entries with absolute
   * `seq >= fromSeq`, in seq order, at most `limit`. Omitting both options
   * reads everything (a seq-tagged {@link read}).
   *
   * Powers history paging, replay/eval, resume-UI reads, and partial
   * rehydration. Stores that skip it degrade gracefully — consumers fall back
   * to {@link read} (full read, no seqs).
   */
  history?(
    logKey: string,
    options: { readonly fromSeq?: number; readonly limit?: number } | undefined,
    ctx: StoreCtx,
  ): Promise<readonly SeqTagged<T>[]>;

  /**
   * Enumerate the log keys this store holds entries for — the **foundational**
   * enumerate verb (the `enumeration-is-foundational` rule). An adopter
   * inspecting durable state (a "resume which log?" UI, a cluster node deciding
   * what it can rehydrate) needs this without prior knowledge of any specific
   * key. Order is not specified. A `logKey` whose entries were all `prune`-d
   * away is not listed (it holds nothing), though its `seq` counter continues
   * if it is appended to again.
   */
  keys(ctx: StoreCtx): Promise<readonly string[]>;

  /**
   * Remove a log's entries entirely — log lifecycle end. Idempotent: deleting
   * an unknown `logKey` resolves normally. Returns `true` if entries were
   * actually removed, `false` if the log was absent. Unlike {@link prune}, this
   * ends the log: a subsequent append starts a fresh `seq` sequence.
   */
  delete(logKey: string, ctx: StoreCtx): Promise<boolean>;

  /**
   * DESTRUCTIVE retention / GDPR-class erasure — drop the entries of `logKey`
   * whose **absolute `seq` is strictly below `before.seq`**. Returns the count
   * removed. Surviving entries keep their `seq`, and the log's `seq` counter is
   * unaffected — a later append continues from where it left off, never reusing
   * an erased `seq`.
   *
   * **Never called by compaction** — the log is otherwise append-only.
   * Optional: adapters with no erasure requirement omit it.
   */
  prune?(logKey: string, before: { seq: number }, ctx: StoreCtx): Promise<number>;

  /** Self-identifying backend label for observability (e.g. `"memory"`, `"fs"`). */
  readonly backend: string;
}
