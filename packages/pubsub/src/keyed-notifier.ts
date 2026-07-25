/**
 * `KeyedNotifier<K = string, T = void>` — Layer 2 keyed observer
 * with optional wildcard channel.
 *
 * The classic `Map<K, Set<listener>> + Set<wildcard>` pattern that
 * harnesses (knobs / state / skills) and reactive caches (data bridge)
 * reach for. `T` lets typed-payload subscribers (lifecycle custom
 * events) share the surface. Listeners may be async; use `notifyAsync`
 * to await each one sequentially.
 *
 * Buckets are auto-collected on the last unsubscribe so long-lived
 * harnesses don't leak `Map` slots.
 *
 *   const n = createKeyedNotifier();
 *   n.subscribe("counter", () => render());
 *   n.subscribeAll(() => bumpVersion());
 *   n.notify("counter");              // fires counter-keyed + wildcards
 *
 *   const t = createKeyedNotifier<string, MyEvent>();
 *   t.subscribe("foo", (ev) => handle(ev));
 *   t.notify("foo", event);
 *   await t.notifyAsync("foo", event); // await each listener sequentially
 */

import type { Unsubscribe } from "./types.js";

export interface KeyedNotifier<K = string, T = void> {
  /** Subscribe to one key. Multiple listeners on the same key OK. */
  subscribe(key: K, listener: KeyedListener<T>): Unsubscribe;
  /** Subscribe to every published key. Fires after the keyed bucket. */
  subscribeAll(listener: KeyedListener<T>): Unsubscribe;
  /** Synchronous fan-out — keyed bucket first, wildcards last. */
  notify: KeyedNotifyFn<K, T>;
  /**
   * Wildcard-only fan-out. Use when "everything changed" (e.g. full
   * snapshot import) and per-key signalling would be noisy. Keyed
   * subscribers do NOT fire — only wildcards.
   */
  notifyAll: NotifyFn<T>;
  /**
   * Async fan-out — `await`s each listener serially. Use for handlers
   * that need ordering or backpressure (e.g. lifecycle dispatch).
   * Errors propagate — caller decides how to handle them.
   */
  notifyAsync: KeyedNotifyAsyncFn<K, T>;
  /** Diagnostic: listener count for one key (excludes wildcards). */
  count(key: K): number;
  /** Diagnostic: number of wildcard subscribers. */
  readonly wildcardCount: number;
  /** Diagnostic: total listeners across every key plus wildcards. */
  readonly size: number;
  /** Drop every subscriber. Used by long-lived owners on tear-down. */
  clear(): void;
}

type KeyedListener<T> = [T] extends [void]
  ? () => void | Promise<void>
  : (value: T) => void | Promise<void>;

type NotifyFn<T> = [T] extends [void] ? () => void : (value: T) => void;
type KeyedNotifyFn<K, T> = [T] extends [void] ? (key: K) => void : (key: K, value: T) => void;
type KeyedNotifyAsyncFn<K, T> = [T] extends [void]
  ? (key: K) => Promise<void>
  : (key: K, value: T) => Promise<void>;

export function createKeyedNotifier<K = string, T = void>(): KeyedNotifier<K, T> {
  const buckets = new Map<K, Set<(value: T) => void | Promise<void>>>();
  const wildcards = new Set<(value: T) => void | Promise<void>>();

  const fireSync = (key: K, value: T): void => {
    const bucket = buckets.get(key);
    if (bucket) {
      for (const l of [...bucket]) {
        try {
          // Sync notify: we tolerate listeners that return promises but
          // don't await them. Errors swallowed.
          void l(value);
        } catch {
          /* isolate */
        }
      }
    }
    for (const l of [...wildcards]) {
      try {
        void l(value);
      } catch {
        /* isolate */
      }
    }
  };

  const fireAllSync = (value: T): void => {
    for (const l of [...wildcards]) {
      try {
        void l(value);
      } catch {
        /* isolate */
      }
    }
  };

  const fireAsync = async (key: K, value: T): Promise<void> => {
    const bucket = buckets.get(key);
    if (bucket) {
      for (const l of [...bucket]) await l(value);
    }
    for (const l of [...wildcards]) await l(value);
  };

  return {
    subscribe(key, listener) {
      const fn = listener as (value: T) => void | Promise<void>;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = new Set();
        buckets.set(key, bucket);
      }
      bucket.add(fn);
      return () => {
        const b = buckets.get(key);
        if (!b) return;
        b.delete(fn);
        if (b.size === 0) buckets.delete(key);
      };
    },
    subscribeAll(listener) {
      const fn = listener as (value: T) => void | Promise<void>;
      wildcards.add(fn);
      return () => {
        wildcards.delete(fn);
      };
    },
    notify: fireSync as KeyedNotifyFn<K, T>,
    notifyAll: fireAllSync as NotifyFn<T>,
    notifyAsync: fireAsync as KeyedNotifyAsyncFn<K, T>,
    count(key) {
      return buckets.get(key)?.size ?? 0;
    },
    get wildcardCount() {
      return wildcards.size;
    },
    get size() {
      let total = wildcards.size;
      for (const b of buckets.values()) total += b.size;
      return total;
    },
    clear() {
      buckets.clear();
      wildcards.clear();
    },
  };
}
