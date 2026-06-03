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
import type { EventPhase, EventSurface, ProtocolEvent, EventQuery } from "../data/events.js";

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
 * Match-key fragment used by `hasSubscriber` and `publishLazy` to
 * decide whether anyone wants an envelope BEFORE constructing it.
 *
 * The fields here are the cheapest-to-compute subset of `ProtocolEvent`
 * — enough for the bus's subscriber index to short-circuit
 * construction. Implementations MAY use less than the full key (e.g.,
 * conservatively returning `true` from `hasSubscriber` if only
 * `surface` is supplied), but they MUST NEVER return `false` for a
 * key that an active subscriber's query would match. False negatives
 * are correctness bugs; false positives are paper-cut over-builds.
 */
export interface EventKey {
  readonly surface: EventSurface;
  readonly name: string;
  readonly phase?: EventPhase;
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
   * Construction-on-demand publish. The bus probes its subscriber
   * index against `key` first; only invokes `build` (and routes the
   * resulting envelope) if at least one subscriber's query could
   * match. When nobody is listening, the cost is one map lookup.
   *
   * This is the "enabled" pattern from the Rust `tracing` crate adapted
   * to typed envelopes: a hot publisher (streaming model tokens, dense
   * sandbox stdout, etc.) avoids paying envelope-construction cost when
   * no observer wants the result. Always-journaled phases SHOULD
   * continue to use `publish` directly — the journal is not a bus
   * subscriber and `hasSubscriber` doesn't account for it.
   */
  publishLazy(key: EventKey, build: () => ProtocolEvent): Effect.Effect<void, never, never>;

  /**
   * Probe whether any active subscriber's query could match an
   * envelope with the supplied key. O(1) amortized via the bus's
   * internal subscriber index.
   *
   * Contract:
   *   - false → no subscriber matches; publishing is safe to skip.
   *   - true  → at least one subscriber's query MAY match; the
   *             publisher should construct and call `publish`.
   *             Implementations MAY return `true` conservatively when
   *             the query system cannot rule a match out from the key
   *             alone.
   *
   * Implementations MUST NEVER return `false` for a key an active
   * subscriber's query would match — that is a correctness bug.
   */
  hasSubscriber(key: EventKey): boolean;

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

// ============================================================================
// EventBusFactory — deferred per-session construction (ADR 30)
// ============================================================================

import type { Factory } from "./factory.js";

/**
 * Per-session factory shape for {@link EventBus}. Adopters supply the
 * `bus` slot on `AppHarnessOptions` as either an `EventBus` instance
 * (shared across sessions) or an `EventBusFactory` (constructed per
 * session via the recipe pattern).
 *
 * The marker (`eventBusFactory: true`) lets the slot resolver
 * disambiguate at runtime; `typeof slot === "function"` is also
 * sufficient since `EventBus` itself is an object interface and never
 * callable.
 *
 * Use `LocalEventBus.createFactory(...)` from `@agentick/runtime` for
 * ergonomic factory construction with auto-registered close.
 *
 * @see docs/proposals/v2/blueprint/30-app-as-recipe.md
 */
export interface EventBusFactory extends Factory<EventBus> {
  readonly eventBusFactory: true;
}

/** Type guard for {@link EventBusFactory}. */
export function isEventBusFactory(v: unknown): v is EventBusFactory {
  return (
    typeof v === "function" &&
    (v as { eventBusFactory?: unknown }).eventBusFactory === true
  );
}
