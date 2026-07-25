/**
 * `channelStream` — {@link eventStream} pinned to one channel's query
 * (`channelEventQuery(channel)`): a channel's ordered stream of frames
 * (`envelope.payload`), snapshot-first then deltas. Materializes NOTHING, so it
 * is the general construct for any state shape — a small value, a large
 * collection, a paginated feed, or a request/event channel. Every typed read
 * surface (including {@link channelView}) bottoms out in the generic
 * `eventStream`.
 *
 * SINGLE-CONSUMER, like the transport subscription it wraps: consume it ONCE —
 * `for await (const frame of stream)` OR `stream.onChange(cb)` (which drives the
 * same underlying iteration). For MANY observers, use {@link channelView} (it
 * single-consumes a stream and fans state out to many listeners), or open a
 * second `channelStream`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy packages/client-core/src/__tests__/channel-stream.spec.ts
 */

import type { ChannelStream, SubscriptionScope } from "@agentick/spec";
import { channelEventQuery } from "@agentick/spec";

import { eventStream, type EventClient } from "./event-stream.js";

export type { ChannelStream } from "@agentick/spec";

/**
 * Minimal client surface a channel stream/view needs. Structurally the generic
 * {@link EventClient}; kept as a named alias so channel consumers import a
 * channel-flavored type.
 */
export type ChannelClient = EventClient;

/**
 * Open a channel's frame stream. Yields each frame's `envelope.payload` (typed
 * `F`); frames with an `undefined` payload are skipped. A thin façade over
 * {@link eventStream} with the channel's query pinned.
 */
export function channelStream<F = unknown>(
  client: ChannelClient,
  scope: SubscriptionScope,
  channel: string,
): ChannelStream<F> {
  return eventStream<F>(client, scope, channelEventQuery(channel));
}
