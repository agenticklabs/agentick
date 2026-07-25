/**
 * Timeline client WINDOW — the full arc, end to end.
 *
 * This module is the worked example for `timelineView`'s mutable window:
 * server-side hydration → client seed + live tail → scroll-back (`prepend`) →
 * optimistic send (`append`) + app-owned reconciliation. It is a TYPED, isolated
 * reference — it typechecks against the real APIs (`tsc --noEmit` covers it) but
 * is not wired into `index.ts`; read it top-to-bottom as the canonical recipe.
 *
 * The bright line (ADR 33): the FRAMEWORK gives you a live view of the timeline
 * plus two splices (`prepend` for older history, `append` for optimistic tails).
 * The APP owns the cache and the reconciliation — there is deliberately no
 * client-side sync engine, no seq-merge, no dedup. Where the app reconciles an
 * optimistic message against its eventual server echo is shown below.
 */

import type { Client } from "@agentick/client";
import { timelineView, type TimelineView } from "@agentick/timeline/client";
import type { Cursor, StoreCtx, TimelineEntry, TimelineStore } from "@agentick/spec";

// ============================================================================
// 1. SERVER SIDE — hydrate recent history from the durable log
// ============================================================================
//
// The AI-SDK `initialMessages` equivalent. A `TimelineStore` is the durable
// LOG archetype (`TimelineStore extends LogStore<TimelineEntry>`, keyed by
// `sessionId`); its optional `history(...)` is the seq-cursored read. The
// harness captures `StoreCtx` at the op boundary and threads it as the final
// arg — here we take it as a parameter (this snippet is a server handler body).

/** What the server hands the client to boot a window: the seed + a live-tail resume point. */
export interface HydratedTimeline {
  /** Server-authoritative history, oldest → newest, to seed the fold. */
  readonly entries: readonly TimelineEntry[];
  /**
   * The oldest `seq` in `entries` — the paging cursor the client feeds back to
   * `loadOlder` for scroll-back. `undefined` when the log is empty.
   */
  readonly oldestSeq?: number;
  /**
   * Live-tail resume point for `timelineView({ fromCursor })`. NOTE the locked
   * design: bus `Cursor` and store `seq` are TWO numbering systems, so this is
   * NOT derived from `seq`. A server co-locating the event bus with the store
   * captures the live bus position at hydration time and returns it here; this
   * store-only path cannot, so it stays `undefined` → the client tails from now
   * and the app reconciles the small overlap (see §4).
   */
  readonly cursor?: Cursor;
}

/** Load the most recent `limit` entries to seed the client window. */
export async function loadRecent(
  store: TimelineStore,
  sessionId: string,
  ctx: StoreCtx,
  limit = 50,
): Promise<HydratedTimeline> {
  // `history` is optional on `LogStore`; a store that omits it degrades to the
  // full `read`. We assume the durable store implements it (Postgres/JSONL do).
  const tagged = await store.history?.(sessionId, { limit }, ctx);
  if (!tagged || tagged.length === 0) return { entries: [] };
  return {
    entries: tagged.map((t) => t.entry),
    oldestSeq: tagged[0]!.seq,
    // cursor stays undefined here — see the field doc above.
  };
}

/**
 * Scroll-back page: entries strictly OLDER than `beforeSeq`. `history` pages
 * FORWARD from `fromSeq`, so to walk BACK we read a lower window and keep only
 * what precedes the oldest entry the client already holds.
 */
export async function loadOlder(
  store: TimelineStore,
  sessionId: string,
  ctx: StoreCtx,
  beforeSeq: number,
  limit = 50,
): Promise<readonly TimelineEntry[]> {
  const fromSeq = Math.max(1, beforeSeq - limit);
  const tagged = (await store.history?.(sessionId, { fromSeq, limit }, ctx)) ?? [];
  return tagged.filter((t) => t.seq < beforeSeq).map((t) => t.entry);
}

// ============================================================================
// 2. CLIENT SIDE — seed the window + tail live
// ============================================================================
//
// One call opens the window: seed with the server-hydrated `initial`, resume the
// live tail from `fromCursor`. The returned `TimelineView` is a `ChannelView`
// (get / subscribe / onChange / status / close) PLUS `prepend` / `append`.

export function bootstrapTimeline(
  client: Client,
  sessionId: string,
  hydrated: HydratedTimeline,
): TimelineView {
  return timelineView(client, sessionId, {
    initial: hydrated.entries, // server-hydrated seed (AI-SDK initialMessages)
    fromCursor: hydrated.cursor, // resume live tail AFTER the seed (undefined → from now)
    // Optional: hide log-only entries from the surfaced window.
    visibility: (e) => e.visibility !== "log",
  });
}

// ── React binding — the useSyncExternalStore contract ──────────────────────
//
// `view.subscribe` + `view.get` are exactly the two args `useSyncExternalStore`
// wants: React passes an `onStoreChange` (we ignore the folded value we hand it)
// and re-reads the synchronous snapshot via `get`. Any prepend/append or live
// fold triggers a re-render.
//
// Uncomment in a real React app (react is a dependency here):
//
//   import { useSyncExternalStore } from "react";
//   export function useTimeline(view: TimelineView): readonly TimelineEntry[] {
//     return useSyncExternalStore(view.subscribe, view.get);
//   }

// ── Non-React binding — a plain subscribe loop ──────────────────────────────
/** Wire the window to a render callback (framework-agnostic). Returns an unsubscribe. */
export function renderOnChange(
  view: TimelineView,
  render: (entries: readonly TimelineEntry[]) => void,
): () => void {
  render(view.get()); // initial paint
  return view.subscribe(render); // re-paint on every change (fold, prepend, append)
}

// ============================================================================
// 3. SCROLL-BACK — prepend older history at the HEAD
// ============================================================================
//
// The user scrolls up; load the previous page from the durable store and splice
// it at the head. `prepend` is pure window expansion over server-authoritative
// data — copy-on-write, so the view re-renders; an empty page is a no-op.

export async function scrollBack(
  view: TimelineView,
  store: TimelineStore,
  sessionId: string,
  ctx: StoreCtx,
  oldestLoadedSeq: number,
): Promise<void> {
  const older = await loadOlder(store, sessionId, ctx, oldestLoadedSeq);
  view.prepend(older); // HEAD — older entries now lead the window
}

// ============================================================================
// 4. OPTIMISTIC SEND — append at the TAIL, then let the app reconcile
// ============================================================================
//
// Show the user's message instantly (before the server round-trips) by splicing
// an optimistic entry at the tail. Stamp a client temp-id and pass it through
// `send`'s message metadata; it survives onto the folded entry's
// `message.metadata.clientId` when the server echoes the append back through the
// live fold. The framework does NOT dedup — reconciliation is §4b.

export function sendOptimistic(
  client: Client,
  sessionId: string,
  view: TimelineView,
  text: string,
): string {
  const clientId = `c_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  // (a) Optimistic tail — instant local echo, carrying the correlation id.
  const optimistic: TimelineEntry = {
    kind: "message",
    message: {
      id: clientId,
      role: "user",
      content: [{ type: "text", text }],
      ts: Date.now(),
      metadata: { clientId },
    },
  };
  view.append([optimistic]);

  // (b) Fire the real send. The SAME `clientId` rides `message.metadata`, so the
  // server-stored entry — when it folds back in via the live tail — carries it.
  void client.session(sessionId).send({
    messages: [{ role: "user", content: text, metadata: { clientId } }],
  });

  return clientId;
}

/**
 * §4b — APP-OWNED RECONCILIATION (the bright line).
 *
 * When the server echo folds in, the window holds BOTH copies (optimistic +
 * authoritative) — the framework ships no removal/dedup seam. The app collapses
 * them at RENDER time: entries sharing a `clientId` keep the LAST occurrence
 * (the server echo, appended later at the tail, wins). Entries with no
 * `clientId` pass through untouched. This is the entire "app owns the cache"
 * contract — a pure function over `view.get()`.
 */
export function reconcileByClientId(entries: readonly TimelineEntry[]): readonly TimelineEntry[] {
  const lastIndexByClientId = new Map<string, number>();
  entries.forEach((e, i) => {
    const clientId = e.kind === "message" ? e.message.metadata?.clientId : undefined;
    if (typeof clientId === "string") lastIndexByClientId.set(clientId, i);
  });
  return entries.filter((e, i) => {
    const clientId = e.kind === "message" ? e.message.metadata?.clientId : undefined;
    if (typeof clientId !== "string") return true; // no correlation id → always keep
    return lastIndexByClientId.get(clientId) === i; // keep only the last (the echo)
  });
}
