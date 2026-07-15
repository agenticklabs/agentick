/**
 * Client channel-view types (ADR 33) — the config a `channelView` folds with
 * and the live reduced view it returns. Defined in spec so they can type BOTH
 * the `ClientProtocol.channelView` instance method AND the tree-shakeable
 * `channelView(client, …)` free function in `@agentick/client-core-next` — one set
 * of types, two surfaces.
 *
 * A `channelView` is a pure FOLD over one `session:channel:<x>` subscription
 * (the K8s watch-list / `sendInitialEvents` model): the stream opens with a
 * snapshot frame, then streams deltas on the SAME ordered stream, and `reduce`
 * folds every frame onto held state. These types carry only the fold contract;
 * they know nothing of knobs, tasks, JSON-Patch, or snapshots — that lives in
 * the reducer the typed façades (`knobsStateView`, `taskStatusView`) supply.
 *
 * @see docs/proposals/v2/blueprint/33-client-and-transports.md
 */

import type { Unsubscribe } from "../protocol/inbox.js";

export interface ChannelViewConfig<T, F> {
  /** Value `get()` returns until the first (snapshot) frame folds in. */
  readonly initial: T;
  /** Fold one channel frame (`envelope.payload`) onto the held state. */
  readonly reduce: (state: T, frame: F) => T;
}

/**
 * A live reduced view of one channel. `get()`/`subscribe()` are the
 * `useSyncExternalStore` contract; `close()` tears down the subscription.
 */
export interface ChannelView<T> {
  get(): T;
  /** The `useSyncExternalStore` contract: notify (no args); read via `get()`. */
  subscribe(listener: () => void): Unsubscribe;
  /**
   * Ergonomic sugar over `subscribe` + `get`: `listener` receives the new value
   * on every change (no separate `get()` call). Returns an unsubscribe. Use
   * this for imperative code; use `subscribe` for framework store bindings.
   */
  onChange(listener: (value: T) => void): Unsubscribe;
  readonly closed: boolean;
  close(): void;
}
