/**
 * InMemoryDataBridge — reference `DataBridge` implementation.
 *
 * The no-Suspense contract in concrete form:
 *
 *   - cached fulfilled  → returns `T` synchronously
 *   - cached rejected   → throws the underlying `Error` synchronously
 *   - pending           → throws the in-flight `Promise<T>` (the
 *                         reconciler render loop catches, awaits, and
 *                         re-renders — never reaches React Suspense
 *                         boundaries)
 *
 * `resolve` is idempotent on `key` within a single mount session — the
 * same key always returns the same cached entry. Invalidation
 * (`invalidate` / `invalidateTag`) drops entries so the next `resolve`
 * re-fetches.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 * @see packages/spec/src/protocol/hook-bridges.ts
 */

import type { DataBridge, DataCacheEntry, DataResolveOptions } from "@agentick/spec";

type Entry =
  | {
      readonly status: "pending";
      readonly promise: Promise<unknown>;
      readonly tag?: string;
    }
  | {
      readonly status: "fulfilled";
      readonly value: unknown;
      readonly fetchedAt: number;
      readonly ttl?: number;
      readonly tag?: string;
    }
  | {
      readonly status: "rejected";
      readonly error: unknown;
      readonly tag?: string;
    };

export interface InMemoryDataBridgeOptions {
  /**
   * Called whenever a fetch transitions to `fulfilled` or `rejected`.
   * Useful for triggering a re-render from outside React when the
   * pending Promise the bridge threw resolves.
   */
  readonly onSettled?: (key: string) => void;
}

export class InMemoryDataBridge implements DataBridge {
  private readonly cache = new Map<string, Entry>();
  private readonly pendingPromises = new Set<Promise<unknown>>();
  private fetchCountTotal = 0;
  private readonly options: InMemoryDataBridgeOptions;

  constructor(options: InMemoryDataBridgeOptions = {}) {
    this.options = options;
  }

  /**
   * Are any fetches in flight? Used by the reconciler's
   * render-until-stable loop to decide whether to await + retry.
   */
  hasPending(): boolean {
    return this.pendingPromises.size > 0;
  }

  /**
   * Snapshot of in-flight Promises. The render-until-stable loop awaits
   * `Promise.allSettled(pending())` before retrying.
   */
  pending(): readonly Promise<unknown>[] {
    return [...this.pendingPromises];
  }

  /**
   * Cumulative count of fetches ever started (whether still pending,
   * fulfilled, or rejected). Used by the harness to detect
   * Suspense-boundary firing — when the count increases during a
   * render iteration but our outer try/catch DID NOT see the thrown
   * Promise, a Suspense ancestor must have caught it.
   *
   * Synchronous fetchers (like `async () => "value"`) resolve in a
   * microtask after the throw, so by the time the harness checks
   * `pending()` the count is already zero — making `fetchCount()`
   * delta the only reliable signal.
   */
  fetchCount(): number {
    return this.fetchCountTotal;
  }

  resolve<T>(key: string, fetcher: () => Promise<T>, options: DataResolveOptions = {}): T {
    const entry = this.cache.get(key);

    // Cache hit: synchronous return or synchronous throw.
    if (entry) {
      if (entry.status === "fulfilled") {
        if (isFresh(entry, Date.now())) return entry.value as T;
        this.cache.delete(key);
      } else if (entry.status === "rejected") {
        throw entry.error;
      } else if (entry.status === "pending") {
        // Same key resolved twice in one render — re-throw the same Promise.
        throw entry.promise;
      }
    }

    // Cache miss: start the fetch, throw the in-flight Promise. The
    // reconciler's render-until-stable loop tracks pending state via
    // hasPending() + pending() — it does NOT need to catch the thrown
    // value to know a wait is required.
    let resolveSettled!: () => void;
    const settled = new Promise<void>((r) => {
      resolveSettled = r;
    });
    void fetcher().then(
      (value) => {
        this.cache.set(key, {
          status: "fulfilled",
          value,
          fetchedAt: Date.now(),
          ...(options.ttl !== undefined ? { ttl: options.ttl } : {}),
          ...(options.tag !== undefined ? { tag: options.tag } : {}),
        });
        this.pendingPromises.delete(settled);
        this.options.onSettled?.(key);
        resolveSettled();
      },
      (err) => {
        this.cache.set(key, {
          status: "rejected",
          error: err,
          ...(options.tag !== undefined ? { tag: options.tag } : {}),
        });
        this.pendingPromises.delete(settled);
        this.options.onSettled?.(key);
        resolveSettled();
      },
    );
    this.pendingPromises.add(settled);
    this.fetchCountTotal++;
    this.cache.set(key, {
      status: "pending",
      promise: settled,
      ...(options.tag !== undefined ? { tag: options.tag } : {}),
    });
    throw settled;
  }

  invalidate(key: string): void {
    this.cache.delete(key);
  }

  invalidateTag(tag: string): void {
    for (const [k, e] of this.cache) {
      if (e.tag === tag) this.cache.delete(k);
    }
  }

  has(key: string): boolean {
    const e = this.cache.get(key);
    if (!e) return false;
    if (e.status !== "fulfilled") return false;
    return isFresh(e, Date.now());
  }

  /** Diagnostic: snapshot of cache state for tests / devtools. */
  entries(): ReadonlyArray<{ readonly key: string; readonly entry: Entry }> {
    const out: Array<{ readonly key: string; readonly entry: Entry }> = [];
    for (const [key, entry] of this.cache) out.push({ key, entry });
    return out;
  }

  /** Clear every entry. */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Export the fulfilled cache entries as `DataCacheEntry[]` for
   * inclusion in a `ReconcilerSnapshot`. Pending and rejected entries
   * are skipped — re-fetching is safer than persisting partial state.
   */
  exportSnapshot(): readonly DataCacheEntry[] {
    const out: DataCacheEntry[] = [];
    for (const [key, entry] of this.cache) {
      if (entry.status !== "fulfilled") continue;
      out.push({
        key,
        value: entry.value,
        fetchedAt: entry.fetchedAt,
        ...(entry.ttl !== undefined ? { ttl: entry.ttl } : {}),
        ...(entry.tag !== undefined ? { tag: entry.tag } : {}),
      });
    }
    return out;
  }

  /**
   * Replace the cache with entries from a `ReconcilerSnapshot`. Existing
   * pending fetches are dropped (the snapshot represents the
   * authoritative state). TTL is honored — stale entries are skipped.
   */
  importSnapshot(entries: readonly DataCacheEntry[]): void {
    this.cache.clear();
    this.pendingPromises.clear();
    const now = Date.now();
    for (const e of entries) {
      if (e.ttl !== undefined && now - e.fetchedAt >= e.ttl) continue;
      this.cache.set(e.key, {
        status: "fulfilled",
        value: e.value,
        fetchedAt: e.fetchedAt,
        ...(e.ttl !== undefined ? { ttl: e.ttl } : {}),
        ...(e.tag !== undefined ? { tag: e.tag } : {}),
      });
    }
  }
}

function isFresh(entry: Entry & { status: "fulfilled" }, now: number): boolean {
  if (entry.ttl === undefined) return true;
  return now - entry.fetchedAt < entry.ttl;
}
