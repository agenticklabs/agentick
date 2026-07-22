/**
 * InMemoryDataBridge — reference `DataBridge` implementation.
 *
 * Implements the split-primitive contract:
 *   - `peek(key)` — sync read; returns the entry's current state or undefined
 *   - `fetch(key, fetcher)` — initiates or joins a fetch; returns Promise
 *   - `subscribe(key, listener)` — observes cache mutations
 *   - `invalidate` / `invalidateTag` — drop entries
 *
 * Compilers compose these into their own async idiom. React's `useData`
 * peeks for a value, throws the pending promise (or cached error), and
 * initiates `fetch` if no entry exists.
 *
 * @see docs/proposals/v2/blueprint/03-reconciler-harness.md
 * @see packages/spec/src/protocol/hook-bridges.ts
 */

import type {
  DataBridge,
  DataCacheEntry,
  DataEntry,
  DataResolveOptions,
  Unsubscribe,
} from "@agentick/spec-next";
import { createKeyedNotifier, type KeyedNotifier } from "@agentick/pubsub-next";
import { omitUndefined } from "@agentick/utils-next";

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
   * Useful for triggering a re-render from outside the compiler when
   * the pending promise resolves.
   */
  readonly onSettled?: (key: string) => void;
}

export class InMemoryDataBridge implements DataBridge {
  private readonly cache = new Map<string, Entry>();
  private readonly pendingPromises = new Set<Promise<unknown>>();
  private readonly listeners: KeyedNotifier = createKeyedNotifier();
  private fetchCountTotal = 0;
  private readonly options: InMemoryDataBridgeOptions;

  constructor(options: InMemoryDataBridgeOptions = {}) {
    this.options = options;
  }

  /**
   * Are any fetches in flight? Used by the compiler's
   * render-until-stable loop to decide whether to await + retry.
   * Extension over `DataBridge` — duck-typed by `CompilerHarness`.
   */
  hasPending(): boolean {
    return this.pendingPromises.size > 0;
  }

  /**
   * Snapshot of in-flight Promises. The render-until-stable loop awaits
   * `Promise.allSettled(pending())` before retrying.
   * Extension over `DataBridge` — duck-typed.
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

  // ──────── DataBridge protocol ────────

  peek<T>(key: string): DataEntry<T> | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.status === "fulfilled") {
      if (!isFresh(entry, Date.now())) {
        this.cache.delete(key);
        return undefined;
      }
      return { kind: "value", value: entry.value as T };
    }
    if (entry.status === "rejected") {
      return { kind: "error", error: entry.error };
    }
    // pending
    return { kind: "pending", promise: entry.promise as Promise<T> };
  }

  fetch<T>(key: string, fetcher: () => Promise<T>, options: DataResolveOptions = {}): Promise<T> {
    const existing = this.cache.get(key);
    if (existing) {
      if (existing.status === "fulfilled") {
        if (isFresh(existing, Date.now())) return Promise.resolve(existing.value as T);
        this.cache.delete(key); // stale — fall through to re-fetch
      } else if (existing.status === "rejected") {
        return Promise.reject(existing.error);
      } else if (existing.status === "pending") {
        return existing.promise as Promise<T>;
      }
    }

    // Cache miss (or stale): start the fetch.
    let resolveSettled!: () => void;
    const settled = new Promise<void>((r) => {
      resolveSettled = r;
    });
    const fetchPromise = fetcher().then(
      (value) => {
        this.cache.set(key, {
          status: "fulfilled",
          value,
          fetchedAt: Date.now(),
          ...omitUndefined({ ttl: options.ttl, tag: options.tag }),
        });
        this.pendingPromises.delete(settled);
        this.options.onSettled?.(key);
        this.notifyKey(key);
        resolveSettled();
        return value;
      },
      (err: unknown) => {
        this.cache.set(key, {
          status: "rejected",
          error: err,
          ...omitUndefined({ tag: options.tag }),
        });
        this.pendingPromises.delete(settled);
        this.options.onSettled?.(key);
        this.notifyKey(key);
        resolveSettled();
        throw err;
      },
    );
    this.pendingPromises.add(settled);
    this.fetchCountTotal++;
    this.cache.set(key, {
      status: "pending",
      promise: fetchPromise as Promise<unknown>,
      ...omitUndefined({ tag: options.tag }),
    });
    this.notifyKey(key);
    return fetchPromise;
  }

  subscribe(key: string, listener: () => void): Unsubscribe {
    return this.listeners.subscribe(key, listener);
  }

  invalidate(key: string): void {
    this.cache.delete(key);
    this.notifyKey(key);
  }

  invalidateTag(tag: string): void {
    const invalidated: string[] = [];
    for (const [k, e] of this.cache) {
      if (e.tag === tag) {
        this.cache.delete(k);
        invalidated.push(k);
      }
    }
    for (const k of invalidated) this.notifyKey(k);
  }

  has(key: string): boolean {
    const e = this.cache.get(key);
    if (!e) return false;
    if (e.status !== "fulfilled") return false;
    return isFresh(e, Date.now());
  }

  // ──────── Extensions (duck-typed by CompilerHarness etc.) ────────

  /** Diagnostic: snapshot of cache state for tests / devtools. */
  entries(): ReadonlyArray<{ readonly key: string; readonly entry: Entry }> {
    const out: Array<{ readonly key: string; readonly entry: Entry }> = [];
    for (const [key, entry] of this.cache) out.push({ key, entry });
    return out;
  }

  /** Clear every entry. */
  clear(): void {
    const keys = [...this.cache.keys()];
    this.cache.clear();
    for (const k of keys) this.notifyKey(k);
  }

  /**
   * Export the fulfilled cache entries as `DataCacheEntry[]` for
   * inclusion in a `CompilerSnapshot`. Pending and rejected entries
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
        ...omitUndefined({ ttl: entry.ttl, tag: entry.tag }),
      });
    }
    return out;
  }

  /**
   * Replace the cache with entries from a `CompilerSnapshot`. Existing
   * pending fetches are dropped (the snapshot represents the
   * authoritative state). TTL is honored — stale entries are skipped.
   */
  importSnapshot(entries: readonly DataCacheEntry[]): void {
    const existingKeys = [...this.cache.keys()];
    this.cache.clear();
    this.pendingPromises.clear();
    const now = Date.now();
    for (const e of entries) {
      if (e.ttl !== undefined && now - e.fetchedAt >= e.ttl) continue;
      this.cache.set(e.key, {
        status: "fulfilled",
        value: e.value,
        fetchedAt: e.fetchedAt,
        ...omitUndefined({ ttl: e.ttl, tag: e.tag }),
      });
    }
    // Notify keys that changed: union of old keys + new keys.
    const newKeys = new Set([...existingKeys, ...this.cache.keys()]);
    for (const k of newKeys) this.notifyKey(k);
  }

  // ──────── Internals ────────

  private notifyKey(key: string): void {
    this.listeners.notify(key);
  }
}

function isFresh(entry: Entry & { status: "fulfilled" }, now: number): boolean {
  if (entry.ttl === undefined) return true;
  return now - entry.fetchedAt < entry.ttl;
}
