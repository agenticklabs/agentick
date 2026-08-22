/**
 * State VALUE store — durable backing for the session-internal K/V cells
 * (data-layer plan §3.5, Phase 3 "storification").
 *
 * The store holds state **entries** — `{ key, value }` cells. Unlike knobs,
 * state has no descriptors (it is session-internal, not model-facing), so the
 * cell IS the whole record; there is nothing tree-derived to merge over it.
 *
 * `StateStore` is a NAME for the `Store` seam (`@agentick/spec`) at state's
 * parameterization, not a port of its own: a durable adapter (Postgres, …) need
 * only implement `query`/`mutate` (+ optional `watch`) — no profile methods
 * required.
 *
 * Cells are partitioned by the owning harness `scope`, so ONE app-scoped store
 * backs every session without state keys colliding across them. The scope is IN
 * the record rather than read from `StoreCtx.sessionId`, which holds three
 * different values across state's own call sites (the harness scope id on the
 * sync path, the raw session id once an op's ambient `RuntimeContext` folds over
 * it, the SESSION harness's scope id on the checkpoint path) — an adapter keying
 * on it would write to one partition and read from another.
 *
 * @see docs/proposals/v2/data-layer-plan.md §3.5 "The storification model"
 * @see docs/proposals/v2/checkpointing.md §3.2
 */

import type { CollectionMutation, Store } from "@agentick/spec";
import { MemoryCollection } from "@agentick/store";

/**
 * A single stored state cell — an arbitrary `value` at `key`, within the owning
 * harness's `scope`. `value` is `unknown`: state may legitimately hold
 * `undefined`, so presence is a `key`-membership question, never a
 * `value !== undefined` check.
 */
export interface StateEntry {
  readonly scope: string;
  readonly key: string;
  readonly value: unknown;
}

/** The state value store's query — one partition of cells. */
export interface StateStoreQuery {
  readonly scope: string;
}

/** The {@link Store} seam at state's parameterization. */
export type StateStore = Store<StateEntry, StateStoreQuery, CollectionMutation<StateEntry>>;

/**
 * The `state` NAMESPACE DEFINITION (ADR 93) — what `createApp({ state })` and
 * `SessionHarnessOptions.state` take. Durability only: the adopter stash's
 * values are the whole of this namespace's durable state.
 */
export interface StateDefinition {
  /** @see StateHarnessOptions.store */
  readonly store?: StateStore;
}

/**
 * The store's primary key: state keys are unique only WITHIN a scope.
 * `JSON.stringify` of the pair rather than a separator join — both halves are
 * adopter-supplied and may contain any character, so a join is ambiguous and an
 * ambiguous key silently merges two sessions' cells.
 */
export function stateStoreKey(scope: string, key: string): string {
  return JSON.stringify([scope, key]);
}

/**
 * The store partition a session's state occupies — the harness's own `scopeId`.
 * Single-sourced because `branch()` derives the SOURCE partition from a bare
 * session id and must land on the same string the source harness wrote under.
 */
export function stateScope(sessionId: string): string {
  return `${sessionId}:state`;
}

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
    keyOf: (entry) => stateStoreKey(entry.scope, entry.key),
    matchQuery: (entry, query) => query === undefined || entry.scope === query.scope,
  });
}
