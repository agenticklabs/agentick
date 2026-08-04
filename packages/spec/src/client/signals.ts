/**
 * Client runtime-signal receive types (ADR 64) — the shapes `onLog` /
 * `onProgress` deliver. Defined in spec so they can type BOTH the
 * `ClientProtocol.onLog` / `.onProgress` instance methods AND the
 * tree-shakeable `onLog(client, …)` / `onProgress(client, …)` free
 * functions in `@agentick/client-core` — one set of types, two surfaces.
 *
 * A tool / harness emits a `log` / `progress` bus event; the gateway
 * projects matching events to subscribed clients over the `subscribe`
 * channel. These are the decoded payload plus its origin scope.
 *
 * @see docs/proposals/v2/blueprint/64-runtime-signal-family.md
 */

import type { LogEventPayload, ProgressEventPayload } from "../data/signals.js";
import type { EventScope } from "../data/events.js";
import type { Cursor } from "../protocol/event-log.js";

/**
 * Where a received signal came FROM.
 *
 * `scope` says which session and execution; `surface` says which HARNESS —
 * `"timeline"` for a compaction, `"tool"` for a handler's `ctx.progress`. The
 * subscription matches `*:signal:progress` across every surface, so without
 * this a subscriber cannot tell a compaction bar from a tool's, and both move
 * the same widget.
 */
interface SignalOrigin {
  readonly scope: EventScope;
  readonly surface: string;
}

/** A received `log` signal: the decoded {@link LogEventPayload} plus where it came from. */
export type ReceivedLog = LogEventPayload & SignalOrigin;

/** A received `progress` signal: the decoded {@link ProgressEventPayload} plus where it came from. */
export type ReceivedProgress = ProgressEventPayload & SignalOrigin;

/** Options for the `onLog` / `onProgress` subscriptions. */
export interface OnSignalOptions {
  /** Resume from a prior cursor. Omit to read from the current head. */
  readonly fromCursor?: Cursor;
  /**
   * Deliver only this surface's signals — `"timeline"` for compaction,
   * `"tool"` for tool handlers. Filtered at the BUS, so an unwatched surface
   * costs nothing on the wire.
   *
   * Omit to receive every surface and discriminate on {@link SignalOrigin.surface}.
   */
  readonly surface?: string;
}
