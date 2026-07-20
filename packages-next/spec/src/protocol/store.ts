/**
 * Store archetypes — the structural port shapes every store-backed harness
 * conforms to. **No nominal `Store` base** (rejected over-taxonomy, data-layer
 * plan §2.1): two structural archetypes (log, collection) sharing a small set
 * of characteristics (`backend`, an enumerate verb, an optional `prune`, a
 * per-store query type, a conformance suite). This file owns the **collection**
 * archetype port; the log archetype is `EventLog` (bus + journal specialize it)
 * plus the timeline package's `TimelineStore`.
 *
 * Port home is spec-next (data-layer plan §6-D): the cross-package contract —
 * the harness consumes it, adapter packages implement it, only spec-next is a
 * shared dep. Defaults + conformance live in the harness / substrate packages
 * (`MemoryCollection` + `runStoreConformance` in `@agentick/store-next`).
 *
 * @see docs/proposals/v2/data-layer-plan.md §2.1
 */

import type { StoreCtx } from "./store-ctx.js";

/**
 * COLLECTION archetype — keyed upsert, queryable. Backs tasks, credentials,
 * and (post-migration) knobs / state / session. The default in-memory backing
 * is `MemoryCollection<T, Q, PruneArg>` (`@agentick/store-next`), parameterized
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
 */
export interface CollectionStore<T, Q, PruneArg = never> {
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
  /** Self-identifying backend label for observability (`"memory"`, `"postgres"`, …). */
  readonly backend: string;
}
