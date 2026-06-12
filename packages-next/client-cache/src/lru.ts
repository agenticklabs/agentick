/**
 * In-memory LRU cache.
 *
 * Used as the default `CacheStore` for the cache middleware. JS Map
 * preserves insertion order; re-insert on hit to move-to-most-recent.
 *
 * Adopters who want durable / cross-process caches implement the
 * `CacheStore` interface (e.g., Redis-backed) and pass via
 * `cache({ store: ... })`.
 */

export interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number;
}

export interface CacheStore {
  get(key: string): CacheEntry | undefined;
  set(key: string, entry: CacheEntry): void;
  delete(key: string): void;
  clear(): void;
  size(): number;
}

export class LruCacheStore implements CacheStore {
  private readonly map = new Map<string, CacheEntry>();

  constructor(private readonly maxSize: number) {
    if (maxSize < 1) throw new Error("LruCacheStore: maxSize must be >= 1");
  }

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    // Move-to-most-recent: re-insert at the tail.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
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

  size(): number {
    return this.map.size;
  }
}
