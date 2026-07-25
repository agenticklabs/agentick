/**
 * `filteredView` — the VIEW FACTORY's fan-out primitive (B2 slice 4). A handle IS
 * its memoized default view (`list`/`get`/`subscribe`); `handle.view(opts)` mints
 * ADDITIONAL concurrent views. Every minted view is a filtered PROJECTION over the
 * default view's state and shares the default view's ONE wire subscription — there
 * is never a second `transport.subscribe` per topic, however many views are minted
 * (the liveStore fan-out).
 *
 * A minted view re-derives its projection from the source on every source change,
 * so it reflects everything the default view sees — the live fold AND the local
 * window ops (`prepend`/`append`/`seed`/`clear`) — filtered. It closes
 * INDEPENDENTLY (detaches its listener; the source keeps running for other views);
 * closing the source (the handle) is what tears the subscription down for all.
 *
 * Opts this slice: `filter` only (window options ride the handle's own verbs).
 * Bring-your-own `{ initial, reduce }` is deferred until a third real consumer
 * (the guide's Open section — the two-ways-to-do-it smell).
 *
 * @see docs/proposals/v2/guide-wire-and-client.md §2
 * @see docs/proposals/v2/client-handles.md §"SLICE-4 SPEC v2"
 * @verifiedBy packages/client-core/src/__tests__/view-source.spec.ts
 */

import type { Unsubscribe } from "@agentick/spec";

/** The read surface a minted view exposes — the store contract + `get`/`close`. */
export interface FilteredView<T> {
  /** The projected (filtered) list — a bounded snapshot of the source's state. */
  list(): readonly T[];
  /** Look one projected item up by id (`undefined` when absent / no id fn). */
  get(id: string): T | undefined;
  /** Store contract: fire on change (cb takes NO args — read via `list()`). */
  subscribe(cb: () => void): Unsubscribe;
  /** Detach this view. Does NOT close the shared source (other views survive). */
  close(): void;
}

/**
 * The default view a {@link filteredView} projects over: the handle's own current
 * `list()` + its zero-arg change `subscribe`. Both read the ONE shared
 * subscription, so a projection adds a listener, never a subscription.
 */
export interface CollectionViewSource<T> {
  list(): readonly T[];
  subscribe(cb: () => void): Unsubscribe;
}

/** Options for a minted view — `filter` only this slice (window ops ride the handle). */
export interface FilteredViewOptions<T> {
  /** Keep predicate applied to the source list; omit → mirror the source. */
  readonly filter?: (item: T) => boolean;
}

/**
 * Mint a filtered view over `source`. The projection is re-derived on every source
 * change and fanned out to this view's own listeners; the source subscription is
 * shared, never duplicated.
 */
export function filteredView<T>(
  source: CollectionViewSource<T>,
  opts: FilteredViewOptions<T> = {},
  idOf?: (item: T) => string | undefined,
): FilteredView<T> {
  const { filter } = opts;
  const listeners = new Set<() => void>();
  let closed = false;

  // Memoized projection: the store contract requires `list()` to be
  // referentially STABLE between changes (a fresh array per call render-loops a
  // `useSyncExternalStore` consumer — the same guarantee every bundled handle
  // makes). Recompute lazily and cache; invalidate on the next source change.
  let cache: readonly T[] | undefined;
  const project = (): readonly T[] => {
    if (cache === undefined) cache = filter ? source.list().filter(filter) : source.list();
    return cache;
  };

  // ONE listener on the shared source, fanned out to this view's listeners.
  let sourceUnsub: Unsubscribe | undefined = source.subscribe(() => {
    cache = undefined; // invalidate — the next `list()` re-projects a new ref
    for (const l of [...listeners]) {
      try {
        l();
      } catch {
        /* isolate listener faults — one bad reaction can't stop delivery */
      }
    }
  });

  return {
    list: () => project(),
    get: (id) => (idOf ? project().find((item) => idOf(item) === id) : undefined),
    subscribe(cb: () => void): Unsubscribe {
      if (closed) return () => {};
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      sourceUnsub?.();
      sourceUnsub = undefined;
      listeners.clear();
    },
  };
}
