# @agentick/client-react

React bindings for the agentick **wire client**. The client is headless-first —
every session sub-handle (`session.knobs`, `session.timeline`, `session.tasks`,
…) is a `useSyncExternalStore` store _by construction_: `subscribe(cb)` takes a
zero-arg callback and fires on change, `list()` reads the current snapshot
([`client-handles.md`](../../docs/proposals/v2/client-handles.md) §3). So the
React surface is **two one-liners**, not a hook per handle.

> **Not the JSX surface.** This is the BROWSER binding for the wire client.
> `@agentick/compiler-react` (`BridgeProvider` / `useBridges`) is the
> SERVER-side JSX→IR surface. Different React, opposite direction — don't
> confuse them.

## Install

```bash
npm install @agentick/client-react @agentick/client react
```

`react` (>=18) is a **peer** dependency — `useSyncExternalStore` ships in React
18. No `react-dom` dependency: these are hooks, not components.

## API

### `useHandle(handle) → readonly T[]`

Subscribe a component to any handle's enumerable state. Works on ANY
`ClientHandle` with the `Enumerable` read profile — and on a minted
`FilteredView` (same structural store contract). The handle carries its own item
type, so `T` is inferred; no annotation.

```tsx
import { useHandle } from "@agentick/client-react";

function Knobs({ session }) {
  const knobs = useHandle(session.knobs); // readonly WireKnobDescriptor[]
  return <ul>{knobs.map((k) => <li key={k.id}>{k.id}: {String(k.value)}</li>)}</ul>;
}

function Timeline({ session }) {
  const entries = useHandle(session.timeline); // readonly TimelineEntry[]
  return <Messages entries={entries} />;
}
```

It is literally:

```ts
export function useHandle<T>(handle: ClientHandle & Enumerable<T>): readonly T[] {
  return useSyncExternalStore(handle.subscribe, handle.list, handle.list);
}
```

### `useView(handle, opts?, deps?) → readonly T[]`

For a handle that mints additional concurrent **views** (`session.timeline`
today): `useView` mints `handle.view(opts)`, subscribes to it, and **closes it on
unmount or dep change**. The minted view is a filtered projection over the
handle's ONE wire subscription — many views, one subscription (the `filteredView`
fan-out). Type-constrained to view-capable handles: a handle without `.view`
(knobs, tasks) is a compile error here — read those with `useHandle`.

```tsx
import { useView } from "@agentick/client-react";

function ModelTimeline({ session }) {
  // A second concurrent projection — the full window stays live elsewhere.
  const modelOnly = useView(session.timeline, { filter: (e) => e.visibility === "model" });
  return <Messages entries={modelOnly} />;
}
```

`opts` is read when the view is **minted**. To re-mint with new options (a
changed filter), pass a `deps` array whose change signals it — the `useMemo` /
`useEffect` contract. A stable `opts`/`deps` keeps the one view (no re-subscribe
churn).

## Why no `useKnobs` / `useTimeline` / `useElicitations`

Because each would be _this exact line_ with the item type already inferred from
the handle:

```tsx
const entries = useHandle(session.timeline); // vs. a hypothetical useTimeline(session)
```

A named alias adds **no typing value** over the generic — `useHandle(session
.timeline)` is already `readonly TimelineEntry[]`. It would only add a second way
to spell the same call ([`client-handles.md`](../../docs/proposals/v2/client-handles.md)
§7b). `useHandle(session.knobs)` **is** the knobs hook. Ship the primitive, not
the veneer over the veneer.

## Referential stability (the one requirement)

`useSyncExternalStore` requires `getSnapshot` (`handle.list`) to return a
referentially **stable** value between changes, or React re-renders in a loop.
Every bundled handle guarantees this — its `list()` reads a folded snapshot held
in a `liveStore` / `channelView`, re-materialized only when a frame actually
folds in. `useHandle` **relies on** that contract rather than re-caching, so a
handle that violates it surfaces as a render loop the tests catch — the binding
does not paper over a broken store.

> A related fix landed in `@agentick/client-core` as part of this slice:
> `filteredView.list()` now **memoizes** its projection (it previously returned a
> fresh filtered array per call, which would have looped `useView`). See
> `view-source.ts`.

## Verified by

| Claim | Test |
| --- | --- |
| `useHandle` renders the snapshot and re-renders on change | `src/__tests__/use-handle.spec.tsx` |
| No render loop when `list()` is ref-stable (render-count bound) | `src/__tests__/use-handle.spec.tsx` |
| A ref-unstable handle surfaces (throws) rather than being silently masked | `src/__tests__/use-handle.spec.tsx` |
| SSR `getServerSnapshot` path renders without throwing | `src/__tests__/use-handle.spec.tsx` |
| `useHandle` binds a minted `FilteredView` | `src/__tests__/use-handle.spec.tsx` |
| `useView` renders the filtered projection + re-renders on source change | `src/__tests__/use-view.spec.tsx` |
| `useView` closes the view on unmount | `src/__tests__/use-view.spec.tsx` |
| `useView` re-mints (closing the old view) on dep change | `src/__tests__/use-view.spec.tsx` |
| `useView` keeps the same view across re-renders with unchanged deps | `src/__tests__/use-view.spec.tsx` |
| `useHandle` drives the REAL `tasksHandle` end-to-end (fold → render, no loop) | `src/__tests__/integration-with-handle.spec.tsx` |
| `filteredView.list()` is referentially stable between changes | `@agentick/client-core` `src/__tests__/view-source.spec.ts` |

## Roadmap & known gaps

- **`useSend` (rAF-batched)** — friction #7 in `client-handles.md` §7b — not in
  this slice. Add when the send ergonomics settle.
- **`get`-by-id reactivity** — `useHandle` returns the reactive `list()`; a
  reactive single-item hook (`useItem(handle, id)`) is not shipped. Call
  `handle.get(id)` (non-reactive) or derive from the list. Add if a real
  consumer needs it (three-consumers rule).
- **StrictMode double-mount** — `useView` mints in `useMemo` and closes in the
  effect cleanup keyed to the view; this is correct for normal mount/unmount and
  dep change. Under React StrictMode's dev-only double-invoke a discarded memo
  can transiently retain a listener on the parent handle until the handle closes
  (bounded, dev-only, swept at handle close). Not addressed here to keep the
  binding thin; revisit if it bites a real app.
```
