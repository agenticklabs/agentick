/**
 * `LocalPubSub<T>` — Layer 3 Stream-based pub/sub built on Effect's
 * `PubSub.unbounded()`. Each subscriber gets an independent dequeue
 * so a slow consumer can't starve another.
 *
 *   const bus = createLocalPubSub<TaskEvent>();
 *   const stream = bus.subscribe();
 *   bus.publish({ kind: "started", taskId: "t1" });
 *   await someEffectStream(stream)...
 *   await bus.close();
 *
 * The subscribe `Stream` is internally `Scope.scoped`, so consumers
 * receive a plain `Stream.Stream<T, never, never>` with no caller
 * `Scope` requirement. Pass an optional filter to receive only events
 * that match a predicate; under the hood it's a `Stream.filter`, so
 * the underlying queue still drains evenly.
 *
 * `publish` returns synchronously from the caller's POV — the
 * underlying `PubSub.unbounded()` never blocks on `offer`.
 *
 * **Drain semantics.** `close()` waits for every active subscriber to
 * consume the events it was offered before shutting the PubSub down.
 * Implementation: we track a `publishedCount` (per publish) and a
 * per-subscriber `consumedCount` (incremented as the subscriber pulls
 * from its dequeue). `close()` polls until all subscribers are
 * caught up, then calls `PubSub.shutdown` + `awaitShutdown`. After
 * `close()` returns, no buffered event has been dropped from any
 * subscriber that was active when `close()` was called.
 *
 * Subscribers that detach (Stream interrupted by consumer) before
 * close fires don't block drain — only currently-active subscribers
 * are counted.
 */

import { Effect, Fiber, type Queue, PubSub, Ref, Stream, type Scope } from "effect";
import { isFunction, isUndefined } from "@agentick/utils-next";

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
   * Drain in-flight events to every active subscriber, then shut
   * down the PubSub. After this resolves, no subscriber that was
   * active at close-time was deprived of a published event.
   * Idempotent.
   */
  close(): Promise<void>;
  /** Diagnostic: current subscriber count (best-effort). */
  readonly subscriberCount: number;
}

interface SubscriberTracker {
  readonly consumed: Ref.Ref<number>;
  // Reference to the underlying Effect Queue so close() can inspect drain state.
  readonly dequeue: Queue.Dequeue<unknown>;
}

/**
 * Construction options for {@link createLocalPubSub}.
 */
export interface CreateLocalPubSubOptions<T> {
  /**
   * Upper bound (ms) on the close-time drain. After `close()` waits
   * this long for active subscribers to consume all published events,
   * it proceeds to shutdown regardless. Defensive backstop against a
   * wedged downstream consumer — under normal operation drain
   * completes in microseconds.
   *
   * Defaults to 5_000 (5 seconds). Set higher for long-running
   * subscribers that may legitimately need more time to drain; set
   * lower (or `0`) to disable the drain wait entirely and behave
   * like raw `PubSub.shutdown` (buffered events may be dropped).
   */
  readonly closeDrainTimeoutMs?: number;

  /**
   * Replay buffer — number of past events automatically replayed to
   * every NEW subscriber when they attach. This is the RxJS
   * `ReplaySubject(n)` analogue and is implemented natively by
   * Effect's `PubSub.unbounded({ replay })`.
   *
   *   - `replay: 1` ≈ RxJS BehaviorSubject (every new subscriber
   *     immediately sees the latest event).
   *   - `replay: N` ≈ ReplaySubject(N).
   *   - Omitted / `0` → no replay (default; new subscribers see
   *     only future events).
   *
   * **Caveat for filtered subscribers.** The replay buffer is a
   * GLOBAL ring of the last N published events. If subscribers
   * filter by predicate (`subscribe(e => e.id === "x")`), the
   * buffer's N items may be drawn from any event — the subscriber
   * sees only the subset that matches their filter. For per-key
   * snapshot semantics (e.g. "the latest event for THIS key"),
   * compose `Stream.concat(snapshot, subscribe())` at the caller
   * instead of relying on replay.
   */
  readonly replay?: number;

  /**
   * Side-effect hook invoked synchronously on every successful
   * `publish(event)`, after the event has been offered to the
   * underlying PubSub (so in-process subscribers see it first).
   * Use for FAN-IN to upstream sinks the bus itself shouldn't know
   * about — e.g., a harness routing every publish into the
   * substrate's protocol bus via its own envelope translator.
   *
   * **Layering rationale.** Keeping the hook generic preserves
   * pubsub-next's independence from spec-next's `EventBus` (which
   * would invert the dep graph). Callers own the translation
   * (event → wire envelope, substrate emit, journaling, etc.) and
   * provide it as a closure.
   *
   * **Error isolation.** Throws from `onPublish` are swallowed —
   * a buggy fan-in sink CANNOT block in-process subscribers from
   * seeing the event. Adopters that need to observe sink failures
   * must wrap with their own try/catch + logging.
   *
   * Not fired when `publish` is called after `close()` (the
   * publish is a no-op in that case).
   */
  readonly onPublish?: (event: T) => void;
}

export function createLocalPubSub<T>(options: CreateLocalPubSubOptions<T> = {}): LocalPubSub<T> {
  const closeDrainTimeoutMs = options.closeDrainTimeoutMs ?? 5_000;
  // Allocate the PubSub eagerly via Effect.runSync — unbounded ctor
  // is a pure allocation, no side effects beyond a Queue.
  const pubsub = Effect.runSync(
    !isUndefined(options.replay) && options.replay > 0
      ? PubSub.unbounded<T>({ replay: options.replay })
      : PubSub.unbounded<T>(),
  );

  // publishedCount is the canonical "high water mark" of events seen
  // by the bus. Each subscriber tracks its own consumed count; close()
  // waits until every subscriber's consumed >= publishedCount.
  const publishedCount = Effect.runSync(Ref.make(0));
  const trackers = new Set<SubscriberTracker>();
  let closed = false;

  const subscribeStream = (filter?: (event: T) => boolean): Stream.Stream<T, never, never> => {
    // Acquire-release scope: register tracker on acquire, deregister
    // on release. Stream.fromQueue drains the queue; we wrap each
    // pulled event to bump the consumed counter BEFORE the consumer
    // sees it.
    const acquireSubscriber = Effect.acquireRelease(
      Effect.gen(function* () {
        const dequeue = yield* PubSub.subscribe(pubsub);
        const consumed = yield* Ref.make(0);
        const tracker: SubscriberTracker = {
          consumed,
          dequeue: dequeue as Queue.Dequeue<unknown>,
        };
        trackers.add(tracker);
        return tracker;
      }),
      (tracker) =>
        Effect.gen(function* () {
          trackers.delete(tracker);
          // We don't shutdown the dequeue here — Stream.fromQueue's
          // own scope handles that.
          yield* Effect.void;
        }),
    );

    // Wrap each pulled event in Ref.update before yielding downstream.
    // tap runs the side effect (increment consumed) and passes the
    // event through unchanged.
    const base = Stream.unwrapScoped(
      Effect.map(acquireSubscriber, (tracker) =>
        Stream.fromQueue(tracker.dequeue as Queue.Dequeue<T>).pipe(
          Stream.tap((_event) => Ref.update(tracker.consumed, (n) => n + 1)),
        ),
      ),
    );
    return filter ? Stream.filter(base, filter) : base;
  };

  /**
   * Drain by polling: every 1ms, check if every active subscriber's
   * `consumed >= publishedCount`. Once true, return. Caps at the
   * caller-configurable `closeDrainTimeoutMs` (default 5_000) to
   * avoid hanging if a subscriber is permanently stuck (e.g. its
   * downstream consumer is wedged); after the cap, proceed to
   * shutdown anyway. The cap is a defensive backstop — under normal
   * operation drain completes in microseconds.
   *
   * Pass `closeDrainTimeoutMs: 0` at construction to skip the wait
   * entirely (behaves like raw `PubSub.shutdown` — buffered events
   * may be dropped).
   */
  async function drain(): Promise<void> {
    if (closeDrainTimeoutMs <= 0) return;
    const start = performance.now();
    const cap = closeDrainTimeoutMs;

    // Snapshot the active trackers — subscribers that detach AFTER
    // close was called shouldn't block drain. But we DO want to wait
    // for currently-active ones to catch up.
    const active = [...trackers];

    while (active.length > 0) {
      const published = Effect.runSync(Ref.get(publishedCount));
      let allCaughtUp = true;
      for (const tracker of active) {
        const consumed = Effect.runSync(Ref.get(tracker.consumed));
        if (consumed < published) {
          allCaughtUp = false;
          break;
        }
      }
      if (allCaughtUp) return;
      if (performance.now() - start >= cap) return;
      await new Promise<void>((r) => setTimeout(r, 1));
    }
  }

  return {
    publish(event) {
      if (closed) return;
      // Track the publish FIRST so the drain logic's invariant
      // `subscriber.consumed >= publishedCount` after drain is honest.
      Effect.runSync(Ref.update(publishedCount, (n) => n + 1));
      Effect.runSync(PubSub.publish(pubsub, event));
      // Fan-in hook runs AFTER the in-process publish so subscribers
      // observe the event before any upstream sink does. Errors are
      // isolated — a buggy translator MUST NOT block subscribers.
      if (isFunction(options.onPublish)) {
        try {
          options.onPublish(event);
        } catch {
          /* isolate */
        }
      }
    },
    subscribe(filter) {
      return subscribeStream(filter);
    },
    async close() {
      if (closed) return;
      closed = true;
      await drain();
      // Use runFork + Fiber.join so we don't block forever if the
      // shutdown hangs (defensive — Effect.PubSub.shutdown is total).
      const fiber = Effect.runFork(PubSub.shutdown(pubsub));
      await Effect.runPromise(Fiber.join(fiber)).catch(() => undefined);
    },
    get subscriberCount() {
      return trackers.size;
    },
  };
}

// Re-export the Effect-side types so consumers don't need to import
// `effect` themselves just to type a subscriber.
export type { Scope, Stream };
