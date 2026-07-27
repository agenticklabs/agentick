/**
 * Store seam + archetypes — the structural port shapes every store-backed
 * harness conforms to. Two layers live here:
 *
 *   - The thin, source-agnostic {@link Store} seam (`query` / `mutate` / an
 *     OPTIONAL `watch`) — the ONE machine the nine store-backed harnesses each
 *     hand-rolled, factored out.
 *   - The **collection** archetype port ({@link CollectionStore}) — an ergonomic
 *     PROFILE over that seam (keyed CRUD). The log archetype is `EventLog`
 *     (bus + journal specialize it) plus the timeline package's `TimelineStore`.
 *
 * The archetypes are ergonomic profiles rooted in {@link Store} (data-layer
 * plan §2.1): both formally `extend` the seam and add a small set of
 * characteristics (an enumerate verb, an optional `prune`, a per-store query
 * type, a conformance suite). Every store implements `query`/`mutate`; the
 * profile methods are sugar over that seam.
 *
 * Port home is @agentick/spec (data-layer plan §6-D): the cross-package contract —
 * the harness consumes it, adapter packages implement it, only @agentick/spec is a
 * shared dep. Defaults + conformance live in the harness / substrate packages
 * (`MemoryCollection` + `runStoreConformance` in `@agentick/store`).
 *
 * @see docs/proposals/v2/data-layer-plan.md §2.1
 * @see docs/proposals/v2/store.md
 */

import type { StoreCtx } from "./store-ctx.js";

/**
 * A change observed on a store's SOURCE — the reactive-capability payload a
 * {@link Store.watch} stream carries.
 *
 * Presence convention: an absent side means "not applicable" — an insert omits
 * `prev`, a removal omits `value`. Classify by KEY-PRESENCE (`"prev" in c`),
 * NOT `!== undefined`: a stored value may legitimately BE `undefined` (state's
 * value type is `unknown`), so an undefined-based check would misread it.
 */
export interface Change<T> {
  readonly key: string;
  readonly value?: T;
  readonly prev?: T;
}

/**
 * The COLLECTION profile's mutation vocabulary — a keyed upsert or a keyed
 * delete. The `M` a `MemoryCollection` (and any collection-archetype store)
 * accepts on {@link Store.mutate}.
 */
export type CollectionMutation<T> = { readonly put: T } | { readonly delete: string };

/**
 * `Store<T, Q, M>` — the thin, source-agnostic data-source seam every store IS,
 * factored out of the two structural archetypes ({@link CollectionStore},
 * `LogStore`). Read = a **projection** shaped by a query; write = a **mutation**
 * applied to the source; plus an OPTIONAL change stream (reactivity is a
 * capability, not a mandate).
 *
 * `Q` is the store's own QUERY vocabulary (how you ask the source for a
 * projection); `M` is its own MUTATION vocabulary (how you change the source).
 * The framework never prescribes a query language — a query is a small,
 * serializable description the store translates however it wants (a WHERE
 * clause, a key, a cursor, a path glob). `Q` defaults to `void` (return-all /
 * single-record); `M` defaults to `never` (a read-only store cannot be
 * mutated). The framework's code is identical across a `Map`, Postgres, S3, a
 * journal fold, or a keychain — the source's NATURE is sealed inside the
 * adopter's implementation.
 *
 * `CollectionStore` / `LogStore` are ergonomic PROFILES over this seam (keyed
 * CRUD, append-only cursored) and both formally `extend` it — every store
 * implements `query`/`mutate`, and the profile methods
 * (`get`/`list`/`put`/`delete`, `read`/`append`/`history`/`keys`) are sugar
 * over the seam. The harness-side `View` targets the seam; direct callers reach
 * for the profile methods.
 *
 * `query` accepts `Q | undefined` to match the entrenched `CollectionStore.list`
 * convention (omitting the query = "return all" / the single-record case) —
 * this lets `MemoryCollection.query` delegate straight to `list` and the
 * harness-side `View.hydrate` pass `undefined` for a return-all hydrate.
 *
 * Firewall: @agentick/spec has ZERO runtime deps — this file is structural types
 * only. The internal push-delta primitive a harness holds (`ChangeEvent` from
 * `@agentick/pubsub`) is a DIFFERENT type living in the pubsub layer;
 * `Change<T>` here is the spec-level `watch` payload, carried across no runtime.
 *
 * @see docs/proposals/v2/store.md
 */
export interface Store<T, Q = void, M = never> {
  /** Read = a PROJECTION from the source, shaped by a query. Always. */
  query(q: Q | undefined, ctx: StoreCtx): Promise<readonly T[]>;
  /** Write = a mutation applied to the source. */
  mutate(m: M, ctx: StoreCtx): Promise<void>;
  /**
   * OPTIONAL reactivity — observe changes the source undergoes (a shared store,
   * a keychain rotation, a Postgres LISTEN/NOTIFY). A store may omit it and be
   * perfectly inert; harnesses that own their writes drive their own notify seam
   * off those writes and subscribe here only for changes they did NOT cause.
   */
  watch?(q: Q | undefined, ctx: StoreCtx): AsyncIterable<Change<T>>;
  /** Self-identifying backend label, for observability. */
  readonly backend: string;
}

/**
 * COLLECTION archetype — keyed upsert, queryable. Backs tasks, credentials,
 * and (post-migration) knobs / state / session. The default in-memory backing
 * is `MemoryCollection<T, Q, PruneArg>` (`@agentick/store`), parameterized
 * by `{ backend, keyOf, matchQuery, prunePredicate? }`; a durable adapter
 * (Postgres, …) conforms to this SAME port.
 *
 * Type parameters:
 *   - `T`        — the stored record.
 *   - `Q`        — the store-specific query passed to {@link list}. Identifies
 *                  scope / range / order / basic params; the store decides how
 *                  to fulfill it (data-layer plan §3.5 P3).
 *   - `PruneArg` — the argument {@link prune} takes (e.g. an ms-epoch cutoff).
 *                  Defaults to `never` — a store with no `prune`.
 *
 * `delete` returns `void | boolean` so both conventions conform: a store that
 * reports whether the key existed (`boolean`, like the timeline stores) and one
 * that treats delete as fire-and-forget (`void`, like the task store).
 *
 * A formal PROFILE over {@link Store}: `get`/`list`/`put`/`delete` are ergonomic
 * sugar over the inherited `query`/`mutate` seam (`list` IS `query`;
 * `put`/`delete` ARE the two arms of {@link CollectionMutation}). Every
 * collection store therefore satisfies `Store<T, Q, CollectionMutation<T>>`,
 * so archetype-agnostic infrastructure (a conformance runner, a wire projector)
 * can target the seam while day-to-day callers reach for the sugar.
 */
export interface CollectionStore<T, Q, PruneArg = never> extends Store<
  T,
  Q,
  CollectionMutation<T>
> {
  /**
   * Upsert — a later `put` of the same key replaces the record. `ctx` carries
   * the runtime scope across the Effect→Promise boundary (idempotency key,
   * event-sourcing seam); pure in-memory stores ignore it. See {@link StoreCtx}.
   */
  put(item: T, ctx: StoreCtx): Promise<void>;
  /** Read one by key. `undefined` when absent. `ctx` — see {@link StoreCtx}. */
  get(key: string, ctx: StoreCtx): Promise<T | undefined>;
  /** Enumerate + query. Omitting the query returns every record. `ctx` — see {@link StoreCtx}. */
  list(query: Q | undefined, ctx: StoreCtx): Promise<readonly T[]>;
  /** Remove one by key. Idempotent — deleting an absent key never throws. `ctx` — see {@link StoreCtx}. */
  delete(key: string, ctx: StoreCtx): Promise<void | boolean>;
  /** Optional GC. The argument shape is store-specific (`PruneArg`). `ctx` — see {@link StoreCtx}. */
  prune?(arg: PruneArg, ctx: StoreCtx): Promise<void>;
}
