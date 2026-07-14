/**
 * `channelView` — a client-side reduced view over one `session:channel:<x>`.
 *
 * A pure FOLD over a channel subscription (the K8s watch-list / `sendInitialEvents`
 * model). The subscription OPENS with a snapshot frame, then streams deltas on
 * the SAME ordered stream; `channelView` folds every frame onto held state via
 * `reduce`, and exposes it through the `useSyncExternalStore` contract
 * (`get()` + `subscribe()`), so a future `client-react` `useChannel(view)` hook
 * is a one-liner.
 *
 * There is NO baseline pull and NO cursor: the snapshot is simply the first
 * frame, so snapshot↔stream ordering is guaranteed by construction (no race to
 * reconcile). The primitive stays dumb — it does not know what a snapshot is.
 * `reduce(state, frame)` handles whatever the producer sends: a snapshot-kind
 * frame seeds, a delta-kind frame folds. That's the producer's + reducer's
 * concern, not the primitive's — which is why the same `channelView` covers
 * both snapshot+delta channels (knobs) and full-object-per-item channels (tasks).
 *
 * Knobs/tasks-AGNOSTIC. Typed façades (`collectionView`, `taskStatusView`,
 * `knobsStateView`) live in their own harness packages and supply `reduce`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy packages-next/client/src/__tests__/channel-view.spec.ts
 */

import type {
  ChannelView,
  ChannelViewConfig,
  ClientTransport,
  SubscriptionScope,
  Unsubscribe,
} from "@agentick/spec-next";
import { channelEventQuery } from "@agentick/spec-next";

// `ChannelView` / `ChannelViewConfig` moved to `@agentick/spec-next/client`
// (they type BOTH this free function AND the `ClientProtocol.channelView`
// method). Re-exported here so the `@agentick/client-next` surface is
// unchanged.
export type { ChannelView, ChannelViewConfig } from "@agentick/spec-next";

/** Minimal client surface a channel view needs. */
interface ChannelClient {
  readonly transport: Pick<ClientTransport, "subscribe">;
}

// With an explicit config the view holds the reducer's accumulator type `T`.
export function channelView<T, F>(
  client: ChannelClient,
  scope: SubscriptionScope,
  channel: string,
  config: ChannelViewConfig<T, F>,
): ChannelView<T>;
/**
 * Zero-config: the default fold is LAST-FRAME-PAYLOAD-WINS
 * (`initial = undefined`, `reduce = (_prev, frame) => frame`). The view
 * holds the latest frame payload, `undefined` before the first frame.
 * This suits FULL-OBJECT-per-frame channels (e.g. `task-status`, where
 * every frame carries the whole object). Snapshot+delta channels (knobs)
 * still need an explicit `reduce` — which is why the typed façades
 * (`knobsStateView`) supply one.
 */
export function channelView<T = unknown>(
  client: ChannelClient,
  scope: SubscriptionScope,
  channel: string,
): ChannelView<T | undefined>;
export function channelView(
  client: ChannelClient,
  scope: SubscriptionScope,
  channel: string,
  config?: ChannelViewConfig<unknown, unknown>,
): ChannelView<unknown> {
  // Default fold: last-frame-payload-wins. Every frame replaces held
  // state; `get()` is `undefined` until the first frame folds in.
  const cfg: ChannelViewConfig<unknown, unknown> = config ?? {
    initial: undefined,
    reduce: (_prev, frame) => frame,
  };
  let state = cfg.initial;
  let closed = false;
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Isolate listener faults — one bad subscriber can't stop delivery.
      }
    }
  };

  // Subscribe and fold. The first frame is the snapshot; the rest are deltas —
  // `reduce` handles both. No baseline pull, no cursor.
  const sub = client.transport.subscribe(scope, channelEventQuery(channel));
  void (async () => {
    for await (const frame of sub) {
      if (closed) return;
      const payload = frame.envelope.payload;
      if (payload === undefined) continue;
      try {
        state = cfg.reduce(state, payload);
        notify();
      } catch {
        // A malformed frame must not tear down the stream.
      }
    }
    // TODO(slice-1b: reconnect re-seed) — the stream ended. If this was a
    // transport drop (not our close()), re-subscribe: a fresh snapshot arrives
    // as frame one and re-seeds the view (the `410 Gone` → relist equivalent).
  })();

  return {
    get: (): unknown => state,
    subscribe(listener: () => void): Unsubscribe {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    get closed(): boolean {
      return closed;
    },
    close(): void {
      closed = true;
      listeners.clear();
      void sub.close();
    },
  };
}
