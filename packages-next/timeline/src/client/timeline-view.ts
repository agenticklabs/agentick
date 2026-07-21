/**
 * `timelineView` — the client-side reactive view of a session's timeline.
 *
 * The client timeline is `fold(session event stream)` — NOT a bespoke channel,
 * NOT a read RPC. Every `timeline.append(...)` runs through the harness command
 * path (ADR 51) and emits a `timeline:command:append` lifecycle whose
 * `requested`-phase envelope carries the appended entries as `envelope.payload`
 * ({@link TimelineAppendInput} `{ entries }`). `timelineView` selects exactly
 * those envelopes (via `timelineEventQuery()`) and folds their entries onto a
 * growing `readonly TimelineEntry[]`.
 *
 * The timeline façade (rung 1) over the generic `eventView` primitive: it hides
 * the query, the append-envelope shape, and the array fold. An adopter calls
 * `timelineView(client, sessionId, { initial, fromCursor })` and gets a live
 * `readonly TimelineEntry[]` they can `get()` / `subscribe()` — knowing nothing
 * about `timeline:command:append`, phases, or envelopes.
 *
 * Seeding follows the AI-SDK `initialMessages` pattern: `initial` is
 * server-hydrated history (e.g. loaded server-side from `LogStore.history`),
 * and `fromCursor` resumes the live tail from AFTER that history so appends are
 * not double-counted. Omit both → an empty accumulator tailing live from now.
 *
 * @verifiedBy packages-next/timeline/src/client/__tests__/timeline-view.spec.ts
 */

import { eventView } from "@agentick/client-core-next";
import type {
  ChannelView,
  ClientTransport,
  Cursor,
  SubscriptionScope,
  TimelineAppendInput,
  TimelineEntry,
} from "@agentick/spec-next";
import { timelineEventQuery } from "@agentick/spec-next";

/**
 * Read surface for the timeline client façade: `timelineView` folds the
 * timeline append events and only needs `transport.subscribe`.
 */
export interface TimelineClient {
  readonly transport: Pick<ClientTransport, "subscribe">;
}

export interface TimelineViewOptions {
  /**
   * Server-hydrated history to seed the fold (the AI-SDK `initialMessages`
   * pattern) — e.g. loaded server-side from `LogStore.history`.
   */
  readonly initial?: readonly TimelineEntry[];
  /**
   * Resume the live tail from AFTER the seeded history so appends are not
   * double-counted. Omit → tail from the current position (no replay).
   */
  readonly fromCursor?: Cursor;
  /**
   * Optional visibility filter — return `true` to keep an entry. Default:
   * surface all (`model` / `observer` / `log`).
   */
  readonly visibility?: (entry: TimelineEntry) => boolean;
}

/**
 * A live view of `session`'s timeline. Seeds from `options.initial`, then folds
 * every `timeline:command:append` requested-phase envelope's entries onto the
 * growing array (copy-on-write — a new array ref per fold for the
 * `useSyncExternalStore` contract). The change feed (`onChange`) delivers each
 * raw {@link TimelineAppendInput} the view folds.
 */
export function timelineView(
  client: TimelineClient,
  sessionId: string,
  options?: TimelineViewOptions,
): ChannelView<readonly TimelineEntry[], TimelineAppendInput> {
  const scope: SubscriptionScope = { kind: "session", id: sessionId };
  const visibility = options?.visibility;
  return eventView<readonly TimelineEntry[], TimelineAppendInput>(
    client,
    scope,
    timelineEventQuery(),
    {
      initial: options?.initial ?? [],
      fromCursor: options?.fromCursor,
      reduce: (entries, append) => {
        const incoming = visibility ? append.entries.filter(visibility) : append.entries;
        // Copy-on-write only when the fold actually grows — an all-filtered
        // batch keeps the same reference (no spurious re-render).
        return incoming.length === 0 ? entries : [...entries, ...incoming];
      },
    },
  );
}
