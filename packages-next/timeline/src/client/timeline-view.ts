/**
 * `timelineView` — the client-side reactive WINDOW over a session's timeline.
 *
 * The client timeline is `fold(session event stream)` — NOT a bespoke channel,
 * NOT a read RPC. Every `timeline.append(...)` runs through the harness command
 * path (ADR 51) and emits a `timeline:command:append` lifecycle whose
 * `requested`-phase envelope carries the appended entries as `envelope.payload`
 * ({@link TimelineAppendInput} `{ entries }`). `timelineView` selects exactly
 * those envelopes (via `timelineEventQuery()`) and folds their entries onto a
 * growing `readonly TimelineEntry[]`.
 *
 * On top of that live fold it exposes a MUTABLE WINDOW — two imperative splices
 * the adopter drives:
 *   - `prepend(entries)` — scroll-back: OLDER history spliced at the HEAD (the
 *     adopter loads it from `LogStore.history` backward). Pure window expansion
 *     over server-authoritative data.
 *   - `append(entries)` — an optimistic/pending message (or a manual insert)
 *     spliced at the TAIL, before the server echoes it back through the fold.
 *
 * ## Minimal splice — NO seq-merge (locked design)
 *
 * The window is a DUMB splice, not a compiler. Live append events carry a bus
 * `Cursor`; durable history reads carry the timeline `seq` — two numbering
 * systems, so a single-key merge would need a server change. Not worth it: the
 * ecosystem (AI-SDK, assistant-ui) reconciles at the app level, and so does an
 * agentick adopter. There is deliberately NO framework-level dedup: when an
 * optimistic `append` is later echoed by the server (folded in via the live
 * tail), reconciling the duplicate is the APP's job — it holds the client
 * temp-id. That id survives onto the folded entry: `send({ messages: [{
 * metadata: { clientId } }] })` lands on the timeline entry's
 * `message.metadata.clientId`, so the app can match its optimistic copy against
 * the echo and drop it. The framework gives you the live view + the two splices;
 * the app owns the cache and the reconciliation (the no-client-cache bright
 * line, ADR 33).
 *
 * @verifiedBy packages-next/timeline/src/client/__tests__/timeline-view.spec.ts
 */

import { eventStream, liveStore } from "@agentick/client-core-next";
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
   * Optional visibility filter — return `true` to keep an entry. Applied to the
   * live fold AND to `prepend`/`append` so the window stays consistent. Default:
   * surface all (`model` / `observer` / `log`).
   */
  readonly visibility?: (entry: TimelineEntry) => boolean;
}

/**
 * A live WINDOW over a session's timeline: a {@link ChannelView} of the folded
 * `readonly TimelineEntry[]` plus two imperative splices. Assignable to
 * `ChannelView` (so `useSyncExternalStore(view.subscribe, view.get)` and every
 * existing consumer keep working) with the window seams added on top.
 */
export interface TimelineView extends ChannelView<readonly TimelineEntry[], TimelineAppendInput> {
  /**
   * Scroll-back: splice OLDER `entries` at the HEAD of the window (view-window
   * expansion over server-authoritative history the adopter loaded). Copy-on-
   * write — a new array ref, so the `useSyncExternalStore` contract fires. An
   * empty (or fully visibility-filtered) batch is a no-op: same ref, no notify.
   */
  prepend(entries: readonly TimelineEntry[]): void;
  /**
   * Optimistic overlay / manual insert: splice `entries` at the TAIL — a pending
   * message shown before the server echoes it, or a manual insert. Copy-on-
   * write; an empty/all-filtered batch is a no-op. NO dedup against the eventual
   * server echo — the app reconciles via `message.metadata.clientId` (see the
   * module doc).
   */
  append(entries: readonly TimelineEntry[]): void;
  /**
   * Reset the window to empty (a LOCAL view reset — §5b trivial gap). Notifies
   * the STATE feed once with the empty array; the live fold keeps tailing, so a
   * subsequent server append re-grows the window from empty. Does NOT touch the
   * server (nothing is deleted) — it clears only this client's held window.
   */
  clear(): void;
}

/**
 * Open a live window on `session`'s timeline. Seeds from `options.initial`, then
 * folds every `timeline:command:append` requested-phase envelope's entries onto
 * the TAIL (copy-on-write). `prepend` splices older history at the head;
 * `append` splices optimistic/manual entries at the tail. The change feed
 * (`onChange`) delivers each raw {@link TimelineAppendInput} the LIVE fold sees
 * — imperative `prepend`/`append` notify the STATE feed only.
 */
export function timelineView(
  client: TimelineClient,
  sessionId: string,
  options?: TimelineViewOptions,
): TimelineView {
  const scope: SubscriptionScope = { kind: "session", id: sessionId };
  const visibility = options?.visibility;
  const keep = (entries: readonly TimelineEntry[]): readonly TimelineEntry[] =>
    visibility ? entries.filter(visibility) : entries;

  const stream = eventStream<TimelineAppendInput>(
    client,
    scope,
    timelineEventQuery(),
    options?.fromCursor,
  );
  // The fan-out core owns the held window + the useSyncExternalStore contract;
  // `close()` tears the subscription down.
  const store = liveStore<readonly TimelineEntry[], TimelineAppendInput>(
    options?.initial ?? [],
    () => stream.close(),
  );

  // Live tail — fold each append's (visibility-filtered) entries onto the TAIL.
  void (async () => {
    for await (const append of stream) {
      if (store.closed) return;
      const incoming = keep(append.entries);
      // Copy-on-write only when the fold actually grows — an all-filtered batch
      // keeps the same reference (no spurious re-render, no frame notify).
      if (incoming.length === 0) continue;
      store.set([...store.get(), ...incoming], append);
    }
  })();

  return {
    get: () => store.get(),
    subscribe: (listener) => store.subscribe(listener),
    onChange: (listener) => store.onChange(listener),
    get status() {
      return store.status;
    },
    close: () => store.close(),
    prepend(entries: readonly TimelineEntry[]): void {
      const incoming = keep(entries);
      if (incoming.length === 0) return; // no-op: same ref, no notify
      store.set([...incoming, ...store.get()]); // HEAD (older); STATE feed only
    },
    append(entries: readonly TimelineEntry[]): void {
      const incoming = keep(entries);
      if (incoming.length === 0) return; // no-op: same ref, no notify
      store.set([...store.get(), ...incoming]); // TAIL (optimistic); STATE feed only
    },
    clear(): void {
      store.set([]); // reset the held window; STATE feed only, live fold untouched
    },
  };
}
