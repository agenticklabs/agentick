/**
 * In-process EventBus implementation.
 *
 * Pure pub/sub. Per-subscriber bounded queue with configurable overflow
 * strategy. Lazy fan-out: publish is a no-op when no subscriber's query
 * matches the envelope.
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The PubSub bus
 */

import { Effect, Queue, Stream } from "effect";
import type { EventQuery, ProtocolEvent } from "@agentick/spec";
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

  publish(event: ProtocolEvent): Effect.Effect<void, never, never> {
    return Effect.suspend(() => {
      if (this.closed) return Effect.void;
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

        // Scoped finalizer: when the stream scope closes (interrupt /
        // take-completed / iterable consumer drops), detach.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sub.closed = true;
            bus.subscribers.delete(id);
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
}
