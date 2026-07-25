/**
 * `spyNotifier<T = void>()` — call-recording double over the real
 * `Notifier` implementation. Use in tests that need to assert
 * notify-call patterns without `vi.spyOn`-ing the prototype.
 *
 *   const spy = spyNotifier();
 *   harness.attachNotifier(spy);
 *   harness.someMethodThatNotifies();
 *   expect(spy.callCount).toBe(1);
 *
 *   const typed = spyNotifier<{ tick: number }>();
 *   typed.notify({ tick: 1 });
 *   typed.notify({ tick: 2 });
 *   expect(typed.calls).toEqual([{ tick: 1 }, { tick: 2 }]);
 *
 * The spy IS a working notifier — listeners still fire normally. The
 * only addition is the recording side-effect on each `notify` call.
 */

import type { Notifier } from "../notifier.js";
import { createNotifier } from "../notifier.js";
import type { Listener, Unsubscribe } from "../types.js";

export interface NotifierSpy<T = void> extends Notifier<T> {
  /**
   * Recorded values, in call order. For `T = void` each entry is
   * `undefined`; the count is what tests typically check via
   * `spy.calls.length` or `spy.callCount`.
   */
  readonly calls: ReadonlyArray<T>;
  /** Synonym for `calls.length`. */
  readonly callCount: number;
  /** Clear the recorded history without dropping subscribers. */
  reset(): void;
}

type NotifyFn<T> = [T] extends [void] ? () => void : (value: T) => void;

export function spyNotifier<T = void>(): NotifierSpy<T> {
  const inner = createNotifier<T>();
  const calls: T[] = [];

  const notifyFn = ((value: T): void => {
    calls.push(value);
    (inner.notify as (v: T) => void)(value);
  }) as NotifyFn<T>;

  return {
    subscribe(listener: Listener<T>): Unsubscribe {
      return inner.subscribe(listener);
    },
    notify: notifyFn,
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
    reset() {
      calls.length = 0;
    },
  };
}
