/**
 * `useView` — the React binding for a handle's VIEW FACTORY (B2 slice 4).
 *
 * A view-capable handle (`session.timeline` today) mints ADDITIONAL concurrent
 * {@link FilteredView}s over its ONE wire subscription — each with its own filter
 * — via `handle.view(opts)` (`docs/proposals/v2/client-handles.md` §"SLICE-4
 * SPEC v2"). `useView` owns that view's React lifecycle: it mints the view once
 * for a dep-set, subscribes to it via `useSyncExternalStore`, and CLOSES it on
 * unmount or when the deps change (the shared subscription survives for the
 * handle; only this projection is torn down — the `filteredView` fan-out).
 *
 * `opts` is read when the view is MINTED. To re-mint with new options (a changed
 * filter), pass a `deps` array whose change signals the new options — the same
 * contract as `useMemo`/`useEffect`. A stable `opts` object across renders (or a
 * stable `deps`) keeps the one view; there is no re-subscribe churn.
 *
 * `useView` is type-constrained to {@link ViewCapableHandle} — a handle WITHOUT
 * `.view` (knobs, tasks) is a compile error here, not a faked view. Read those
 * directly with `useHandle`.
 *
 * @verifiedBy packages-next/client-react/src/__tests__/use-view.spec.tsx
 */

import { useEffect, useMemo, useSyncExternalStore, type DependencyList } from "react";

import type { FilteredView } from "@agentick/client-core-next";

/**
 * A handle that can mint additional concurrent views over its shared
 * subscription — the surface `useView` binds to. `T` is the item type, `O` the
 * handle's own view-options type (e.g. the timeline's `{ filter? }`). Both are
 * inferred from the handle passed to {@link useView}.
 */
export interface ViewCapableHandle<T, O = unknown> {
  /** Mint an additional {@link FilteredView} over this handle's shared feed. */
  view(opts?: O): FilteredView<T>;
}

/**
 * Mint, subscribe to, and lifecycle-manage a {@link FilteredView} over a
 * view-capable handle. Returns the view's current `list()` snapshot and
 * re-renders on change; closes the view on unmount or dep change.
 *
 * @param handle a {@link ViewCapableHandle} (e.g. `session.timeline`).
 * @param opts the view options, read when the view is minted (re-mint via `deps`).
 * @param deps dependency list that re-mints the view when it changes (default `[]`).
 * @returns the minted view's current snapshot — `readonly T[]`.
 */
export function useView<T, O>(
  handle: ViewCapableHandle<T, O>,
  opts?: O,
  deps: DependencyList = [],
): readonly T[] {
  // Mint once per dep-set. `opts` is captured at mint time; the caller drives
  // re-minting through `deps` (the useMemo/useEffect contract), so a fresh `opts`
  // object with unchanged `deps` intentionally keeps the existing view.
  const view = useMemo(() => handle.view(opts), [handle, ...deps]);
  // Close the view when it is superseded (deps changed → new view) or the
  // component unmounts. Keyed to `view`, so the previous view's cleanup closes it
  // before the next one is subscribed.
  useEffect(() => () => view.close(), [view]);
  return useSyncExternalStore(view.subscribe, view.list, view.list);
}
