/**
 * ChannelPublisher protocol.
 *
 * Channels are named, per-session, persistent streams. Tools and other
 * harness participants emit values into channels via a typed seed; the
 * channel publisher assigns a monotonic per-channel sequence and routes
 * the resulting `ChannelEvent` to subscribers (typically via the
 * `EventBus`) and to durable storage (typically via the session
 * harness's channel store, when present).
 *
 * Today's reference impl:
 *   - `LocalChannelPublisher` (in `@agentick/runtime`) — per-publisher
 *     sequence counter, dispatch through `EventBus.publishLazy`.
 *
 * Phase 4e — when the session harness lands, it becomes the canonical
 * `ChannelPublisher` impl. Per-session sequencing, retention policy,
 * replay-from-offset, durable persistence on the session record.
 * Harnesses depending on `ChannelPublisher` see no API change; the
 * implementation under the interface evolves.
 *
 * Wire-safe by construction — same shape applies whether the publisher
 * is in-process or routed across a cluster.
 *
 * @see docs/proposals/v2/blueprint/10-events-handlers-inbox.md §Channels
 * @see docs/proposals/v2/blueprint/08-session-harness.md §State the session owns
 */

import type { Effect } from "effect";

import type { EventScope } from "../data/events.js";

/**
 * Caller-supplied input to {@link ChannelPublisher.publish}. The
 * publisher is responsible for materializing this into a
 * {@link ChannelEvent} envelope — assigning id, timestamp, surface,
 * `channelSequence`, and the canonical `name` prefix.
 *
 * Channel name MUST match the published envelope's `name` pattern:
 * `session:channel:<channel>`. To keep the seed ergonomic, callers
 * supply the channel suffix only (`"tool-progress"`); the publisher
 * adds the `session:channel:` prefix.
 */
export interface ChannelSeed<T = unknown> {
  /** Channel name suffix — e.g., `"tool-progress"`. The publisher prepends `session:channel:`. */
  readonly channel: string;
  readonly payload: T;
  /** Optional scope override. Publishers MAY fill missing fields from their own context. */
  readonly scope?: EventScope;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** Causality — the op that produced this channel event. */
  readonly parentOpId?: string;
  readonly correlationId?: string;
}

/**
 * Failure modes for `ChannelPublisher.publish`. Distinct error tags so
 * callers can recover differently — closed channel is configuration,
 * sequence overflow is structural.
 */
export type ChannelPublishError =
  | { readonly _tag: "ChannelPublisherClosed" }
  | { readonly _tag: "ChannelSequenceOverflow"; readonly channel: string };

/**
 * The protocol every channel publisher implements.
 *
 * Implementations are JSON-safe at the wire boundary — `ChannelSeed`
 * carries only data the publisher might serialize across processes.
 * The publisher itself is local to its harness.
 */
export interface ChannelPublisher {
  /**
   * Publish a channel event. The publisher:
   *   1. Assigns `channelSequence` (monotonic per-channel).
   *   2. Materializes the `ChannelEvent` envelope (adds id, timestamp,
   *      `surface: "session"`, full `name`).
   *   3. Routes to subscribers (typically via `EventBus.publishLazy`).
   *   4. Persists to channel storage if applicable (session harness
   *      tracks retention; local publisher does not).
   */
  publish<T = unknown>(
    seed: ChannelSeed<T>,
  ): Effect.Effect<void, ChannelPublishError, never>;
}
