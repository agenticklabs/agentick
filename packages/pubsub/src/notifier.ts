/**
 * `Notifier<T = void>` — Layer 1 single-channel observer.
 *
 * The classic `Set<() => void>` fan-out pattern, generalized so the
 * same factory serves both parameterless call sites
 * (`useSyncExternalStore`-style — `n.notify()`) and typed-payload
 * publishers (transport state changes — `n.notify(state)`).
 *
 * Listener errors are caught per-listener; a buggy consumer cannot
 * corrupt sibling listeners or the producer's state. This matches the
 * `SessionRuntime` semantics that predated the consolidation
 * (which silently caught listener throws).
 *
 *   const n = createNotifier();
 *   const off = n.subscribe(() => render());
 *   n.notify();                       // fires every listener
 *   off();                            // remove this listener
 *
 *   const t = createNotifier<MyState>();
 *   t.subscribe((s) => apply(s));
 *   t.notify(currentState);
 */

import type { Listener, Unsubscribe } from "./types.js";

export interface Notifier<T = void> {
  /** Add a listener; returns the unsubscribe. Adding twice = no-op. */
  subscribe(listener: Listener<T>): Unsubscribe;
  /** Fire every listener. Errors are caught per-listener. */
  notify: NotifyFn<T>;
  /** Diagnostic: number of active listeners. */
  readonly size: number;
  /** Drop every subscriber. Used by long-lived owners on tear-down. */
  clear(): void;
}

type NotifyFn<T> = [T] extends [void] ? () => void : (value: T) => void;

export function createNotifier<T = void>(): Notifier<T> {
  const listeners = new Set<(value: T) => void>();
  const notifyFn = (value: T): void => {
    // Snapshot to tolerate mid-iteration unsubscribe.
    for (const l of [...listeners]) {
      try {
        l(value);
      } catch {
        // Listener errors must not corrupt other listeners or the
        // producer's state.
      }
    }
  };

  return {
    subscribe(listener) {
      const fn = listener as (value: T) => void;
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    notify: notifyFn as NotifyFn<T>,
    get size() {
      return listeners.size;
    },
    clear() {
      listeners.clear();
    },
  };
}
