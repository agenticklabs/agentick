/**
 * `MemoryCollection<T, Q, PruneArg>` — the generic, `Map`-backed default
 * backing for the **collection** store archetype (data-layer plan §2.2).
 *
 * The survey's "trivial custom store" criterion, made real: a store-backed
 * harness gets its in-memory default by **parameterizing this one generic** —
 * `{ backend, keyOf, matchQuery, prunePredicate? }` — instead of hand-rolling a
 * `Map` + a bespoke `scopeMatches`/filter loop. The ONLY per-store code is the
 * `keyOf` accessor and the `matchQuery` predicate. It fully backs
 * `InMemoryTaskStore` (`@agentick/tasks-next`) and is the target for
 * `InMemoryCredentialsStore` + the future knobs / state / session stores.
 *
 * Implements {@link CollectionStore} so shape drift breaks the build. `:memory:`
 * semantics — state is lost on process exit; a durable adapter (Postgres, …)
 * conforms to the same port with its own storage.
 *
 * ## `onChange` — the shared-store observation seam
 *
 * `onChange` observes changes to the (possibly **SHARED**) store — the
 * cross-consumer / external-observation seam. This is distinct from a single
 * harness's self-caused change stream: a harness that owns its store privately
 * and is the ONLY writer already knows what it changed (it just wrote it) and
 * does NOT need `onChange` — knobs, whose `MemoryCollection` sits behind a
 * private {@link CollectionProjection}, deliberately does not subscribe (a
 * listener-less `onChange` is a no-op cost). `onChange` earns its keep when a
 * store is shared across consumers OR a durable backend surfaces changes the
 * process did not originate (a sibling process editing a keychain, an admin
 * pushing to KV) — credentials is its first real consumer, forwarding these
 * into its harness fan-out. Fan-out is synchronous, in registration order, and
 * error-isolated (one throwing listener never breaks the write or a sibling) —
 * it composes the canonical {@link ChangeNotifier} notify seam rather than
 * re-deriving a `Set` + try/catch loop.
 *
 * @see docs/proposals/v2/data-layer-plan.md §2.2
 * @verifiedBy packages-next/store/src/__tests__/memory-collection.spec.ts
 */

import type { CollectionStore, StoreCtx } from "@agentick/spec-next";
import { createChangeNotifier, type ChangeEvent, type ChangeNotifier } from "@agentick/pubsub-next";

/**
 * The delta a {@link MemoryCollection.onChange} listener receives — the canonical
 * push-delta {@link ChangeEvent} keyed by the store's primary key (the `Map`
 * key produced by `keyOf`). Re-exported so consumers don't reach into
 * `@agentick/pubsub-next` for the shape.
 */
export type CollectionChangeEvent<T> = ChangeEvent<T>;

/**
 * The per-store parameterization. Everything store-specific about a collection
 * store lives here; the mechanics (upsert, fresh-array `list`, idempotent
 * delete, predicate-driven prune) are the generic's.
 */
export interface MemoryCollectionConfig<T, Q, PruneArg = never> {
  /** Self-identifying backend label (e.g. `"memory"`). */
  readonly backend: string;
  /** Extracts the primary key from a record — the `Map` key. */
  readonly keyOf: (item: T) => string;
  /**
   * Query predicate. `true` = the item is included in `list(query)`. Called
   * with `query === undefined` when `list()` takes no argument (return every
   * record — a well-behaved `matchQuery` returns `true` for `undefined`).
   */
  readonly matchQuery: (item: T, query: Q | undefined) => boolean;
  /**
   * Prune predicate. When provided, {@link MemoryCollection.prune} is present
   * and drops every item for which this returns `true`. When omitted, the
   * store has no `prune` method (so `typeof store.prune === "function"` is
   * `false` — the conformance-suite capability gate reads exactly that).
   */
  readonly prunePredicate?: (item: T, arg: PruneArg) => boolean;
}

export class MemoryCollection<T, Q, PruneArg = never> implements CollectionStore<T, Q, PruneArg> {
  readonly backend: string;
  private readonly items = new Map<string, T>();
  private readonly config: MemoryCollectionConfig<T, Q, PruneArg>;
  /**
   * The push-delta notify seam for {@link onChange} — the canonical
   * {@link ChangeNotifier}, error-isolated and snapshot-safe against
   * mid-fan-out (un)subscription. Empty until a consumer subscribes; the
   * `emitChange` calls in {@link put} / {@link delete} are then a bare `Set`
   * iteration (a no-op when no one is listening).
   */
  private readonly changes: ChangeNotifier<T> = createChangeNotifier<T>();

  /**
   * Present only when the config supplies a `prunePredicate` — attached in the
   * constructor rather than declared as a method so the `typeof`-based
   * capability detection stays honest for prune-less stores.
   */
  prune?: (arg: PruneArg, ctx: StoreCtx) => Promise<void>;

  constructor(config: MemoryCollectionConfig<T, Q, PruneArg>) {
    this.config = config;
    this.backend = config.backend;
    if (config.prunePredicate !== undefined) {
      const predicate = config.prunePredicate;
      this.prune = (arg: PruneArg, _ctx: StoreCtx): Promise<void> => {
        // TODO(store-phase-4): prune does NOT emit `onChange` per-key removals
        // today — no shared-store consumer needs bulk-eviction observation yet
        // (tasks, the only pruner, drives its own bus and does not subscribe to
        // the collection). When a shared store wants to observe pruning, emit a
        // `{ key, prev }` removal per dropped item here.
        for (const [key, item] of this.items) {
          if (predicate(item, arg)) this.items.delete(key);
        }
        return Promise.resolve();
      };
    }
  }

  put(item: T, _ctx: StoreCtx): Promise<void> {
    const key = this.config.keyOf(item);
    const prev = this.items.get(key);
    this.items.set(key, item);
    // Always notify on `put` (upsert). `prev` is omitted on first insert per
    // the ChangeEvent presence convention (a side is absent when its property
    // is `undefined`).
    this.changes.emitChange(prev === undefined ? { key, value: item } : { key, value: item, prev });
    return Promise.resolve();
  }

  get(key: string, _ctx: StoreCtx): Promise<T | undefined> {
    return Promise.resolve(this.items.get(key));
  }

  /** Iterate values, filter by `matchQuery`, return a FRESH array each call. */
  list(query: Q | undefined, _ctx: StoreCtx): Promise<readonly T[]> {
    const out: T[] = [];
    for (const item of this.items.values()) {
      if (this.config.matchQuery(item, query)) out.push(item);
    }
    return Promise.resolve(out);
  }

  /** Idempotent — returns whether the key existed. */
  delete(key: string, _ctx: StoreCtx): Promise<boolean> {
    const prev = this.items.get(key);
    const existed = this.items.delete(key);
    // Notify ONLY when the key existed — a no-op delete is not a change. The
    // removal carries `prev` (the value dropped) and omits `value`.
    if (existed) {
      this.changes.emitChange(prev === undefined ? { key } : { key, prev });
    }
    return Promise.resolve(existed);
  }

  /**
   * Subscribe to changes to this (possibly SHARED) store — the cross-consumer
   * observation seam. Fires synchronously after every `put` (upsert) and after
   * every `delete` that removed a key; a no-op delete fires nothing. Returns an
   * unsubscribe function. See the class doc for when `onChange` earns its keep
   * (shared stores / externally-mutated durable backends) versus a single
   * private-store harness that already knows its own writes.
   */
  onChange(listener: (change: CollectionChangeEvent<T>) => void): () => void {
    return this.changes.onChange(listener);
  }
}
