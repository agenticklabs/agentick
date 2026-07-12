/**
 * `channelView` — a client-side reduced view over one `session:channel:<x>`.
 *
 * The generic channel-consumer primitive. It composes two existing wire
 * surfaces — it invents NO new protocol:
 *
 *   1. PULL a baseline (`config.baseline()`) — "give me current state." The
 *      baseline carries a {@link Cursor} pinning the exact log position it
 *      reflects, so the stream below resumes right after it. This is the
 *      versionless snapshot↔stream tie: the transport's own cursor, not any
 *      per-frame `version` bookkeeping.
 *   2. PUSH deltas — subscribe to the channel's event stream
 *      (`transport.subscribe(scope, channelEventQuery(channel), cursor)`) and
 *      fold each frame onto the held state via `config.reduce`.
 *
 * The held state is exposed through the `useSyncExternalStore` contract
 * (`get()` + `subscribe(cb)`), so a future `client-react` `useChannel(view)`
 * hook falls out for free. Knobs/tasks-AGNOSTIC — typed façades
 * (`knobsStateView`, `taskStatusView`) live in their own harness packages and
 * supply `baseline` + `reduce`.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 * @verifiedBy packages-next/client/src/__tests__/channel-view.spec.ts
 */

import type { ClientTransport, Cursor, SubscriptionScope, Unsubscribe } from "@agentick/spec-next";
import { channelEventQuery } from "@agentick/spec-next";

/** Minimal client surface a channel view needs. */
interface ChannelClient {
  readonly transport: Pick<ClientTransport, "subscribe">;
}

/**
 * The result of a baseline pull: the current reduced state plus the cursor
 * the delta stream should resume from (the log position the snapshot
 * reflects). Omit `cursor` to resume from the head (accepts a small
 * snapshot↔stream overlap — fine for idempotent reducers).
 */
export interface ChannelBaseline<T> {
  readonly state: T;
  readonly cursor?: Cursor;
}

export interface ChannelViewConfig<T, F> {
  /** Value returned by `get()` until the baseline resolves (e.g. an empty map). */
  readonly initial: T;
  /** Pull the current baseline. Called on open (reconnect re-pull: slice 1b). */
  readonly baseline: () => Promise<ChannelBaseline<T>>;
  /** Fold one pushed channel frame (`envelope.payload`) onto the held state. */
  readonly reduce: (state: T, frame: F) => T;
}

/**
 * A live reduced view of one channel. `get()`/`subscribe()` are the
 * `useSyncExternalStore` contract; `close()` tears down the subscription.
 */
export interface ChannelView<T> {
  get(): T;
  subscribe(listener: () => void): Unsubscribe;
  readonly closed: boolean;
  close(): void;
}

export function channelView<T, F>(
  client: ChannelClient,
  scope: SubscriptionScope,
  channel: string,
  config: ChannelViewConfig<T, F>,
): ChannelView<T> {
  let state = config.initial;
  let closed = false;
  const listeners = new Set<() => void>();
  let stream: { close(): Promise<void> } | undefined;

  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Isolate listener faults — one bad subscriber can't stop delivery.
      }
    }
  };
  const set = (next: T): void => {
    state = next;
    notify();
  };

  void (async () => {
    // 1) PULL the baseline. Its cursor pins the log position the snapshot
    //    reflects, so the stream resumes exactly after it.
    let base: ChannelBaseline<T>;
    try {
      base = await config.baseline();
    } catch {
      // TODO(slice-1b): surface a status + retry the baseline on reconnect.
      return;
    }
    if (closed) return;
    set(base.state);

    // 2) PUSH: fold each subsequent channel frame onto the baseline.
    const sub = client.transport.subscribe(scope, channelEventQuery(channel), base.cursor);
    stream = sub;
    for await (const frame of sub) {
      if (closed) return;
      const payload = frame.envelope.payload;
      if (payload === undefined) continue;
      try {
        set(config.reduce(state, payload as F));
      } catch {
        // A malformed frame must not tear down the stream.
      }
    }
    // TODO(slice-1b: reconnect re-pull) — the stream ended. If this was a
    // transport drop (not our close()), re-run baseline() + re-subscribe.
  })();

  return {
    get: (): T => state,
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
      void stream?.close();
    },
  };
}
