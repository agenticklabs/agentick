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
 * @see docs/proposals/v2/data-layer-plan.md §2.2
 * @verifiedBy packages-next/store/src/__tests__/memory-collection.spec.ts
 */

import type { CollectionStore } from "@agentick/spec-next";

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
   * Present only when the config supplies a `prunePredicate` — attached in the
   * constructor rather than declared as a method so the `typeof`-based
   * capability detection stays honest for prune-less stores.
   */
  prune?: (arg: PruneArg) => Promise<void>;

  constructor(config: MemoryCollectionConfig<T, Q, PruneArg>) {
    this.config = config;
    this.backend = config.backend;
    if (config.prunePredicate !== undefined) {
      const predicate = config.prunePredicate;
      this.prune = (arg: PruneArg): Promise<void> => {
        for (const [key, item] of this.items) {
          if (predicate(item, arg)) this.items.delete(key);
        }
        return Promise.resolve();
      };
    }
  }

  put(item: T): Promise<void> {
    this.items.set(this.config.keyOf(item), item);
    return Promise.resolve();
  }

  get(key: string): Promise<T | undefined> {
    return Promise.resolve(this.items.get(key));
  }

  /** Iterate values, filter by `matchQuery`, return a FRESH array each call. */
  list(query?: Q): Promise<readonly T[]> {
    const out: T[] = [];
    for (const item of this.items.values()) {
      if (this.config.matchQuery(item, query)) out.push(item);
    }
    return Promise.resolve(out);
  }

  /** Idempotent — returns whether the key existed. */
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.items.delete(key));
  }
}
