/**
 * `ChangeNotifier<V, K = string>` — the **notify** seam: typed *push*
 * reactivity carrying the delta.
 *
 * The framework already has *pull* reactivity everywhere — a bare
 * `KeyedNotifier` ping ("something changed, re-read", the
 * `useSyncExternalStore` pattern). What it lacked is *push*: a typed
 * event that carries **what** changed — the new value, the old value,
 * and the key — so a consumer can project the delta without re-reading
 * and diffing. Building StateDelta (ADR 73) forced value-capture at
 * every knob mutation site because the ping couldn't carry the value.
 *
 * `ChangeNotifier` is that push seam, kept **separate** from
 * `KeyedNotifier` on purpose: `KeyedNotifier`'s job is `void`-or-`T`
 * ping fan-out for render subscriptions; folding a value+prev change
 * stream into it would force a third type parameter and muddy that
 * overload. Single responsibility, composes cleanly — a harness holds
 * both: a `KeyedNotifier` for render pings and a `ChangeNotifier` for
 * the delta stream.
 *
 * This is the **notify** phase of the three-seam operation model
 * (ADR 76): *intercept* (middleware) can transform or veto; *commit*
 * (the factory slot) mutates; *notify* (`ChangeNotifier`) observes the
 * committed fact. Observers are **read-only and fire-and-forget** — the
 * fan-out is synchronous and error-isolated, and their return value is
 * never awaited or inspected. An observer cannot change the outcome;
 * the instant it could, it would be middleware, and the power-level
 * distinction that keeps the system reason-about-able would be lost.
 *
 * @see docs/proposals/v2/blueprint/75-system-events-and-timeline-projection.md
 * @see docs/proposals/v2/blueprint/76-operation-middleware-scoping.md
 */

import type { Unsubscribe } from "./types.js";

/**
 * The delta a `ChangeNotifier` carries. **Data, not a verb** — the
 * primitive deliberately omits an `add`/`update`/`remove` discriminator.
 * Only the emitting harness knows whether a value change means
 * "completed", "reordered", or "budget lowered"; naming the transition
 * is its job (via an `eventKind`, ADR 75 Decision 3), not the
 * substrate's. Derive the mechanical add/update/remove with
 * {@link changeKind} when a consumer (e.g. a JSON-Patch codec) needs it.
 *
 * Presence convention (matches `Map` semantics): a side is *absent*
 * when its property is `undefined`. Producers OMIT the side that
 * doesn't apply rather than setting it to `undefined`.
 */
export interface ChangeEvent<V, K = string> {
  /** Which key changed. */
  readonly key: K;
  /** The value the key now holds. Absent on removal. */
  readonly value?: V;
  /** The value the key held before. Absent on first add. */
  readonly prev?: V;
}

/**
 * Mechanical classification of a {@link ChangeEvent}, for consumers
 * that need the CRUD shape (JSON-Patch `add`/`replace`/`remove`, wire
 * projections). Pure; derives from value/prev presence.
 */
export function changeKind<V, K>(change: ChangeEvent<V, K>): "add" | "update" | "remove" {
  const hasValue = change.value !== undefined;
  const hasPrev = change.prev !== undefined;
  if (hasValue) return hasPrev ? "update" : "add";
  return "remove";
}

export interface ChangeNotifier<V, K = string> {
  /**
   * Subscribe to every change. Fires synchronously on `emitChange`,
   * in registration order, error-isolated. Read-only — the listener's
   * return value is ignored and a throw cannot break the producer or
   * sibling listeners.
   */
  onChange(listener: (change: ChangeEvent<V, K>) => void): Unsubscribe;
  /**
   * Emit a change to every `onChange` listener. The producer supplies
   * the full delta (it knows `prev` at the mutation site); the notifier
   * is a stateless pipe — it holds no values and computes no diffs.
   */
  emitChange(change: ChangeEvent<V, K>): void;
  /** Diagnostic: current listener count. */
  readonly size: number;
  /** Drop every listener. Used by long-lived owners on tear-down. */
  clear(): void;
}

export function createChangeNotifier<V, K = string>(): ChangeNotifier<V, K> {
  const listeners = new Set<(change: ChangeEvent<V, K>) => void>();

  return {
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emitChange(change) {
      // Snapshot so a listener that (un)subscribes mid-fan-out doesn't
      // mutate the set we're iterating. Sync + isolated: observers are
      // fire-and-forget and cannot affect the emitting operation.
      for (const l of [...listeners]) {
        try {
          l(change);
        } catch {
          /* isolate — one bad observer must not starve the rest */
        }
      }
    },
    get size() {
      return listeners.size;
    },
    clear() {
      listeners.clear();
    },
  };
}
