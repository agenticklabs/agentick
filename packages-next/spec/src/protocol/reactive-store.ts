/**
 * `ReactiveStore<T, Q, M>` — the thin, source-agnostic data-source seam every
 * store IS, factored out of the two structural archetypes (`CollectionStore`,
 * `LogStore`). It names the ONE machine the nine store-backed harnesses each
 * hand-rolled: read = a **projection** shaped by a query; write = a **mutation**
 * applied to the source; and an OPTIONAL change stream (reactivity is a
 * capability, not a mandate).
 *
 * ## Three verbs, no query LANGUAGE
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
 * ## Relationship to the archetypes (Cut 1 — coexistence)
 *
 * `CollectionStore` / `LogStore` are ergonomic PROFILES over this seam (keyed
 * CRUD, append-only cursored). In Cut 1 they do NOT yet formally `extend`
 * `ReactiveStore` — that is a Cut 2 sweep (it forces every store to implement
 * `query`/`mutate`). Today `MemoryCollection` implements BOTH additively: the
 * `CollectionStore` surface (`get`/`list`/`put`/`delete`) AND this seam
 * (`query`/`mutate`), so the harness-side {@link ReactiveView} can target the
 * seam while the profile methods stay for direct callers.
 *
 * ## Firewall
 *
 * Spec-next has ZERO runtime deps — this file is structural types only. The
 * internal push-delta primitive a harness holds ({@link ChangeEvent} from
 * `@agentick/pubsub-next`) is a DIFFERENT type living in the pubsub layer;
 * `Change<T>` here is the spec-level `watch` payload, carried across no runtime.
 *
 * @see docs/proposals/v2/reactive-store.md
 */

import type { StoreCtx } from "./store-ctx.js";

/**
 * A change observed on a store's SOURCE — the reactive-capability payload a
 * {@link ReactiveStore.watch} stream carries.
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
 * accepts on {@link ReactiveStore.mutate}.
 */
export type CollectionMutation<T> = { readonly put: T } | { readonly delete: string };

/**
 * The thin, source-agnostic seam. `T` = the projected record; `Q` = the query
 * vocabulary (a serializable description, NOT a query language); `M` = the
 * mutation vocabulary.
 *
 * `query` accepts `Q | undefined` to match the entrenched `CollectionStore.list`
 * convention (omitting the query = "return all" / the single-record case) —
 * this lets `MemoryCollection.query` delegate straight to `list` and the
 * harness-side {@link ReactiveView.hydrate} pass `undefined` for a return-all
 * hydrate.
 */
export interface ReactiveStore<T, Q = void, M = never> {
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
