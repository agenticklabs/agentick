/**
 * LOG archetype — the append-only, ordered, cursored store port. A formal
 * PROFILE over {@link Store} (data-layer plan §2.1): `LogStore<T> extends
 * Store<T, LogQuery, LogMutation<T>>`, so the append-only sugar
 * (`read`/`history`/`append`/`keys`) rides the same `query`/`mutate` seam every
 * store shares — `query` projects a log window ({@link LogQuery}), `mutate`
 * appends ({@link LogMutation}). Its sibling profile is {@link CollectionStore}
 * (`./store.js`, keyed upsert + query).
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
 * Port home is @agentick/spec (data-layer plan §6-D): the cross-package contract —
 * the harness consumes it, adapter packages implement it, only @agentick/spec is a
 * shared dep. Defaults + conformance live in the substrate / harness packages
 * (`MemoryLog` + `runStoreConformance` in `@agentick/store`;
 * `runTimelineStoreConformance` in `@agentick/timeline`).
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

import type { Store } from "./store.js";
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
 * The LOG profile's QUERY vocabulary — identifies a log plus an optional cursor
 * window over it. The seam projection of the archetype's `read`/`history` sugar:
 * `{ logKey }` alone projects the whole log (a {@link LogStore.read}); adding
 * `fromSeq` / `limit` projects a cursored window (a {@link LogStore.history}
 * slice with its `seq` tags dropped — the seam returns bare entries). Its fields
 * are exactly the `read`/`history` parameters, hoisted into one serializable
 * description. A `Store.query` of `undefined` identifies no log and projects
 * nothing (`[]`) — a partitioned log has no "return all" without a `logKey`.
 */
export interface LogQuery {
  /** The log to project (timeline's `logKey` is the `sessionId`). */
  readonly logKey: string;
  /** Cursored lower bound — entries with absolute `seq >= fromSeq`. Omit → from the start. */
  readonly fromSeq?: number;
  /** Cap on the number of entries projected. Omit → no cap. */
  readonly limit?: number;
  // TODO(tail-read): THE LAST N ENTRIES OF A LOG ARE NOT EXPRESSIBLE. This
  // query is forward-from-a-lower-bound only — no `toSeq`, no
  // `direction: "backward"` — and the same shape is mirrored at every layer
  // above (`TimelineHistoryInput`, the `timeline/history` command, the client
  // handle's `loadOlder`). So "open this thread on its most recent 20
  // messages", which is what every chat UI wants first, has no expression
  // anywhere in the framework.
  //
  // What it costs downstream, measured on the first real consumer (knowify's
  // assistant, nx-knowify libs/ernesto-client + k-assistant-v3): the client
  // pages FORWARD from the head accumulating up to 25 pages to find the tail,
  // holds its own mirrored copy of the window to do it, re-seeds the handle's
  // window from that copy (so live appends are clobbered), and its scroll-UP
  // affordance loads NEWER entries. Every one of those is a bandaid over this
  // one absence, and no client can do better while it stands.
  //
  // The seam: `toSeq` (an upper bound, symmetric with `fromSeq`) or an
  // explicit `direction`. `toSeq` is the smaller change and composes with the
  // existing cursor. Brownfield `Store` adapters must then implement a reverse
  // slice, which is exactly why this belongs here rather than being re-solved
  // per adapter. Pairs with the client handle becoming a true tail-anchored
  // pager.
}

/**
 * The LOG profile's MUTATION vocabulary — the single append write. {@link
 * LogStore.append} is the only mutation; the log is otherwise append-only, so
 * there is deliberately no `replace` / keyed-`delete` arm here. Log lifecycle
 * (`delete`, `prune`) stays on the profile's own methods, off the seam.
 */
export type LogMutation<T> = {
  readonly append: { readonly logKey: string; readonly entries: readonly T[] };
};

/**
 * LOG archetype — an **append-only, ordered, cursored** log keyed by a generic
 * `logKey: string`, ordered by `seq`. Backs timeline (whose `logKey` is the
 * `sessionId`) and any future event-sourced entry log. The default in-memory
 * backing is `MemoryLog<T>` (`@agentick/store`); a durable adapter (JSONL,
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
export interface LogStore<T> extends Store<T, LogQuery, LogMutation<T>> {
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
}
