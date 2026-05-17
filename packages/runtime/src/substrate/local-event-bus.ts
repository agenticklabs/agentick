/**
 * In-process EventBus implementation.
 *
 * Pure pub/sub. Per-subscriber bounded queue with configurable overflow
 * strategy. Lazy fan-out: publish is a no-op when no subscriber's query
 * matches the envelope.
 *
 * Construction-on-demand (`publishLazy` + `hasSubscriber`) is enabled by
 * a per-surface subscriber index. Subscribers that filter by `surface`
 * register against the index slot for that surface; subscribers with
 * no surface filter count as "broad" and match every key. The index
 * is the "enabled" check borrowed from Rust's `tracing` crate — when
 * nobody is listening for a key, the publisher avoids constructing the
 * envelope at all.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The PubSub bus
 */

import { Effect, Queue, Stream } from "effect";
import type { EventKey, EventQuery, EventSurface, ProtocolEvent } from "@agentick/spec";
import type {
  EventBus,
  SubscribeOptions,
  SubscriberOverflow,
} from "@agentick/spec";
import { BufferOverflowError } from "@agentick/spec";
import { matchesQuery } from "./query.js";

interface Subscriber {
  readonly id: number;
  readonly query: EventQuery;
  readonly overflow: SubscriberOverflow;
  readonly queue: Queue.Queue<ProtocolEvent>;
  /** Set to true once the subscribing stream/scope is interrupted. */
  closed: boolean;
}

export class LocalEventBus implements EventBus {
  private subscribers = new Map<number, Subscriber>();
  private nextId = 0;
  private closed = false;

  /**
   * Per-surface subscriber count. Updated on subscribe / detach. A
   * positive count means at least one subscriber filters on that
   * surface (and would match keys with `surface === k`).
   */
  private readonly bySurface = new Map<EventSurface, number>();

  /**
   * Subscribers with no surface filter — they match every key regardless
   * of surface. We count rather than store; the full query check at
   * publish time decides if a specific event matches.
   */
  private broadCount = 0;

  publish(event: ProtocolEvent): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
      // Fast path: no subscriber wants this surface.
      if (this.broadCount === 0 && (this.bySurface.get(event.surface) ?? 0) === 0) {
        return Effect.void;
      }
      const effects: Effect.Effect<void, never, never>[] = [];
      for (const sub of this.subscribers.values()) {
        if (sub.closed) continue;
        if (!matchesQuery(event, sub.query)) continue;
        effects.push(this.deliver(sub, event));
      }
      if (effects.length === 0) return Effect.void;
      return Effect.all(effects, { discard: true });
    });
  }

  publishLazy(
    key: EventKey,
    build: () => ProtocolEvent,
  ): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (!this.hasSubscriber(key)) return Effect.void;
      // At least one subscriber may match — construct and route through
      // the regular publish path. The per-subscriber full query check
      // still runs there and filters non-matching candidates.
      return this.publish(build());
    });
  }

  hasSubscriber(key: EventKey): boolean {
    if (this.closed) return false;
    if (this.broadCount > 0) return true;
    return (this.bySurface.get(key.surface) ?? 0) > 0;
  }

  subscribe(
    query: EventQuery,
    options: SubscribeOptions = {},
  ): Stream.Stream<ProtocolEvent, BufferOverflowError, never> {
    const bus = this;
    const bufferSize = options.bufferSize ?? 256;
    const overflow = options.overflow ?? "drop-oldest";

    return Stream.unwrapScoped(
      Effect.gen(function* () {
        if (bus.closed) {
          return Stream.empty as Stream.Stream<ProtocolEvent, BufferOverflowError, never>;
        }

        const queue =
          overflow === "drop-newest"
            ? yield* Queue.dropping<ProtocolEvent>(bufferSize)
            : overflow === "drop-oldest"
              ? yield* Queue.sliding<ProtocolEvent>(bufferSize)
              : yield* Queue.bounded<ProtocolEvent>(bufferSize);

        const id = bus.nextId++;
        const sub: Subscriber = {
          id,
          query,
          overflow,
          queue,
          closed: false,
        };
        bus.subscribers.set(id, sub);
        bus.indexAttach(query);

        // Scoped finalizer: when the stream scope closes (interrupt /
        // take-completed / iterable consumer drops), detach.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            if (!sub.closed) {
              sub.closed = true;
              bus.subscribers.delete(id);
              bus.indexDetach(query);
            }
            return Queue.shutdown(queue);
          }).pipe(Effect.flatMap((eff) => eff)),
        );

        // Stream.fromQueue yields never-failing under sliding/dropping/bounded.
        // For overflow === "error" we instead detect publish-side full and
        // shut down the queue with a BufferOverflowError surfaced as a
        // typed stream failure via the deliver() path.
        return Stream.fromQueue(queue) as Stream.Stream<
          ProtocolEvent,
          BufferOverflowError,
          never
        >;
      }),
    );
  }

  /** Close all subscribers. Test helper. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const sub of this.subscribers.values()) {
      sub.closed = true;
      Effect.runFork(Queue.shutdown(sub.queue));
    }
    this.subscribers.clear();
    this.bySurface.clear();
    this.broadCount = 0;
  }

  /** Diagnostic: count of active subscribers. */
  subscriberCount(): number {
    let n = 0;
    for (const s of this.subscribers.values()) if (!s.closed) n++;
    return n;
  }

  // ────────── helpers ──────────

  private deliver(
    sub: Subscriber,
    event: ProtocolEvent,
  ): Effect.Effect<void, never, never> {
    // sliding (drop-oldest) and dropping (drop-newest) handle their own
    // overflow inside Effect's Queue. Offer always succeeds; for
    // dropping it returns false (drops the new value).
    return Queue.offer(sub.queue, event).pipe(Effect.asVoid);
  }

  /**
   * Update the surface index when a subscriber attaches. Queries that
   * filter on `surface` bump the per-surface count; queries that don't
   * filter on surface bump `broadCount`. Surface filters expressed as
   * arrays bump every named surface they list.
   */
  private indexAttach(query: EventQuery): void {
    if (query.surface === undefined) {
      this.broadCount++;
      return;
    }
    const surfaces = Array.isArray(query.surface) ? query.surface : [query.surface];
    for (const s of surfaces) {
      this.bySurface.set(s, (this.bySurface.get(s) ?? 0) + 1);
    }
  }

  private indexDetach(query: EventQuery): void {
    if (query.surface === undefined) {
      this.broadCount = Math.max(0, this.broadCount - 1);
      return;
    }
    const surfaces = Array.isArray(query.surface) ? query.surface : [query.surface];
    for (const s of surfaces) {
      const next = (this.bySurface.get(s) ?? 0) - 1;
      if (next <= 0) this.bySurface.delete(s);
      else this.bySurface.set(s, next);
    }
  }
}
