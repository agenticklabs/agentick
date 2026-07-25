/**
 * Client channel-view types (ADR 33) — the config a `channelView` folds with
 * and the live reduced view it returns. Defined in spec so they can type BOTH
 * the `ClientProtocol.channelView` instance method AND the tree-shakeable
 * `channelView(client, …)` free function in `@agentick/client-core` — one set
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
 * The GROUND-FLOOR read primitive: a channel's ordered stream of frames
 * (`envelope.payload`), snapshot-first then deltas. It materializes NOTHING —
 * so it is the general construct for ANY state shape (a small value, a large
 * collection, a paginated feed, a request/event channel like elicitation).
 * Every typed read surface bottoms out here.
 *
 * Consume it two ways, both the same feed:
 *   - `for await (const frame of stream)` — sequential, with backpressure.
 *   - `stream.onChange((frame) => …)` — fire-and-forget callback.
 *
 * {@link ChannelView} is the OPT-IN fold sugar on top of this (materialize the
 * frames into a `T`); channels with no meaningful materialized state (or too
 * large to hold) use the stream directly.
 */
export interface ChannelStream<F> extends AsyncIterable<F> {
  /** The change feed as a callback (sugar over the async iterator). */
  onChange(listener: (frame: F) => void): Unsubscribe;
  /** Tear down the underlying subscription. */
  close(): void;
}

/**
 * The fold sugar over a {@link ChannelStream}: materializes the frames into a
 * live `T` via `reduce`. Two feeds, one subscription:
 *   - `subscribe((state) => …)` — the STATE feed (the folded value; also the
 *     `useSyncExternalStore` contract with `get`).
 *   - `onChange((frame) => …)` — the CHANGE feed (the individual frames it is
 *     folding), identical to the underlying stream's `onChange`.
 * `status` reports readiness; `close()` tears down.
 *
 * `F` defaults to `unknown` so generic `ChannelView<T>` uses still compile;
 * typed façades specify `F` to type the change feed.
 */
export interface ChannelView<T, F = unknown> {
  /** The current folded state — synchronous (also the React `getSnapshot`). */
  get(): T;
  /**
   * STATE feed: `listener` receives the folded state on every change. Also
   * satisfies `useSyncExternalStore(view.subscribe, view.get)` — React passes a
   * `() => void` and re-reads via `get()`, ignoring the value we hand it.
   */
  subscribe(listener: (state: T) => void): Unsubscribe;
  /** CHANGE feed: `listener` receives each frame the view folds. */
  onChange(listener: (frame: F) => void): Unsubscribe;
  /** `loading` before the first frame folds, then `live`, then `closed`. */
  readonly status: "loading" | "live" | "closed";
  close(): void;
}
