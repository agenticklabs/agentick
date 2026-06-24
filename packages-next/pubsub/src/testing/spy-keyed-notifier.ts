/**
 * `spyKeyedNotifier<K = string, T = void>()` — call-recording double
 * over the real `KeyedNotifier`. Records the call kind (`notify` vs
 * `notifyAll` vs `notifyAsync`) plus the key + value.
 *
 *   const spy = spyKeyedNotifier<string, MyEvent>();
 *   harness.attachKeyedNotifier(spy);
 *   harness.fireKnobChange("verbose", { value: true });
 *   expect(spy.calls).toEqual([
 *     { kind: "notify", key: "verbose", value: { value: true } },
 *   ]);
 *
 * The spy IS a working keyed notifier — listeners still fire and
 * wildcards still receive their share. The only addition is the
 * recording side-effect.
 */

import type { KeyedNotifier, Unsubscribe } from "../keyed-notifier.js";
import { createKeyedNotifier } from "../keyed-notifier.js";

export type KeyedNotifierCall<K, T> =
  | { readonly kind: "notify"; readonly key: K; readonly value: T }
  | { readonly kind: "notifyAll"; readonly value: T }
  | { readonly kind: "notifyAsync"; readonly key: K; readonly value: T };

export interface KeyedNotifierSpy<K = string, T = void> extends KeyedNotifier<K, T> {
  /** Recorded calls, in chronological order. */
  readonly calls: ReadonlyArray<KeyedNotifierCall<K, T>>;
  /** Synonym for `calls.length`. */
  readonly callCount: number;
  /** Recorded calls filtered to a single key. */
  callsFor(key: K): ReadonlyArray<KeyedNotifierCall<K, T>>;
  /** Clear the recorded history without dropping subscribers. */
  reset(): void;
}

type KeyedListener<T> = [T] extends [void]
  ? () => void | Promise<void>
  : (value: T) => void | Promise<void>;

type KeyedNotifyFn<K, T> = [T] extends [void] ? (key: K) => void : (key: K, value: T) => void;
type NotifyAllFn<T> = [T] extends [void] ? () => void : (value: T) => void;
type KeyedNotifyAsyncFn<K, T> = [T] extends [void]
  ? (key: K) => Promise<void>
  : (key: K, value: T) => Promise<void>;

export function spyKeyedNotifier<K = string, T = void>(): KeyedNotifierSpy<K, T> {
  const inner = createKeyedNotifier<K, T>();
  const calls: KeyedNotifierCall<K, T>[] = [];

  const notifyFn = ((key: K, value: T): void => {
    calls.push({ kind: "notify", key, value });
    (inner.notify as (k: K, v: T) => void)(key, value);
  }) as KeyedNotifyFn<K, T>;

  const notifyAllFn = ((value: T): void => {
    calls.push({ kind: "notifyAll", value });
    (inner.notifyAll as (v: T) => void)(value);
  }) as NotifyAllFn<T>;

  const notifyAsyncFn = (async (key: K, value: T): Promise<void> => {
    calls.push({ kind: "notifyAsync", key, value });
    await (inner.notifyAsync as (k: K, v: T) => Promise<void>)(key, value);
  }) as KeyedNotifyAsyncFn<K, T>;

  return {
    subscribe(key: K, listener: KeyedListener<T>): Unsubscribe {
      return inner.subscribe(key, listener);
    },
    subscribeAll(listener: KeyedListener<T>): Unsubscribe {
      return inner.subscribeAll(listener);
    },
    notify: notifyFn,
    notifyAll: notifyAllFn,
    notifyAsync: notifyAsyncFn,
    count(key: K): number {
      return inner.count(key);
    },
    get wildcardCount() {
      return inner.wildcardCount;
    },
    get size() {
      return inner.size;
    },
    clear() {
      inner.clear();
    },
    get calls() {
      return calls;
    },
    get callCount() {
      return calls.length;
    },
    callsFor(key: K) {
      return calls.filter((c) => "key" in c && c.key === key);
    },
    reset() {
      calls.length = 0;
    },
  };
}
