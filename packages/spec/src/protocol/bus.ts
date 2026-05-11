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
  /** Cancel the subscription via signal. */
  readonly signal?: AbortSignal;
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
  publish(event: ProtocolEvent): Promise<void>;

  /**
   * Subscribe to events matching a query.
   *
   * Returns an AsyncIterable that yields new envelopes as they're
   * published. Termination semantics:
   *   - consumer for-await early return → unsubscribe
   *   - options.signal aborts            → unsubscribe + iterable ends
   *   - bus closed                       → iterable ends
   *
   * Buffer overflow follows `options.overflow`. With `"error"`, the
   * iterable throws `BufferOverflowError`; with `"drop-*"`, events
   * are silently dropped per the chosen edge.
   */
  subscribe(
    query: EventQuery,
    options?: SubscribeOptions,
  ): AsyncIterable<ProtocolEvent>;
}

/**
 * Thrown by a subscriber's iterable when its bounded buffer overflows
 * and the configured strategy is `"error"`.
 */
export class BufferOverflowError extends Error {
  readonly bufferSize: number;
  constructor(bufferSize: number) {
    super(`Subscriber buffer overflowed (capacity: ${bufferSize})`);
    this.name = "BufferOverflowError";
    this.bufferSize = bufferSize;
  }
}
