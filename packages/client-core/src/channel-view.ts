/**
 * `channelView` — the OPT-IN fold sugar over a channel subscription:
 * {@link eventView} pinned to one channel's query (`channelEventQuery(channel)`).
 *
 * Materializes a channel's frames into a live `T` via `reduce` (the K8s
 * watch-list model: the stream opens with a snapshot frame, then deltas, on the
 * SAME ordered stream), single-consumes it, and fans out TWO feeds to many
 * listeners:
 *   - `subscribe((state) => …)` — the STATE feed (folded value). Also the
 *     `useSyncExternalStore(view.subscribe, view.get)` contract — React passes a
 *     `() => void`, we hand it the state (ignored), it re-reads via `get()`.
 *   - `onChange((frame) => …)` — the CHANGE feed (each frame it folds).
 *
 * The fold machine is `eventView`; `channelView` is exactly `eventView` with
 * the channel's `EventQuery` and no `fromCursor` (channels are snapshot-first,
 * cursorless). Knobs/tasks-AGNOSTIC — typed façades supply `reduce`.
 *
 * Folding materializes the whole `T` in memory; that is what opting into a view
 * MEANS. Channels with no meaningful state, or too large to hold, skip the fold
 * and use `channelStream` directly.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy packages/client-core/src/__tests__/channel-view.spec.ts
 */

import type { ChannelView, ChannelViewConfig, SubscriptionScope } from "@agentick/spec";
import { channelEventQuery } from "@agentick/spec";

import { eventView } from "./event-view.js";
import type { ChannelClient } from "./channel-stream.js";

// `ChannelView` / `ChannelViewConfig` live in `@agentick/spec/client` (they
// type BOTH this free function AND the `ClientProtocol.channelView` method).
export type { ChannelView, ChannelViewConfig } from "@agentick/spec";

// With an explicit config the view holds the reducer's accumulator type `T`.
export function channelView<T, F>(
  client: ChannelClient,
  scope: SubscriptionScope,
  channel: string,
  config: ChannelViewConfig<T, F>,
): ChannelView<T, F>;
/**
 * Zero-config: the default fold is LAST-FRAME-WINS (`initial = undefined`,
 * `reduce = (_prev, frame) => frame`). Suits full-object-per-frame channels
 * (e.g. `task-status`). Snapshot+delta channels (knobs) supply an explicit
 * `reduce` via their façade.
 */
export function channelView<T = unknown>(
  client: ChannelClient,
  scope: SubscriptionScope,
  channel: string,
): ChannelView<T | undefined, T>;
export function channelView(
  client: ChannelClient,
  scope: SubscriptionScope,
  channel: string,
  config?: ChannelViewConfig<unknown, unknown>,
): ChannelView<unknown, unknown> {
  const cfg: ChannelViewConfig<unknown, unknown> = config ?? {
    initial: undefined,
    reduce: (_prev, frame) => frame,
  };
  // `channelView` = `eventView` with the channel's query. Channels are
  // snapshot-first and cursorless, so no `fromCursor` is threaded.
  return eventView(client, scope, channelEventQuery(channel), cfg);
}
