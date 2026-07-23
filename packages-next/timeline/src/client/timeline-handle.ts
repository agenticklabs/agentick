/**
 * `timelineHandle` — the client-side timeline resource handle, on the unified
 * `ClientHandle` contract (B2 slice 3, `docs/proposals/v2/client-handles.md`).
 * The re-home of the free {@link timelineView} factory as the `session.timeline`
 * sub-handle (ADR 87) — the factory stays exported as the IMPL; this is the
 * blessed path over it.
 *
 * The timeline handle is nouns + verbs over one session's conversation window:
 *   - CORE — `subscribe(cb)` (the zero-arg store contract) + `close()`.
 *   - {@link Enumerable} — `list()` is the current window (`readonly
 *     TimelineEntry[]`), `get(id)` looks a message entry up by `message.id`.
 *   - WINDOW verbs (LOCAL view mutations — no visual distinction from wire
 *     verbs, Q2 RESOLVED): `seed` (replace the window — the hydration line),
 *     `prepend` (older history at the HEAD), `append` (optimistic/manual at the
 *     TAIL), `clear` (reset to empty).
 *   - READ RPC — `loadOlder(limit?)` over `session/timeline_history` (§6.3): a
 *     lazy, cursored page of durable history, spliced at the HEAD.
 *
 * ## Two postures (both first-class — §5b)
 *
 * - **Posture A — the handle IS your state**: bind a UI directly to
 *   `list()`/`subscribe()`; the quick-app path.
 * - **Posture B — the handle FEEDS your state**: the handle is a typed
 *   subscription into YOUR message model —
 *   `subscribe(() => myStore.ingest(handle.list().map(toMyMessage)))`. Our window
 *   is optional; your shape is the truth (the no-client-cache bright line).
 *
 * ## Cursor-vs-seq (friction #3 — honest, NOT unified)
 *
 * `loadOlder` reads `session/timeline_history` FORWARD-cursored by `seq` (the
 * `LogStore` ordering identity), while the live tail folds bus-`Cursor`-ordered
 * append events — two numbering systems this arc deliberately does not merge. So
 * `loadOlder` pages forward from the log's start and prepends each page; an app
 * doing true infinite-scroll-up reconciles final ordering itself (it holds the
 * `message.metadata.clientId`). The framework gives the window + the splices +
 * the paged read; the app owns the cache and the reconciliation.
 *
 * @verifiedBy packages-next/timeline/src/client/__tests__/timeline-handle.spec.ts
 * @verifiedBy packages-next/timeline/src/client/__tests__/timeline-handle.conformance.spec.ts
 */

import { type ClientHandle, type Enumerable } from "@agentick/client-core-next";
import type {
  ClientTransport,
  SessionTimelineHistoryResult,
  TimelineEntry,
  Unsubscribe,
} from "@agentick/spec-next";

import { timelineView, type TimelineViewOptions } from "./timeline-view.js";

/**
 * Command client for the timeline handle: the read (`subscribe`) surface the
 * window folds PLUS `request` for the `loadOlder` history read. A superset of
 * {@link import("./timeline-view.js").TimelineClient}.
 */
export interface TimelineCommandClient {
  readonly transport: Pick<ClientTransport, "subscribe" | "request">;
}

/** The page `loadOlder` spliced, plus whether the log head has been reached. */
export interface LoadOlderResult {
  /** The older entries just read (and prepended). Empty when nothing remained. */
  readonly entries: readonly TimelineEntry[];
  /** `true` once the read reached the tail of the durable log (no more pages). */
  readonly done: boolean;
}

/**
 * The timeline resource handle: the {@link Enumerable} window (`list`/`get`) +
 * the store-contract `subscribe` + the window verbs + the `loadOlder` read.
 * A plain structural shape (floors, not ceilings) — it MAY carry more.
 */
export interface TimelineHandle extends ClientHandle, Enumerable<TimelineEntry> {
  /** The current window as a bounded snapshot (ref-stable between changes). */
  list(): readonly TimelineEntry[];
  /** Look a MESSAGE entry up by `message.id`; `undefined` when absent. */
  get(id: string): TimelineEntry | undefined;
  /** Replace the window with `entries` (server-hydrated history — the seed line). */
  seed(entries: readonly TimelineEntry[]): void;
  /** Splice OLDER `entries` at the HEAD (scroll-back over history you loaded). */
  prepend(entries: readonly TimelineEntry[]): void;
  /** Splice `entries` at the TAIL (optimistic overlay / manual insert). */
  append(entries: readonly TimelineEntry[]): void;
  /** Reset the window to empty (local view reset; the live fold keeps tailing). */
  clear(): void;
  /**
   * Read the next cursored page of durable history over `session/timeline_history`
   * and splice it at the HEAD. Tracks its own `nextFromSeq` cursor across calls;
   * resolves `{ entries, done }`. A no-op once `done`.
   */
  loadOlder(limit?: number): Promise<LoadOlderResult>;
  /** Tear down the underlying timeline subscription. */
  close(): void;
}

const idOf = (entry: TimelineEntry): string | undefined =>
  entry.kind === "message" ? entry.message.id : undefined;

/**
 * Open a live timeline handle over `session`. Seeds from `options.initial`, tails
 * live, and lazily pages durable history via `loadOlder`.
 */
export function timelineHandle(
  client: TimelineCommandClient,
  sessionId: string,
  options?: TimelineViewOptions,
): TimelineHandle {
  const view = timelineView(client, sessionId, options);

  // The history read cursor — advances with each `loadOlder`; `done` latches
  // once a page returns no `nextFromSeq` (the log tail).
  let fromSeq: number | undefined;
  let done = false;

  return {
    list: () => view.get(),
    get: (id) => view.get().find((e) => idOf(e) === id),
    // The store contract: fire on change, hand the callback NO arguments.
    subscribe: (cb: () => void): Unsubscribe => view.subscribe(() => cb()),
    close: () => view.close(),
    seed: (entries) => {
      view.clear();
      view.append(entries);
    },
    prepend: (entries) => view.prepend(entries),
    append: (entries) => view.append(entries),
    clear: () => view.clear(),
    loadOlder: async (limit) => {
      if (done) return { entries: [], done: true };
      const res = (await client.transport.request("session/timeline_history", {
        sessionId,
        ...(fromSeq !== undefined ? { fromSeq } : {}),
        ...(limit !== undefined ? { limit } : {}),
      })) as SessionTimelineHistoryResult | null;
      const page = res?.entries?.map((e) => e.entry) ?? [];
      fromSeq = res?.nextFromSeq;
      done = res?.nextFromSeq === undefined;
      if (page.length > 0) view.prepend(page);
      return { entries: page, done };
    },
  };
}
