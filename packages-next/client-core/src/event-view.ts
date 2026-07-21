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
 * @verifiedBy packages-next/client-core/src/__tests__/event-view.spec.ts
 */

import type { ChannelView, Cursor, EventQuery, SubscriptionScope } from "@agentick/spec-next";

import { eventStream, type EventClient } from "./event-stream.js";

export type { ChannelView } from "@agentick/spec-next";
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
  let state: T = config.initial;
  let closed = false;
  let status: ChannelView<T, F>["status"] = "loading";
  const stateListeners = new Set<(state: T) => void>();
  const frameListeners = new Set<(frame: F) => void>();

  const stream = eventStream<F>(client, scope, query, config.fromCursor);
  void (async () => {
    for await (const frame of stream) {
      if (closed) return;
      let folded: T;
      try {
        folded = config.reduce(state, frame);
      } catch {
        // A malformed frame must not tear down the stream.
        continue;
      }
      state = folded;
      status = "live";
      // Change feed first (the frame), then the state feed (the folded result).
      for (const l of [...frameListeners]) {
        try {
          l(frame);
        } catch {
          /* isolate */
        }
      }
      for (const l of [...stateListeners]) {
        try {
          l(state);
        } catch {
          /* isolate */
        }
      }
    }
  })();

  return {
    get: (): T => state,
    subscribe(listener) {
      stateListeners.add(listener);
      return () => {
        stateListeners.delete(listener);
      };
    },
    onChange(listener) {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    get status() {
      return status;
    },
    close(): void {
      closed = true;
      status = "closed";
      stateListeners.clear();
      frameListeners.clear();
      stream.close();
    },
  };
}
