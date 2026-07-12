/**
 * Channel event-name domain + subscriber-side query helper.
 *
 * Channels are named, per-session, persistent streams whose events ride
 * the bus under the canonical name `session:channel:<channel>` (the
 * `channel` name domain — sibling to `signal` and `command`). The
 * publisher side lives in `../protocol/channels.ts` (`ChannelPublisher` /
 * `ChannelSeed`); this module is the SUBSCRIBER side — the one query a
 * client-side channel consumer needs, mirroring `logEventQuery()` /
 * `progressEventQuery()` in `./signals.ts`.
 *
 * @see docs/proposals/v2/blueprint/10-events-handlers-inbox.md §Channels
 */

import type { EventQuery } from "./events.js";

/** Every channel event is emitted by the session surface. */
export const CHANNEL_SURFACE = "session" as const;

/**
 * The middle name segment for channel events — `session:CHANNEL:<name>`.
 * Distinguishes channel streams from operation-lifecycle (`command`) and
 * diagnostics (`signal`).
 */
export const CHANNEL_NAME_DOMAIN = "channel" as const;

/**
 * Canonical fully-qualified event name for a channel — the `name` every
 * `ChannelEvent` on that channel carries, and the value the publisher
 * prepends `session:channel:` to build. One source of truth for the
 * prefix so producers and the subscriber query agree.
 */
export function channelEventName(channel: string): string {
  return `${CHANNEL_SURFACE}:${CHANNEL_NAME_DOMAIN}:${channel}`;
}

/**
 * Subscriber-side query matching exactly one channel's events. Combine
 * with a `SubscriptionScope` (e.g. `{ kind: "session", id }`) at the
 * `transport.subscribe` call to narrow to one session.
 *
 * @verifiedBy packages-next/spec/src/__tests__/channels.spec.ts
 */
export function channelEventQuery(channel: string): EventQuery {
  return { surface: CHANNEL_SURFACE, name: { exact: channelEventName(channel) } };
}
