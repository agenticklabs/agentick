/**
 * `pubsub` — local observer-pattern primitives for Agentick v2.
 *
 * Three layers that consolidate hand-rolled `Set<() => void>` fan-out
 * across every harness, bridge, transport, and reconciler test
 * double. One file, one canonical implementation per shape.
 *
 *   Layer 1 — `Notifier<T = void>`
 *       Single-channel observer. `T = void` keeps the parameterless
 *       `useSyncExternalStore`-style call site (`notify()`); `T !=
 *       void` lets a state-passing publisher (e.g. transport-state
 *       changes) keep its typed payload (`notify(state)`).
 *
 *   Layer 2 — `KeyedNotifier<K, T = void>`
 *       Keyed observer with an optional wildcard channel. The classic
 *       `Map<K, Set<listener>> + Set<wildcard>` pattern that harnesses
 *       (knobs / state / skills) and reactive caches (data bridge)
 *       reach for. `T` lets typed-payload subscribers (lifecycle
 *       custom events) share the surface. Listeners may be async; use
 *       `notifyAsync` to await each one sequentially.
 *
 *   Layer 3 — `LocalPubSub<T>`
 *       Stream-based fan-out built on Effect's `PubSub.unbounded()`.
 *       Wraps subscriber scoping internally so consumers receive a
 *       plain `Stream.Stream<T, never, never>` — no caller-supplied
 *       `Scope` required. Filtering happens at subscribe time so a
 *       single underlying queue serves arbitrary discriminated-event
 *       projections.
 *
 * Design choices:
 *   - Listener errors are isolated (caught and discarded) for every
 *     synchronous notifier. Producers must not be corrupted by a buggy
 *     consumer. Async dispatch (`notifyAsync`) propagates errors so
 *     callers that care can catch them.
 *   - `size` / `count(key)` / `subscriberCount` are diagnostic — not
 *     load-bearing. They exist so warning logic (e.g. lifecycle
 *     "unhandled custom kind") can peek without iterating.
 *   - The keyed primitive auto-collects empty buckets on unsubscribe
 *     so long-lived harnesses don't accumulate dead `Map` slots.
 *
 * @see ADR 34 (mergeLayered + consolidation primitives)
 * @see `packages-next/utils/src/__tests__/pubsub.spec.ts`
 */

import { Effect, PubSub, Queue, Scope, Stream } from "effect";

// ─────────────────────────────────────────────────────────────────────
// Local re-exports — keep utils-next from depending on spec-next.
// `Unsubscribe` is also exported by `@agentick/spec-next`, but utils is
// the lower layer; importing spec here would invert the dep direction.
// ─────────────────────────────────────────────────────────────────────

export type Unsubscribe = () => void;

/**
 * A function called for each listener when the notifier fires. When
 * `T = void` the listener is invoked with no argument (`l()`); when
 * `T != void` it receives the published value (`l(value)`).
 */
export type Listener<T> = [T] extends [void] ? () => void : (value: T) => void;

// ─────────────────────────────────────────────────────────────────────
// Layer 1 — Notifier
// ─────────────────────────────────────────────────────────────────────

/**
 * Single-channel observer. Subscribers receive every published value.
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
        // producer's state. Swallow per ADR-34 (consolidation
        // primitive matches the existing `session-state` semantics).
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

// ─────────────────────────────────────────────────────────────────────
// Layer 2 — KeyedNotifier (+ optional wildcards)
// ─────────────────────────────────────────────────────────────────────

/**
 * Keyed observer with optional wildcard channel.
 *
 *   const n = createKeyedNotifier();
 *   n.subscribe("counter", () => render());
 *   n.subscribeAll(() => bumpVersion());
 *   n.notify("counter");              // fires counter-keyed + wildcards
 *
 *   // Typed payloads — the lifecycle store, MCP task notifications.
 *   const t = createKeyedNotifier<string, MyEvent>();
 *   t.subscribe("foo", (ev) => handle(ev));
 *   t.notify("foo", event);
 *   await t.notifyAsync("foo", event); // await each listener sequentially
 *
 * Buckets are auto-collected on the last unsubscribe so long-lived
 * harnesses don't leak `Map` slots.
 */
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

// ─────────────────────────────────────────────────────────────────────
// Layer 3 — LocalPubSub (Effect.PubSub-backed Stream fan-out)
// ─────────────────────────────────────────────────────────────────────

/**
 * Stream-based pub/sub. Built on Effect's `PubSub.unbounded()` — each
 * subscriber gets an independent dequeue so a slow consumer can't
 * starve another.
 *
 *   const bus = createLocalPubSub<TaskEvent>();
 *   const stream = bus.subscribe();
 *   bus.publish({ kind: "started", taskId: "t1" });
 *   for await (const ev of someEffectStream(stream)) ...
 *   await bus.close();
 *
 * The subscribe Stream is already wrapped in `Scope.scoped`, so
 * consumers receive a plain `Stream.Stream<T, never, never>` with no
 * `Scope` requirement. Pass an optional filter to receive only events
 * that match a predicate; under the hood it's a `Stream.filter`, so
 * the underlying queue still drains evenly.
 *
 * `publish` returns synchronously from the caller's POV — the
 * underlying `PubSub.unbounded()` never blocks on `offer`. `close`
 * shuts down the PubSub, draining any remaining buffered events to
 * subscribers and ending their streams.
 */
export interface LocalPubSub<T> {
  /** Publish an event. Sync from the caller's POV (unbounded queue). */
  publish(event: T): void;
  /**
   * Subscribe to the stream. Pass an optional predicate to filter on
   * the subscriber side. The returned Stream is scoped internally;
   * consuming it ends when the subscriber's queue is shut down or
   * `close()` runs.
   */
  subscribe(filter?: (event: T) => boolean): Stream.Stream<T, never, never>;
  /**
   * Shut down the PubSub. Drains the buffer to existing subscribers,
   * then ends their streams. Idempotent.
   */
  close(): Promise<void>;
  /** Diagnostic: current subscriber count (best-effort). */
  readonly subscriberCount: number;
}

/**
 * Implementation detail — Effect.PubSub stores a runtime-level
 * `PubSub<T>`. The Stream subscription requires a `Scope`; we wrap
 * with `Scope.scoped` and a per-subscriber tracking counter so callers
 * never touch Effect's Scope service.
 */
export function createLocalPubSub<T>(): LocalPubSub<T> {
  // Allocate the PubSub eagerly via Effect.runSync — unbounded ctor is
  // a pure allocation, no side effects beyond a Queue.
  const pubsub = Effect.runSync(PubSub.unbounded<T>());
  let subscriberCount = 0;
  let closed = false;

  const subscribeStream = (filter?: (event: T) => boolean): Stream.Stream<T, never, never> => {
    // Build a scoped Effect that acquires a subscriber queue, increments
    // the counter, and releases (decrement + queue shutdown) on scope
    // exit. Stream.fromQueue then drains the queue.
    const acquireSubscriber = Effect.acquireRelease(
      Effect.gen(function* () {
        const q = yield* PubSub.subscribe(pubsub);
        subscriberCount += 1;
        return q;
      }),
      (q) =>
        Effect.gen(function* () {
          subscriberCount = Math.max(0, subscriberCount - 1);
          yield* Queue.shutdown(q);
        }),
    );

    const base = Stream.unwrapScoped(Effect.map(acquireSubscriber, (q) => Stream.fromQueue(q)));
    return filter ? Stream.filter(base, filter) : base;
  };

  return {
    publish(event) {
      if (closed) return;
      // `unsafeOffer` is sync; safe on unbounded PubSubs.
      Effect.runSync(PubSub.publish(pubsub, event));
    },
    subscribe(filter) {
      return subscribeStream(filter);
    },
    async close() {
      if (closed) return;
      closed = true;
      await Effect.runPromise(PubSub.shutdown(pubsub));
    },
    get subscriberCount() {
      return subscriberCount;
    },
  };
}

// Re-export the Effect-side types so consumers don't need to import
// `effect` themselves just to type a subscriber.
export type { Scope, Stream };
