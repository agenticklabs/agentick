/**
 * EventBus protocol.
 *
 * Live observation channel + append-only log. `EventBus` is a
 * specialisation of {@link EventLog} over {@link ProtocolEvent}: it
 * exposes the log primitives (`append`, `appendBatch`, `read`,
 * `hasSubscriberFor`, `metrics`) plus bus-specific sugar for the
 * query-shaped subscriber pattern (`subscribe(query, options)`) and
 * construction-on-demand publishing (`publishLazy`).
 *
 * Phase C of ADR 29 reshapes the subscriber model from push-based
 * (per-subscriber bounded `Effect.Queue`) to pull-based (shared ring
 * buffer + per-subscriber cursor). Subscribers pull at their own pace.
 * Subscribers that fall behind retention surface
 * {@link CursorEvictedError} on the stream's failure channel —
 * intentional loud failure (silent skip-ahead is the worse mode for an
 * audit substrate).
 *
 * Implementations:
 *   - LocalEventBus    (in-process ring buffer + cursor pull; Phases 2/B/C)
 *   - ClusterEventBus  (distributed via `@effect/cluster`; Phase D)
 *
 * @see docs/proposals/v2/blueprint/19-foundation.md §The PubSub bus
 * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Phase C
 */

import type { Effect, Stream } from "effect";
import type { EventPhase, EventSurface, ProtocolEvent, EventQuery } from "../data/events.js";
import type { Cursor, CursorEvictedError, EventLog } from "./event-log.js";

/**
 * Subscription options.
 */
export interface SubscribeOptions {
  /**
   * Cursor to start reading from. Omit (default) to read from the
   * current log head — no replay. `{ value: 0 }` replays everything
   * still retained. Adopters resuming after disconnect pass the
   * cursor from the last drained event.
   *
   * If the cursor is older than the log's retained range, the
   * subscribed stream fails with {@link CursorEvictedError} before
   * yielding any event. The error carries the oldest cursor still
   * available — adopters can catch and resubscribe from there.
   *
   * @see docs/proposals/v2/blueprint/29-bus-overhaul.md §Phase C
   */
  readonly fromCursor?: Cursor;
}

/**
 * Match-key fragment used by `hasSubscriberFor` and `publishLazy` to
 * decide whether anyone wants an envelope BEFORE constructing it.
 *
 * The fields here are the cheapest-to-compute subset of `ProtocolEvent`
 * — enough for the bus's subscriber index to short-circuit
 * construction. Implementations MAY use less than the full key (e.g.,
 * conservatively returning `true` from `hasSubscriberFor` if only
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
 *
 * `EventBus extends EventLog<ProtocolEvent>` — every bus is a log of
 * `ProtocolEvent`. The `EventLog` methods (`append`, `appendBatch`,
 * `read`, `hasSubscriberFor`, `metrics`) are the primitive substrate;
 * `publishLazy` and `subscribe(query, options)` are bus-specific
 * sugar on top.
 */
export interface EventBus extends EventLog<ProtocolEvent> {
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
   * continue to use `append` directly — the journal is not a bus
   * subscriber and `hasSubscriberFor` doesn't account for it.
   */
  publishLazy(key: EventKey, build: () => ProtocolEvent): Effect.Effect<void, never, never>;

  /**
   * Subscribe to events matching a query. Bus-specific sugar over
   * {@link EventLog.read} — `subscribe` is "query the bus by a typed
   * query shape," `read` is "pull the log from a cursor with an
   * already-compiled matcher."
   *
   * Returns a `Stream` that yields new envelopes as they're appended.
   * Stream interruption (consumer disposes / scope closes) unsubscribes.
   *
   * Failure channel: {@link CursorEvictedError} when the subscriber's
   * cursor falls behind retention (either at subscribe time if
   * `options.fromCursor` is too old, or in-flight if the subscriber
   * drains slower than retention evicts).
   */
  subscribe(
    query: EventQuery,
    options?: SubscribeOptions,
  ): Stream.Stream<ProtocolEvent, CursorEvictedError, never>;
}

// ============================================================================
// EventBusFactory — per-child construction (ADR 31)
// ============================================================================

import type { Factory } from "./factory.js";

/**
 * Per-child factory shape for {@link EventBus}. Adopters supply the
 * `bus` slot at any level of the harness hierarchy as either an
 * `EventBus` instance (shared across children) or a factory
 * (constructed per child via the recipe pattern).
 *
 * Discrimination at the slot is `typeof slot === "function"`:
 * `EventBus` is an object interface and never callable, so any
 * function in the slot is unambiguously a factory.
 *
 * Use `LocalEventBus.createFactory(...)` from `@agentick/runtime` for
 * ergonomic factory construction with auto-registered close.
 *
 * @see docs/proposals/v2/blueprint/31-harness-hierarchy.md
 */
export type EventBusFactory<P = unknown> = Factory<EventBus, P>;
