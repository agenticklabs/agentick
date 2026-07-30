/**
 * `eventView` — the generic client-side fold over ANY session-event
 * subscription (an {@link EventQuery} on a {@link SubscriptionScope}), the
 * machine underneath both {@link channelView} (channel-scoped) and the
 * timeline `fold` (a command-lifecycle projection).
 *
 * Materializes a subscription's frames into a live `T` via `reduce`, then
 * single-consumes that stream and fans out TWO feeds to many listeners:
 *   - `subscribe((state) => …)` — the STATE feed (folded value). Also the
 *     `useSyncExternalStore(view.subscribe, view.get)` contract — React passes
 *     a `() => void`, we hand it the state (ignored), it re-reads via `get()`.
 *   - `onChange((frame) => …)` — the CHANGE feed (each frame it folds).
 *
 * The primitive stays dumb — it does not know what a snapshot, delta, or append
 * envelope is. `reduce` handles whatever the producer sends, which is why one
 * `eventView` covers snapshot+delta channels (knobs), full-object-per-frame
 * channels (tasks), AND append-envelope folds (timeline). Typed façades supply
 * `reduce` + the `query`.
 *
 * Folding materializes the whole `T` in memory; that is what opting into a view
 * MEANS. Streams with no meaningful state, or too large to hold, skip the fold
 * and use {@link eventStream} directly.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy packages/client-core/src/__tests__/event-view.spec.ts
 */

import type { ChannelView, Cursor, EventQuery, SubscriptionScope } from "@agentick/spec";

import { eventStream, type EventClient } from "./event-stream.js";
import { liveStore } from "./live-store.js";

export type { ChannelView } from "@agentick/spec";
export type { EventClient } from "./event-stream.js";

/**
 * The fold config for {@link eventView}: the channel-view fold contract
 * (`initial` + `reduce`) plus the optional live-tail resume point. `fromCursor`
 * is threaded into `transport.subscribe(scope, query, fromCursor)` so the fold
 * resumes from AFTER a server-hydrated seed (the AI-SDK `initialMessages`
 * pattern) without replaying already-seen frames.
 */
export interface EventViewConfig<T, F> {
  /** Value `get()` returns until the first frame folds in. */
  readonly initial: T;
  /** Fold one frame (`envelope.payload`) onto the held state. */
  readonly reduce: (state: T, frame: F) => T;
  /** Resume the live tail from AFTER this cursor. Omit → tail from now. */
  readonly fromCursor?: Cursor;
}

/**
 * Fold `query`'s frames on `scope` into a live {@link ChannelView}. The view
 * holds the reducer's accumulator type `T`; the change feed is typed `F`.
 */
export function eventView<T, F>(
  client: EventClient,
  scope: SubscriptionScope,
  query: EventQuery,
  config: EventViewConfig<T, F>,
): ChannelView<T, F> {
  const stream = eventStream<F>(client, scope, query, config.fromCursor);
  // The fan-out core; `close()` tears the stream down. `eventView` returns it
  // as a plain `ChannelView` — the imperative `set`/`closed` seams are internal
  // (used only by the fold loop below).
  const store = liveStore<T, F>(config.initial, () => stream.close());

  void (async () => {
    for await (const frame of stream) {
      if (store.closed) return;
      let folded: T;
      try {
        folded = config.reduce(store.get(), frame);
      } catch {
        // A malformed frame must not tear down the stream.
        continue;
      }
      store.set(folded, frame);
    }
  })().catch(() => {
    // The SUBSCRIPTION died rather than went quiet — refused by the server, or
    // not resurrected by a reconnect; the transport ends the stream with the
    // reason instead of letting it hang (#263). Distinct from a malformed
    // frame, which is skipped above. This loop floats, so an uncaught
    // rejection here is fatal under Node's default policy.
    //
    // Closing the store is the honest report at this layer: `status` becomes
    // `"closed"`, so a consumer can tell a dead view from an idle one instead
    // of rendering a snapshot that will never update again. The held state is
    // left intact. TODO(dead-feed-notify): `liveStore.close()` clears its
    // listeners without notifying them, so a subscribed consumer is not woken.
    store.close();
  });

  return store;
}
