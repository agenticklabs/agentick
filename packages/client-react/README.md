# @agentick/client-react

**The client was designed store-first, so React needs almost nothing.** Every
session sub-handle — `session.timeline`, `session.knobs`, `session.tasks`,
`session.elicitations` — already satisfies the `useSyncExternalStore` contract:
`subscribe(cb)` takes a zero-argument callback and fires on change, `list()` reads
the current snapshot.

That is the bet, and this package is the receipt for it. Two hooks, each one line
of implementation, no hook per capability and no provider to mount. A binding this
thin only works if the store contract holds all the way down — which is why the
one thing this README insists on is referential stability.

> [!IMPORTANT]
> This is the **browser** binding for the wire client.
> [@agentick/compiler-react](../compiler-react) (`BridgeProvider` / `useBridges`)
> is the **server-side** JSX→IR surface. Both are React; they point in opposite
> directions. Don't reach for one expecting the other.

## Install

```bash
npm install @agentick/client-react @agentick/client react
```

`react` (>= 18) is a **peer** dependency — `useSyncExternalStore` ships in React 18. There is no `react-dom` dependency: these are hooks, not components.

## Quick start

```tsx
import { useHandle } from "@agentick/client-react";
import type { SessionHandle } from "@agentick/spec";

export function Conversation({ session }: { session: SessionHandle }) {
  const entries = useHandle(session.timeline); // readonly TimelineEntry[]
  const knobs = useHandle(session.knobs); // readonly WireKnobDescriptor[]

  return (
    <>
      <ul>
        {entries.map((e) =>
          e.kind === "message" ? <li key={e.message.id}>{e.message.role}</li> : null,
        )}
      </ul>
      {knobs.map((k) => (
        <label key={k.id}>
          {k.id}
          <input
            value={String(k.value)}
            onChange={(ev) => void session.knobs.set(k.id, ev.target.value)}
          />
        </label>
      ))}
    </>
  );
}
```

Reads come through the hook; writes go straight to the handle's verb. There is no
dispatch layer in between, because the server is the only writer of record — a
`set` issues its wire command and the new value arrives back through the same fold
the hook is already subscribed to.

## `useHandle(handle)`

Subscribes a component to any handle's enumerable state. The handle carries its
own item type, so `T` is inferred — no annotation, no generic argument.

```tsx
const tasks = useHandle(session.tasks); // readonly TaskInfo[]
const asks = useHandle(session.elicitations); // readonly ClientElicitationHandle[]
```

It works on anything with the read core plus the `Enumerable` profile, which
includes a minted `FilteredView` — those satisfy the same shape structurally, with
no special-casing in the hook. The whole implementation is:

```ts
export function useHandle<T>(handle: ClientHandle & Enumerable<T>): readonly T[] {
  return useSyncExternalStore(handle.subscribe, handle.list, handle.list);
}
```

The third argument reuses `list`, so server rendering returns the same snapshot
without a browser-only path.

### Why there is no `useKnobs` / `useTimeline` / `useElicitations`

Each would be that exact line, with the item type already inferred from the
handle:

```tsx
const entries = useHandle(session.timeline); // vs. a hypothetical useTimeline(session)
```

A named alias adds no typing value over the generic — `useHandle(session.timeline)`
is already `readonly TimelineEntry[]`. It would only add a second way to spell one
call. `useHandle(session.knobs)` **is** the knobs hook.

## `useView(handle, opts?, deps?)`

Some handles mint additional concurrent projections over their one wire
subscription — `session.timeline` today. `useView` owns that projection's React
lifecycle: it mints the view, subscribes to it, and closes it on unmount or when
the deps change.

```tsx
import { useView } from "@agentick/client-react";

function ModelContext({ session }: { session: SessionHandle }) {
  // A second projection. The full window stays live for whoever else reads it;
  // both share ONE subscription.
  const modelOnly = useView(session.timeline, { filter: (e) => e.visibility === "model" });
  return <Transcript entries={modelOnly} />;
}
```

`opts` is captured when the view is **minted**. To re-mint with new options — a
filter that depends on props or state — pass a `deps` array, the same contract as
`useMemo` and `useEffect`:

```tsx
function ByVisibility({ session, only }: { session: SessionHandle; only: "model" | "observer" }) {
  const entries = useView(session.timeline, { filter: (e) => e.visibility === only }, [only]);
  return <Transcript entries={entries} />;
}
```

Unchanged deps keep the one view across re-renders — no re-subscribe churn, even
if you pass a fresh `opts` object every render. A dep change closes the previous
view before subscribing the next.

`useView` is type-constrained to handles that actually have `.view`. Passing
`session.knobs` is a compile error rather than a faked projection — read those
with `useHandle`.

## Referential stability is the contract

`useSyncExternalStore` requires `getSnapshot` to return a **referentially stable**
value between changes. A `list()` that builds a fresh array on every call makes
React re-render without bound.

Every bundled handle guarantees stability: `list()` reads a folded snapshot held
in a store that re-materializes only when a frame actually folds in. Minted views
memoize their projection for the same reason.

`useHandle` **relies on** that guarantee instead of re-caching around it. A handle
that violates it surfaces immediately — React throws rather than looping, and the
render-count tests here pin the bound. The binding does not paper over a broken
store, which is the point: if it silently re-cached, a store bug in one handle
would be invisible until it cost you in production.

If you write your own handle, certify it with `runClientHandleConformance` from
[@agentick/client-core](../client-core)`/testing` before binding it here.

## API

| Export                   | Signature                                                                  |
| ------------------------ | -------------------------------------------------------------------------- |
| `useHandle`              | `<T>(handle: ClientHandle & Enumerable<T>) => readonly T[]`                |
| `useView`                | `<T, O>(handle: ViewCapableHandle<T, O>, opts?: O, deps?) => readonly T[]` |
| `ViewCapableHandle<T,O>` | Type: `{ view(opts?: O): FilteredView<T> }` — what `useView` accepts       |

## Patterns

**One handle, many components.** Subscribing twice costs one subscription — the
handle fans out to its listeners, so sibling components can each `useHandle` the
same handle without opening a second feed.

```tsx
function App({ session }: { session: SessionHandle }) {
  return (
    <>
      <Conversation session={session} /> {/* useHandle(session.timeline) */}
      <UnreadBadge session={session} /> {/* useHandle(session.timeline) again */}
    </>
  );
}
```

**Filter in a view, not in render.** `useView` projects once per source change and
memoizes; filtering inside a component body re-runs on every render and produces a
new array each time.

```tsx
const shown = useView(session.timeline, { filter: (e) => e.visibility === "model" }); // yes
const shown2 = useHandle(session.timeline).filter((e) => e.visibility === "model"); // works, recomputes
```

**Bring your own store.** The handles are framework-agnostic; nothing here is
required. If your app already has a message model, subscribe directly and feed it
— `session.timeline.subscribe(() => myStore.ingest(session.timeline.list()))` —
and skip this package entirely. The framework owns no client cache, so nothing
fights you for it.

## Roadmap & known gaps

- **No single-item hook.** `useHandle` returns the reactive list. A reactive
  `useItem(handle, id)` isn't shipped — call `handle.get(id)` (non-reactive) or
  derive from the list. It lands when several real consumers want it.
- **No `useSend`.** Driving an execution's event stream into React state — with
  the frame batching a token stream needs — is yours to write today. The
  ergonomics haven't settled enough to bless one shape.
- **StrictMode double-mount.** `useView` mints in `useMemo` and closes in the
  effect cleanup keyed to the view. That is correct for normal mount, unmount, and
  dep change. Under React StrictMode's development-only double-invoke, a discarded
  memo can transiently retain a listener on the parent handle until the handle
  closes — bounded, development-only, and swept at handle close. Not addressed
  here to keep the binding thin.
- **`useView` has one real consumer.** `session.timeline` is the only bundled
  handle that mints views, so the hook's options type is exercised against exactly
  one shape.

## Verified by

- `src/__tests__/use-handle.spec.tsx` — renders the current snapshot and
  re-renders on change; a stable `list()` produces exactly one render per change
  (the render-count bound the whole design hinges on); a handle that violates
  ref-stability throws rather than being masked; the `getServerSnapshot` path
  renders under `renderToStaticMarkup`; a minted `FilteredView` binds with no
  special-casing.
- `src/__tests__/use-view.spec.tsx` — renders the minted projection and re-renders
  on source change; no render loop; closes the view on unmount; re-mints and
  closes the previous view on dep change; keeps the same view across re-renders
  with unchanged deps.
- `src/__tests__/integration-with-handle.spec.tsx` — `useHandle` driving the real
  `tasksHandle` over a spy transport: mount, receive a snapshot frame, re-render
  with the folded state, with the render count still bounded.
- [@agentick/client-core](../client-core) `src/__tests__/view-source.spec.ts` —
  `filteredView.list()` is referentially stable between changes, which is what
  keeps `useView` from looping.
