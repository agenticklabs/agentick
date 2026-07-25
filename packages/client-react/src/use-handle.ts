/**
 * `useHandle` — the ONE generic React binding over a client {@link ClientHandle}.
 *
 * A client handle IS a `useSyncExternalStore` store by construction (B2,
 * `docs/proposals/v2/client-handles.md` §3): `subscribe(cb)` takes a ZERO-ARG
 * callback and fires on change; `list()` reads the current snapshot. So the whole
 * binding is one line:
 *
 * ```ts
 * useSyncExternalStore(handle.subscribe, handle.list, handle.list);
 * ```
 *
 * `useHandle` works on ANY handle that is a {@link ClientHandle} with the
 * {@link Enumerable} read profile — `session.knobs`, `session.timeline`,
 * `session.tasks`, `session.elicitations`, `session.clientToolCalls` — AND on a
 * minted {@link FilteredView} (it structurally satisfies the same shape). The
 * handle carries its own item type, so the generic infers it: `useHandle(session
 * .knobs)` is `readonly WireKnobDescriptor[]`, no annotation.
 *
 * There is deliberately NO `useKnobs`/`useTimeline`/`useElicitations`: each would
 * be this exact one line with the item type already inferred from the handle, so
 * a named alias adds no typing value — only a second way to spell the same call
 * (`docs/proposals/v2/client-handles.md` §7b). `useHandle(session.timeline)` IS
 * the timeline hook.
 *
 * ## Referential stability (the `useSyncExternalStore` requirement)
 *
 * `getSnapshot` MUST return a referentially STABLE value between changes or React
 * re-renders in a loop. Every bundled handle guarantees this: its `list()` reads
 * a folded snapshot held in a `liveStore` / `channelView`, re-materialized only
 * when a frame actually folds in (see `knobsHandle` / `tasksHandle` / the
 * timeline window — each documents "ref-stable per frame"). `useHandle` relies on
 * that contract rather than re-caching, so a handle that violates it surfaces as
 * a render loop the {@link file://./__tests__/use-handle.spec.tsx render-count
 * test} catches — the binding does not paper over a broken store.
 *
 * @verifiedBy packages/client-react/src/__tests__/use-handle.spec.tsx
 * @verifiedBy packages/client-react/src/__tests__/integration-with-handle.spec.tsx
 */

import { useSyncExternalStore } from "react";

import type { ClientHandle, Enumerable } from "@agentick/client-core";

/**
 * Subscribe a component to a client handle's enumerable state. Returns the
 * handle's current `list()` snapshot and re-renders on every change.
 *
 * @param handle any {@link ClientHandle} that exposes the {@link Enumerable}
 *   read profile (or a minted {@link FilteredView}, which satisfies the same
 *   shape). The item type `T` is inferred from the handle.
 * @returns the current snapshot — `readonly T[]`, referentially stable between
 *   changes (the handle's own guarantee; the third `getServerSnapshot` argument
 *   reuses `list` so SSR renders the same snapshot without a client-only path).
 */
export function useHandle<T>(handle: ClientHandle & Enumerable<T>): readonly T[] {
  return useSyncExternalStore(handle.subscribe, handle.list, handle.list);
}
