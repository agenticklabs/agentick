/**
 * Client runtime-signal receive types (ADR 64) — the shapes `onLog` /
 * `onProgress` deliver. Defined in spec so they can type BOTH the
 * `ClientProtocol.onLog` / `.onProgress` instance methods AND the
 * tree-shakeable `onLog(client, …)` / `onProgress(client, …)` free
 * functions in `@agentick/client-next` — one set of types, two surfaces.
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

/** A received `log` signal: the decoded {@link LogEventPayload} plus its origin {@link EventScope}. */
export type ReceivedLog = LogEventPayload & { readonly scope: EventScope };

/** A received `progress` signal: the decoded {@link ProgressEventPayload} plus its origin {@link EventScope}. */
export type ReceivedProgress = ProgressEventPayload & { readonly scope: EventScope };

/** Options for the `onLog` / `onProgress` subscriptions. */
export interface OnSignalOptions {
  /** Resume from a prior cursor. Omit to read from the current head. */
  readonly fromCursor?: Cursor;
}
