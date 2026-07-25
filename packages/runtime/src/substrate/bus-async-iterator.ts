/**
 * `busAsyncIterator(bus, query, options)` — bridge an `EventBus`'s
 * `Stream`-based subscription to an `AsyncIterator<ProtocolEvent>`.
 * The helper that `AppHarness.events(...)` and
 * `GatewayHarness.events(...)` return.
 *
 * Pattern: `Effect.runFork(Stream.runForEach(...))` drives a producer
 * fiber that fills a queue / resolves pending iterator promises;
 * `iterator.return()` interrupts the fiber via `Fiber.interrupt`.
 *
 * Extracted from duplicated copies in `@agentick/app/harness.ts`
 * and `@agentick/gateway/harness.ts`. The bridge is small but
 * non-trivial (queue + resolvers + done/error flag coordination) and
 * the duplication is the kind that drifts — moving to a single
 * source-of-truth.
 *
 * @see ./local-event-bus.ts
 */

import { Effect, Fiber, Stream } from "effect";

import type { EventBus, EventQuery, ProtocolEvent, SubscribeOptions } from "@agentick/spec";

/**
 * Create a fresh `AsyncIterator<ProtocolEvent>` over a bus
 * subscription. Each call opens a new subscription on `bus`; the
 * substrate event bus is multi-subscriber by design. The iterator
 * runs to bus close (returns `{done: true}`) or until the caller
 * breaks out (which invokes `return()` and interrupts the producer
 * fiber).
 */
export function busAsyncIterator(
  bus: EventBus,
  query: EventQuery,
  options: SubscribeOptions = {},
): AsyncIterator<ProtocolEvent> {
  const stream = bus.subscribe(query, options);
  const queue: ProtocolEvent[] = [];
  const resolvers: Array<(r: IteratorResult<ProtocolEvent>) => void> = [];
  let done = false;
  let error: unknown = null;

  const drain = (): void => {
    for (const r of resolvers.splice(0)) {
      r({ value: undefined as unknown as ProtocolEvent, done: true });
    }
  };

  const fiber = Effect.runFork(
    Stream.runForEach(stream, (event) =>
      Effect.sync(() => {
        if (done) return;
        const r = resolvers.shift();
        if (r) r({ value: event, done: false });
        else queue.push(event);
      }),
    ).pipe(
      Effect.catchAll((e) =>
        Effect.sync(() => {
          error = e;
          done = true;
          drain();
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          done = true;
          drain();
        }),
      ),
    ),
  );

  return {
    next(): Promise<IteratorResult<ProtocolEvent>> {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      if (done) {
        if (error) return Promise.reject(error);
        return Promise.resolve({ value: undefined as unknown as ProtocolEvent, done: true });
      }
      return new Promise((resolve) => resolvers.push(resolve));
    },
    return(): Promise<IteratorResult<ProtocolEvent>> {
      done = true;
      // Interrupt the producer fiber so it stops pushing events; let
      // the caller's `return()` resolve synchronously so awaiters of
      // the next-promise are released immediately.
      void Effect.runPromise(Fiber.interrupt(fiber));
      drain();
      return Promise.resolve({ value: undefined as unknown as ProtocolEvent, done: true });
    },
  };
}
