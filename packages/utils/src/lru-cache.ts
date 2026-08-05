/**
 * Bounded in-memory cache with PER-ENTRY expiry.
 *
 * Two bounds, because they fail differently: `maxSize` caps memory (LRU
 * eviction), and each entry's own `expiresAt` caps staleness. Neither
 * substitutes for the other — a cache of ten entries can still serve a value
 * that went wrong an hour ago.
 *
 * **Expiry is per entry, not a policy.** The common shape (`lru-cache`'s `ttl`)
 * sets one lifetime at construction, which is right when the CALLER decides how
 * long a value is good for. It is wrong when something else does: a provider
 * that hands back a file handle with its own `expirationTime`, a token with an
 * `exp`, a lease. Those want the deadline they were given, and storing it on the
 * entry is the only way to keep it.
 *
 * **`get` drops what has expired**, rather than returning it and trusting every
 * caller to check. This lived in `@agentick/client-extensions` as a pure LRU
 * whose `expiresAt` its one caller compared by hand — safe with one consumer,
 * and a footgun the moment there are two.
 *
 * A commodity, and deliberately shared rather than duplicated: a second copy of
 * a cache is how two subsystems come to disagree about eviction.
 */

/** A cached value and the instant it stops being usable (epoch ms). */
export interface CacheEntry<T = unknown> {
  readonly value: T;
  /** Epoch ms. `Infinity` never expires; a past value is already gone. */
  readonly expiresAt: number;
}

/**
 * The store seam. In-memory {@link LruCacheStore} is the default; an adopter
 * wanting a durable or cross-process cache (Redis, a table) implements this.
 */
export interface CacheStore<T = unknown> {
  /** The live entry, or `undefined` when absent OR expired. */
  get(key: string): CacheEntry<T> | undefined;
  set(key: string, entry: CacheEntry<T>): void;
  delete(key: string): void;
  clear(): void;
  /** Entries held, INCLUDING any not yet reaped. See {@link LruCacheStore.size}. */
  size(): number;
}

export class LruCacheStore<T = unknown> implements CacheStore<T> {
  private readonly map = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly maxSize: number,
    /** Injectable clock — a test must be able to cross an expiry without waiting. */
    private readonly now: () => number = Date.now,
  ) {
    if (maxSize < 1) throw new Error("LruCacheStore: maxSize must be >= 1");
  }

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      // Reaped on read. There is no sweeper: a cache nobody reads costs only
      // memory, which `maxSize` already bounds.
      this.map.delete(key);
      return undefined;
    }
    // Move-to-most-recent: re-insert at the tail.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry<T>): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, entry);
    if (this.map.size > this.maxSize) {
      // Evict least-recently-used = the first inserted key.
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  /**
   * Entries HELD, which is not the number readable: expired ones are reaped on
   * read, so an untouched key still occupies a slot. This measures memory, and
   * memory is what `maxSize` bounds.
   */
  size(): number {
    return this.map.size;
  }
}
