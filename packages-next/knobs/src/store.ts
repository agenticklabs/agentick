/**
 * Knob VALUE store — durable backing for knob cells (data-layer plan §3.5,
 * Phase 3 "storification").
 *
 * The store holds knob **values only** — `{ id, value }` cells. Descriptors
 * are tree-derived (components re-register them on every render), so they are
 * NEVER stored; `KnobsHarness.list()` merges the live descriptor map over these
 * value cells at read time (unchanged by storification).
 *
 * There is no named `KnobStore` port: the generic {@link CollectionStore}
 * (`@agentick/spec-next`) IS the contract. Typing the harness field against the
 * generic keeps the seam lean — a durable adapter (Postgres, …) conforms to the
 * same port and can alias later if a named port ever earns its keep.
 *
 * `KnobStoreQuery` is intentionally empty: knobs have no scoped read today
 * (`list()` returns every cell), so the query carries no dimensions and the
 * default {@link MemoryCollection} `matchQuery` is `() => true`.
 *
 * @see docs/proposals/v2/data-layer-plan.md §3.5 "The storification model"
 */

import type { CollectionStore, KnobPrimitive } from "@agentick/spec-next";
import { MemoryCollection } from "@agentick/store-next";

/**
 * A single stored knob cell — the value keyed by its knob id. Descriptors are
 * NOT part of the record (they are re-declared on render).
 */
export interface KnobEntry {
  readonly id: string;
  readonly value: KnobPrimitive;
}

/**
 * The knob value store's query type. Empty — knobs have no scoped/ranged read
 * today (`list()` returns all). A future scoped read would grow this type and
 * the `matchQuery` predicate together.
 */
export type KnobStoreQuery = Record<string, never>;

/**
 * The bundled, zero-dependency default knob value store — the generic
 * {@link MemoryCollection} parameterized for knob cells. `:memory:` semantics
 * (lost on process exit); a durable adapter conforms to the same
 * {@link CollectionStore} port. Single source of truth for the default store
 * config so the harness default and test-constructed stores never drift.
 */
export function createKnobStore(): CollectionStore<KnobEntry, KnobStoreQuery> {
  return new MemoryCollection<KnobEntry, KnobStoreQuery>({
    backend: "memory",
    keyOf: (entry) => entry.id,
    matchQuery: () => true,
  });
}
