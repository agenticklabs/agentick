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
 *   - READ RPC — `history({ fromSeq, toSeq, limit })` over the grant-gated
 *     `timeline/history` command (ADR 93): one cursored page of durable history,
 *     seq-tagged, no view mutation. `loadOlder(limit?)` is its stateful sugar —
 *     it opens on the log's TAIL, walks BACKWARD by `toSeq`, and splices each
 *     page at the HEAD.
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
 * ## Scroll-back is TAIL-ANCHORED
 *
 * `loadOlder` is the scroll-up affordance, so it reads the way scroll-up moves:
 * the first call takes the log's LAST `limit` entries (a bare `limit` is the
 * port's tail read), and each later call carries the previous page's `nextToSeq`
 * to take the `limit` entries BELOW it. Every page prepends at the HEAD, so page
 * two lands above page one and the window accumulates in log order without the
 * app holding a mirrored copy or re-seeding.
 *
 * ## Cursor-vs-seq (friction #3 — honest, NOT unified)
 *
 * Durable history is ordered by `seq` (the `LogStore` ordering identity) while
 * the live tail folds bus-`Cursor`-ordered append events — two numbering systems
 * this arc deliberately does not merge. Scroll-back grows the head and the fold
 * appends at the tail, so the two never fight; an app that needs an exact
 * interleaving at the seam reconciles it itself (it holds the
 * `message.metadata.clientId`). The framework gives the window + the splices +
 * the paged read; the app owns the cache and the reconciliation.
 *
 * @verifiedBy packages/timeline/src/client/__tests__/timeline-handle.spec.ts
 * @verifiedBy packages/timeline/src/client/__tests__/timeline-handle.conformance.spec.ts
 * @verifiedBy packages/transport-in-process/src/__tests__/timeline-history-e2e.spec.ts
 */

import {
  filteredView,
  type ClientHandle,
  type Enumerable,
  type FilteredView,
} from "@agentick/client-core";
import type { ClientTransport, TimelineEntry, Unsubscribe } from "@agentick/spec";
import { omitUndefined } from "@agentick/utils";

// Types the `timeline/history` wire row for `transport.request` — type-only, so
// the client bundle pulls no harness runtime.
import type { TimelineHistoryInput, TimelineHistoryPage } from "../wire-augment.js";
import { timelineView, type TimelineViewOptions } from "./timeline-view.js";

/**
 * Command client for the timeline handle: the read (`subscribe`) surface the
 * window folds PLUS `request` for the `timeline/history` read. A superset of
 * {@link import("./timeline-view.js").TimelineClient}.
 */
export interface TimelineCommandClient {
  readonly transport: Pick<ClientTransport, "subscribe" | "request">;
}

/** Options for a minted timeline view (B2 slice 4) — `filter` only this slice. */
export interface TimelineViewOpts {
  /**
   * Keep predicate applied to the shared window — e.g.
   * `(e) => e.visibility === "model"`. Omit → mirror the full window.
   */
  readonly filter?: (entry: TimelineEntry) => boolean;
}

/** The page `loadOlder` spliced, plus whether the log head has been reached. */
export interface LoadOlderResult {
  /** The older entries just read (and prepended). Empty when nothing remained. */
  readonly entries: readonly TimelineEntry[];
  /** `true` once the read reached the HEAD of the durable log (no older pages). */
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
   * Read ONE cursored page of durable history over the grant-gated
   * `timeline/history` command — seq-tagged rows plus the cursor that continues
   * the direction you asked in (`nextFromSeq` forward, `nextToSeq` backward;
   * absent once the log runs out that way). `{ limit: n }` alone is the log's
   * LAST `n`. Stateless and view-neutral: it splices nothing, so an app whose
   * message model is the truth (Posture B) pages straight into its own store.
   *
   * Requires a grant on the `timeline:history` scope, and reads only the session
   * this handle is bound to (the same-principal target rule).
   */
  history(options?: TimelineHistoryInput): Promise<TimelineHistoryPage>;
  /**
   * Scroll-back sugar over {@link history}: read the next OLDER page and splice
   * it at the HEAD of the window. The first call reads the log's last `limit`
   * entries; each later call walks down by the previous page's `nextToSeq`.
   * Resolves `{ entries, done }`, and is a no-op once `done` (the log's head).
   * Omitting `limit` reads everything older in one page.
   */
  loadOlder(limit?: number): Promise<LoadOlderResult>;
  /**
   * Mint an ADDITIONAL concurrent view over the SAME window (B2 slice 4) — a
   * filtered projection sharing this handle's ONE wire subscription (no second
   * `subscribe`). The minted view closes independently; closing the handle closes
   * it too. Opts: `filter` only this slice (window ops stay on the handle).
   */
  view(opts?: TimelineViewOpts): FilteredView<TimelineEntry>;
  /** Tear down the underlying timeline subscription (and every minted view). */
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

  // The scroll-back cursor — walks DOWN with each `loadOlder` (the first call
  // sends no bound, which reads the log's tail); `done` latches once a page
  // returns no `nextToSeq` (the log's head).
  let toSeq: number | undefined;
  let done = false;

  // Minted views (B2 slice 4). Each is a filtered projection over the SAME
  // window (the ONE subscription); tracked so `close()` tears them all down.
  const minted = new Set<FilteredView<TimelineEntry>>();
  // The default view exposed to `filteredView` as the shared source: the handle's
  // own `list()` + zero-arg `subscribe` (both read `view`, the single stream).
  const source = {
    list: () => view.get(),
    subscribe: (cb: () => void): Unsubscribe => view.subscribe(() => cb()),
  };

  return {
    list: () => view.get(),
    get: (id) => view.get().find((e) => idOf(e) === id),
    // The store contract: fire on change, hand the callback NO arguments.
    subscribe: (cb: () => void): Unsubscribe => view.subscribe(() => cb()),
    view: (opts) => {
      const projection = filteredView(source, opts ?? {}, idOf);
      // Wrap `close` so the handle stops tracking a view that closes itself.
      const tracked: FilteredView<TimelineEntry> = {
        list: projection.list,
        get: projection.get,
        subscribe: projection.subscribe,
        close: () => {
          projection.close();
          minted.delete(tracked);
        },
      };
      minted.add(tracked);
      return tracked;
    },
    close: () => {
      for (const v of [...minted]) v.close();
      view.close();
    },
    seed: (entries) => {
      view.clear();
      view.append(entries);
    },
    prepend: (entries) => view.prepend(entries),
    append: (entries) => view.append(entries),
    clear: () => view.clear(),
    history: async (options) =>
      (await client.transport.request("timeline/history", {
        sessionId,
        ...omitUndefined({
          fromSeq: options?.fromSeq,
          toSeq: options?.toSeq,
          limit: options?.limit,
        }),
      })) ?? { entries: [] },
    loadOlder: async (limit) => {
      if (done) return { entries: [], done: true };
      // No `fromSeq`, ever: the absent lower bound is what anchors `limit` at
      // the log's tail, and `toSeq` walks that anchor down page by page.
      const res = await client.transport.request("timeline/history", {
        sessionId,
        ...omitUndefined({ toSeq, limit }),
      });
      const page = res?.entries?.map((e) => e.entry) ?? [];
      toSeq = res?.nextToSeq;
      // The head latch: no next cursor means the page reached the log's start.
      done = res?.nextToSeq === undefined;
      if (page.length > 0) view.prepend(page);
      return { entries: page, done };
    },
  };
}
