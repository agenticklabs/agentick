/**
 * `View<T, Q, M>` — the harness-held, SYNCHRONOUS projection of a
 * {@link Store}. One primitive that collapses the three things every
 * store-backed harness re-hand-rolled into a `CollectionProjection` + a
 * `KeyedNotifier` + a `ChangeNotifier`:
 *
 *   1. a sync read cache (the render pass + the sync `exportSnapshot` cannot
 *      await — Phase-3 finding),
 *   2. write-through to the async store off the critical path, and
 *   3. two notify seams — bare render PINGS ({@link KeyedNotifier}) and typed
 *      push DELTAS ({@link ChangeNotifier}, carrying `{ key, value?, prev? }`).
 *
 * The store is where data LIVES; the view is the sync working copy. Reactivity
 * is opt-in: a view with no subscribers is a plain write-through cache.
 *
 * ## Single mutation vs. bulk (the notify contract)
 *
 * - {@link write} / {@link deleteSync} are the SINGLE-mutation path: cache, then
 *   store, then notify(key) + emit a typed change. These drive the harness's
 *   change stream (a knobs `set` → one JSON-Patch delta).
 * - {@link replace} / {@link hydrate} are the BULK path: they mutate the whole
 *   cache FIRST, then batch the render pings — and they are CHANGE-SILENT (they
 *   do NOT emit per-key deltas). A wholesale replace/hydrate is "everything
 *   became this set", best represented by the harness's own aggregate frame (a
 *   full snapshot), not by N spurious deltas on the change stream. Batching the
 *   pings to the end also preserves the invariant that a subscriber which reads
 *   during a ping sees the COMPLETE post-mutation state (not a half-applied
 *   cache) — the guarantee the hand-rolled `importSnapshot`/`hydrate` gave by
 *   doing all cache writes before any `fireListeners`.
 *
 * `StoreCtx` threads the runtime scope across the Effect→Promise boundary; the
 * view is Promise-shaped and never reads ambient context. Store writes are
 * fire-and-forget (`void mutate(...).catch(...)`): reads are served from the
 * sync cache, so a durable-write failure must not crash the mutation.
 *
 * @see docs/proposals/v2/store.md
 * @verifiedBy packages-next/store/src/__tests__/view.spec.ts
 */

import type { CollectionMutation, Store, StoreCtx } from "@agentick/spec-next";
import {
  createChangeNotifier,
  createKeyedNotifier,
  type ChangeEvent,
  type ChangeNotifier,
  type KeyedNotifier,
  type Unsubscribe,
} from "@agentick/pubsub-next";

/**
 * How a {@link View} maps its records onto a store. `keyOf` is the
 * cache key; `toPut` / `toDelete` translate a record (or a key) into the store's
 * mutation vocabulary `M`. The {@link View.collection} factory fills
 * `toPut`/`toDelete` with the trivial {@link CollectionMutation} shape.
 */
export interface ViewConfig<T, Q, M> {
  readonly store: Store<T, Q, M>;
  readonly keyOf: (item: T) => string;
  readonly toPut: (item: T) => M;
  readonly toDelete: (key: string) => M;
}

export class View<T, Q = void, M = never> {
  /** The synchronous read cache — the materialized view of the store. */
  private readonly cache = new Map<string, T>();
  /** Bare render PINGS ("something at `key` changed, re-read"). */
  private readonly notifier: KeyedNotifier = createKeyedNotifier();
  /** Typed push DELTAS carrying `{ key, value?, prev? }` (the notify seam). */
  private readonly changes: ChangeNotifier<T> = createChangeNotifier<T>();

  constructor(private readonly cfg: ViewConfig<T, Q, M>) {}

  /**
   * Collection convenience — a view over a {@link CollectionMutation} store,
   * with `toPut`/`toDelete` prefilled. `keyOf` is the only per-store code.
   */
  static collection<T, Q>(
    store: Store<T, Q, CollectionMutation<T>>,
    keyOf: (item: T) => string,
  ): View<T, Q, CollectionMutation<T>> {
    return new View<T, Q, CollectionMutation<T>>({
      store,
      keyOf,
      toPut: (item) => ({ put: item }),
      toDelete: (key) => ({ delete: key }),
    });
  }

  // ─────────── Synchronous reads (never touch the store) ───────────

  getSync(key: string): T | undefined {
    return this.cache.get(key);
  }

  hasSync(key: string): boolean {
    return this.cache.has(key);
  }

  listSync(): readonly T[] {
    return [...this.cache.values()];
  }

  // ─────────── Single-mutation path (cache → store → notify + change) ───────────

  /**
   * Upsert one record: set the sync cache SYNCHRONOUSLY (the next read reflects
   * it), fire-and-forget the store write, ping the key, and emit a typed change.
   * Add-vs-update is decided by cache PRESENCE (`cache.has`), never by
   * `value !== undefined` — a stored value may legitimately BE `undefined`.
   */
  write(item: T, ctx: StoreCtx): void {
    const key = this.cfg.keyOf(item);
    const had = this.cache.has(key);
    const prev = this.cache.get(key);
    this.cache.set(key, item);
    void Promise.resolve(this.cfg.store.mutate(this.cfg.toPut(item), ctx)).catch(() => undefined);
    this.notifier.notify(key);
    this.changes.emitChange(had ? { key, value: item, prev } : { key, value: item });
  }

  /**
   * Delete one record. Idempotent — a no-op delete of an absent key fires
   * nothing and returns `false`. On a real removal: drop from the cache,
   * fire-and-forget the store delete, ping the key, and emit a removal change
   * (`value` omitted, `prev` carried). Returns whether the key existed.
   */
  deleteSync(key: string, ctx: StoreCtx): boolean {
    const had = this.cache.has(key);
    const prev = this.cache.get(key);
    this.cache.delete(key);
    void Promise.resolve(this.cfg.store.mutate(this.cfg.toDelete(key), ctx)).catch(() => undefined);
    if (had) {
      this.notifier.notify(key);
      this.changes.emitChange({ key, prev });
    }
    return had;
  }

  // ─────────── Bulk path (cache first, then batched ping — CHANGE-SILENT) ───────────

  /**
   * Wholesale replace: the cache becomes exactly `items`. Deletes keys absent
   * from `items`, upserts each item — all against the cache + store FIRST — then
   * pings every touched key (delete-drops ∪ upserts). Change-SILENT: a
   * wholesale replace is not N deltas; the harness emits its own aggregate
   * (snapshot) frame. Returns nothing — the caller owns any aggregate signal.
   */
  replace(items: readonly T[], ctx: StoreCtx): void {
    const nextKeys = new Set(items.map((it) => this.cfg.keyOf(it)));
    const touched = new Set<string>();
    for (const key of [...this.cache.keys()]) {
      if (!nextKeys.has(key)) {
        this.cache.delete(key);
        void Promise.resolve(this.cfg.store.mutate(this.cfg.toDelete(key), ctx)).catch(
          () => undefined,
        );
        touched.add(key);
      }
    }
    for (const item of items) {
      const key = this.cfg.keyOf(item);
      this.cache.set(key, item);
      void Promise.resolve(this.cfg.store.mutate(this.cfg.toPut(item), ctx)).catch(() => undefined);
      touched.add(key);
    }
    for (const key of touched) this.notifier.notify(key);
  }

  /**
   * Hydrate from the store: MERGE the query projection into the cache (store
   * records overlay — a live record the store has not yet seen survives), then
   * ping each loaded key and return the loaded keys. Change-SILENT for the same
   * reason as {@link replace}. A fresh store is empty ⇒ a no-op returning `[]`.
   */
  async hydrate(q: Q | undefined, ctx: StoreCtx): Promise<readonly string[]> {
    const items = await this.cfg.store.query(q, ctx);
    const keys: string[] = [];
    for (const it of items) {
      const key = this.cfg.keyOf(it);
      this.cache.set(key, it);
      keys.push(key);
    }
    for (const key of keys) this.notifier.notify(key);
    return keys;
  }

  // ─────────── Notify seams (delegated) ───────────

  /** Subscribe to render pings for one key. */
  subscribe(key: string, fn: () => void): Unsubscribe {
    return this.notifier.subscribe(key, fn);
  }

  /** Subscribe to render pings for every key (wildcard — fires after the keyed bucket). */
  subscribeAll(fn: () => void): Unsubscribe {
    return this.notifier.subscribeAll(fn);
  }

  /** Fire a bare render ping for `key` without a cache mutation. */
  notify(key: string): void {
    this.notifier.notify(key);
  }

  /** Subscribe to the typed change stream (the push notify seam). */
  onChange(fn: (c: ChangeEvent<T>) => void): Unsubscribe {
    return this.changes.onChange(fn);
  }
}
