/**
 * State VALUE store — durable backing for the session-internal K/V cells
 * (data-layer plan §3.5, Phase 3 "storification").
 *
 * The store holds state **entries** — `{ key, value }` cells. Unlike knobs,
 * state has no descriptors (it is session-internal, not model-facing), so the
 * cell IS the whole record; there is nothing tree-derived to merge over it.
 *
 * There is no named `StateStore` port: the `Store` seam
 * (`@agentick/spec`) IS the contract the harness types its field against.
 * Keeping the seam lean means a durable adapter (Postgres, …) need only
 * implement `query`/`mutate` (+ optional `watch`) — no profile methods required.
 *
 * `StateStoreQuery` is intentionally empty: state has no scoped read today
 * (`list()` returns every key), so the query carries no dimensions and the
 * default {@link MemoryCollection} `matchQuery` is `() => true`.
 *
 * @see docs/proposals/v2/data-layer-plan.md §3.5 "The storification model"
 */

import { MemoryCollection } from "@agentick/store";

/**
 * A single stored state cell — an arbitrary `value` keyed by its string `key`.
 * `value` is `unknown`: state may legitimately hold `undefined`, so presence is
 * a `key`-membership question, never a `value !== undefined` check.
 */
export interface StateEntry {
  readonly key: string;
  readonly value: unknown;
}

/**
 * The state value store's query type. Empty — state has no scoped/ranged read
 * today (`list()` returns all). A future scoped read would grow this type and
 * the `matchQuery` predicate together.
 */
export type StateStoreQuery = Record<string, never>;

/**
 * The bundled, zero-dependency default state value store — the generic
 * {@link MemoryCollection} parameterized for state cells. `:memory:` semantics
 * (lost on process exit); a durable adapter conforms to the same
 * {@link Store} seam. Single source of truth for the default store
 * config so the harness default and test-constructed stores never drift.
 *
 * Returns the CONCRETE `MemoryCollection` (which implements BOTH the
 * `CollectionStore` profile AND the `Store` seam) so callers that poke
 * the store directly keep `get`/`put`/`list`; the harness widens it to the
 * `Store` seam at its option boundary.
 */
export function createStateStore(): MemoryCollection<StateEntry, StateStoreQuery> {
  return new MemoryCollection<StateEntry, StateStoreQuery>({
    backend: "memory",
    keyOf: (entry) => entry.key,
    matchQuery: () => true,
  });
}
