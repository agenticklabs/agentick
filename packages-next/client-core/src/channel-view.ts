/**
 * `channelView` — the OPT-IN fold sugar over a {@link channelStream}.
 *
 * Materializes a channel's frames into a live `T` via `reduce` (the K8s
 * watch-list model: the stream opens with a snapshot frame, then deltas, on the
 * SAME ordered stream). It single-consumes a `channelStream` and fans out TWO
 * feeds to many listeners:
 *   - `subscribe((state) => …)` — the STATE feed (folded value). Also the
 *     `useSyncExternalStore(view.subscribe, view.get)` contract — React passes a
 *     `() => void`, we hand it the state (ignored), it re-reads via `get()`.
 *   - `onChange((frame) => …)` — the CHANGE feed (each frame it folds).
 *
 * The primitive stays dumb — it does not know what a snapshot is. `reduce`
 * handles whatever the producer sends (snapshot-kind seeds, delta-kind folds),
 * which is why one `channelView` covers snapshot+delta channels (knobs) and
 * full-object-per-frame channels (tasks). Knobs/tasks-AGNOSTIC — typed façades
 * supply `reduce`.
 *
 * Folding materializes the whole `T` in memory; that is what opting into a view
 * MEANS. Channels with no meaningful state, or too large to hold, skip the fold
 * and use `channelStream` directly.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy packages-next/client-core/src/__tests__/channel-view.spec.ts
 */

import type { ChannelView, ChannelViewConfig, SubscriptionScope } from "@agentick/spec-next";

import { channelStream, type ChannelClient } from "./channel-stream.js";

// `ChannelView` / `ChannelViewConfig` live in `@agentick/spec-next/client` (they
// type BOTH this free function AND the `ClientProtocol.channelView` method).
export type { ChannelView, ChannelViewConfig } from "@agentick/spec-next";

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
  let state = cfg.initial;
  let closed = false;
  let status: ChannelView<unknown, unknown>["status"] = "loading";
  const stateListeners = new Set<(state: unknown) => void>();
  const frameListeners = new Set<(frame: unknown) => void>();

  const stream = channelStream<unknown>(client, scope, channel);
  void (async () => {
    for await (const frame of stream) {
      if (closed) return;
      let folded: unknown;
      try {
        folded = cfg.reduce(state, frame);
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
    get: (): unknown => state,
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
