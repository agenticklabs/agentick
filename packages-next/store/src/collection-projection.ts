/**
 * `CollectionProjection<T>` — the synchronous read-model over an async
 * {@link CollectionStore}, the primitive that fell out of runs #1 (tasks) and
 * #2 (knobs).
 *
 * Both runs hand-rolled the SAME shape: a store-backed harness whose protocol
 * reads are **synchronous** (served during render) sits in front of an
 * **asynchronous** `CollectionStore` port. They reconciled the impedance
 * mismatch by keeping a `Map` projection (the sync read cache) in lockstep with
 * the store via two moves — **write-through** on every mutation and
 * **hydrate** on resume. This class extracts that once (data-layer plan §3.5
 * P5, "hold only the bounded projection"):
 *
 *   - **Sync reads** — `getSync` / `hasSync` / `listSync` read the cache; they
 *     NEVER touch the store (which is async). This is the CQRS materialized
 *     view: the store is the durable authority, this is the live read-model.
 *   - **Write-through** — `write` sets the cache SYNCHRONOUSLY (so the very
 *     next read reflects it) then fires the store write off the critical path
 *     (`void store.put(item).catch(...)`). The dual-write decision is
 *     centralized HERE — the single place the "cache first, store fire-and-
 *     forget" policy is stated.
 *   - **Hydrate** — `hydrate` loads `store.list()` into the cache as an
 *     OVERLAY (merge, not clear-first) and RETURNS the keys it loaded, so the
 *     caller fires its own change notifications.
 *
 * ## Deliberately NOT owned here
 *
 * Change-notification, the substrate channel, the notify seam, list-cache
 * invalidation, layer chains — every one of those is harness-specific (knobs
 * fires `fireListeners` + a StateDelta channel; tasks emits on a per-task
 * `LocalPubSub` bus). This primitive is EXACTLY three things: sync cache +
 * write-through + hydrate. It is a WRITE SINK that sits beside the harness's
 * notify seam, never a source of it. `hydrate` returns the changed keys rather
 * than notifying precisely to keep the harness in control of that seam.
 *
 * ## Variant (not composed here): tasks
 *
 * The tasks harness's cache value is a `LiveTask` (the persisted `TaskRecord`
 * slice PLUS live-only runtime handles — AbortController, event bus, result
 * deferred — that are NEVER persisted). Its cache is therefore NOT a projection
 * of the store's record type; it is a projection PLUS live handles. That's a
 * documented VARIANT of this primitive (see `TasksHarness.live`), not a
 * composition of it — the live handles and the record are read together at
 * essentially every site, so splitting the record slice onto a
 * `CollectionProjection<TaskRecord>` would distort tasks for no gain.
 *
 * @see docs/proposals/v2/data-layer-plan.md §3.5 "The Playbook"
 * @verifiedBy packages-next/store/src/__tests__/collection-projection.spec.ts
 */

import type { CollectionStore } from "@agentick/spec-next";

export class CollectionProjection<T, Q = unknown, PruneArg = never> {
  /**
   * The synchronous read cache — the materialized view of {@link store}.
   * `getSync` / `hasSync` / `listSync` read it; it is written synchronously by
   * {@link write} / {@link deleteSync} (so reads reflect a mutation
   * immediately) and rebuilt by {@link hydrate}.
   */
  private readonly cache = new Map<string, T>();

  constructor(
    private readonly store: CollectionStore<T, Q, PruneArg>,
    private readonly keyOf: (item: T) => string,
  ) {}

  // ─────────── Synchronous reads (never touch the store) ───────────

  /** The cached record for `key`, or `undefined` when absent. */
  getSync(key: string): T | undefined {
    return this.cache.get(key);
  }

  /** Whether `key` is present in the cache. */
  hasSync(key: string): boolean {
    return this.cache.has(key);
  }

  /** A FRESH array of every cached record (a new reference each call). */
  listSync(): readonly T[] {
    return [...this.cache.values()];
  }

  // ─────────── Write-through (the centralized dual-write) ───────────

  /**
   * Dual-write one record: set the sync cache SYNCHRONOUSLY (so the next read
   * reflects it), then fire-and-forget the durable store off the critical
   * path. Reads are served from the cache, so the store write's result is
   * never awaited and its errors are swallowed — a store write failure MUST
   * NOT crash the mutation, and the in-memory default resolves synchronously
   * so there's nothing to await.
   *
   * TODO(store-phase-4): a durable store (pg) wants a flush barrier + typed
   * write-failed surfacing (the manifest snapshot barrier reads it). This is
   * the ONE site that decision belongs — previously duplicated in knobs'
   * `persistValue` and the tasks harness's `persist`.
   */
  write(item: T): void {
    this.cache.set(this.keyOf(item), item);
    void this.store.put(item).catch(() => undefined);
  }

  /**
   * Delete one record: drop it from the sync cache SYNCHRONOUSLY, then
   * fire-and-forget the store delete (same off-critical-path policy as
   * {@link write}). Idempotent — deleting an absent key is a no-op.
   */
  deleteSync(key: string): void {
    this.cache.delete(key);
    void Promise.resolve(this.store.delete(key)).catch(() => undefined);
  }

  // ─────────── Hydrate (store → cache, on resume) ───────────

  /**
   * Load the durable store into the sync cache and return the keys loaded so
   * the caller fires its own per-key change notifications (this primitive does
   * NOT own notification — see the class doc). This is a MERGE: store records
   * OVERLAY the cache, they do not clear it first, so a live record the store
   * has not yet seen survives hydration. A fresh store is empty ⇒ a no-op
   * returning `[]`.
   */
  async hydrate(query?: Q): Promise<readonly string[]> {
    const items = await this.store.list(query);
    const keys: string[] = [];
    for (const item of items) {
      const key = this.keyOf(item);
      this.cache.set(key, item);
      keys.push(key);
    }
    return keys;
  }
}
