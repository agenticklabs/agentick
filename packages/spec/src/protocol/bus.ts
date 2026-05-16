/**
 * EventBus protocol.
 *
 * Live observation channel. Pure pub/sub over `ProtocolEvent`.
 * Multi-subscriber, fire-and-forget. Subscribers cannot affect
 * execution.
 *
 * Implementations:
 *   - LocalEventBus    (in-process PubSub; Phase 2)
 *   - ClusterEventBus  (distributed via cluster framework; Phase 7)
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The PubSub bus
 */

import type { Effect, Stream } from "effect";
import type { ProtocolEvent, EventQuery } from "../data/events.js";

/**
 * Bounded buffer overflow strategy for subscriber streams.
 */
export type SubscriberOverflow = "drop-oldest" | "drop-newest" | "error";

/**
 * Subscription options.
 */
export interface SubscribeOptions {
  /** Per-subscriber bounded buffer. Default: 256. */
  readonly bufferSize?: number;
  readonly overflow?: SubscriberOverflow;
}

/**
 * The bus protocol.
 *
 * Cost when no subscribers match: zero. Lazy fan-out is structural.
 */
export interface EventBus {
  /**
   * Publish an envelope to the bus.
   *
   * If no subscribers match the envelope's surface/name/scope, the
   * call is a no-op (lazy fan-out). Implementations MUST NOT block on
   * slow subscribers — each subscriber has its own bounded buffer.
   */
  publish(event: ProtocolEvent): Effect.Effect<void, never, never>;

  /**
   * Subscribe to events matching a query.
   *
   * Returns a `Stream` that yields new envelopes as they're published.
   * Stream interruption (consumer disposes / scope closes) unsubscribes.
   *
   * Buffer overflow follows `options.overflow`. With `"error"`, the
   * stream fails with `BufferOverflowError`; with `"drop-*"`, events
   * are silently dropped per the chosen edge.
   */
  subscribe(
    query: EventQuery,
    options?: SubscribeOptions,
  ): Stream.Stream<ProtocolEvent, BufferOverflowError, never>;
}

/**
 * Surfaced through the subscribe stream's failure channel when the
 * bounded buffer overflows and the configured strategy is `"error"`.
 */
export class BufferOverflowError extends Error {
  readonly _tag = "BufferOverflowError" as const;
  readonly bufferSize: number;
  constructor(bufferSize: number) {
    super(`Subscriber buffer overflowed (capacity: ${bufferSize})`);
    this.name = "BufferOverflowError";
    this.bufferSize = bufferSize;
  }
}
