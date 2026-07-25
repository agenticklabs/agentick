# @agentick/state

`StateHarness` — **session-internal reactive key/value storage**. Arbitrary
adopter state, keyed by string, that survives re-mounts and hibernate-resume,
with per-key subscription. The v2 analog of v1's `useComState`.

The one thing to hold onto: **state is NOT model-visible.** Unlike knobs,
nothing here renders into the model's context and the `knob_set` tool does not
reach it. State is the adopter's private stash — component-local scratch, a
counter, a cached fetch result — parallel to the timeline, owned entirely by
your code.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## What it is

A store-backed key/value cell set behind the full harness contract — the
near-identical twin of knobs, minus the model-facing descriptors. Two surfaces:

- **Sync reads** — `get(key)` · `has(key)` · `list()` · `subscribe(key, fn)`
  · `subscribeAll(fn)`. Served from a synchronous read cache; no envelopes.
- **Async writes** — `set({ key, value })` · `delete({ key })`. Declared
  commands (ADR 51): each runs through `runOperation`, so the terminal
  envelope IS the change-event audit trail, and both verbs are
  inbox-addressable over the harness address (`state:set` / `state:delete`
  on `state:{scopeId}`) with no routing code.

`StateHarness extends BaseHarness<"state">`. Values are `unknown` — the
harness stores whatever you give it and does no validation. Writes fire
per-key subscribers (a delete fires the key's subscribers too), so
`useSessionState` re-renders and `session.state.subscribe(key, ...)` fires.

`exportSnapshot()` / `importSnapshot()` round-trip the entries;
`SnapshotHarness` drives them for hibernate/resume. Because values are
`unknown` and stored as-is, snapshot durability is bounded by JSON
serializability — the same rule the rest of the substrate follows.

### Store-backed (data-layer plan §3.5)

State is store-derived AND store-persisted, exactly like knobs. A durable
`Store<StateEntry>` of `{ key, value }` cells is the authority; a
synchronous `View` is its read cache, so the sync surface never
touches the async store. Every mutation **writes through** the view (sync
cache first, durable store off the critical path); `hydrate()` reloads the
store into the projection on resume. The default store is a fresh in-memory
`createStateStore()` (`:memory:`, lost on exit); inject a durable adapter via
`new StateHarness(..., { store })` or `withState({ store })` to survive restart.

The `View` internalizes both the write-through cache and the notify seams (the
per-key render pings and the typed change stream). State is session-internal with
no client-facing channel, so nothing routes the change stream to the wire; it
stays harness-level.

One state-only wrinkle vs knobs: values are `unknown`, so a `set(key, undefined)`
stores a **present** key whose value is `undefined`. Presence is a key-membership
fact (`has` → `hasSync`), never a `value !== undefined` check, all the way down
to the store cell — `undefined`-valued cells round-trip through write-through,
`hydrate()`, and export/import intact.

## Contrast with knobs

|                          | `@agentick/state`  | `@agentick/knobs`            |
| ------------------------ | ----------------------- | --------------------------------- |
| Model can read           | no                      | yes (rendered in `<Knobs />`)     |
| Model can write          | no                      | yes (`knob_set` tool)             |
| Value type               | `unknown` (arbitrary)   | `string \| number \| boolean`     |
| Descriptors / validation | none                    | type, bounds, options, `validate` |
| Purpose                  | adopter's private stash | model-facing tunable parameters   |

Reach for state when the model has no business seeing or setting the value.
Reach for knobs when it should.

## Quick start

### Programmatic

```ts
// From adopter / server-side code — no React.
await session.state.set({ key: "draftCount", value: 0 });
session.state.get("draftCount"); // 0
session.state.has("draftCount"); // true
session.state.list(); // [{ key: "draftCount", value: 0 }]

const off = session.state.subscribe("draftCount", () => rerender());
await session.state.delete({ key: "draftCount" }); // fires the subscriber
```

### React

`useSessionState` is a `useSyncExternalStore` binding over
`useBridges().state` — the same harness the programmatic surface exposes. It
seeds the initial value with a fire-and-forget `set` in `useEffect` (only when
the key is absent), subscribes to the per-key notifier, and returns
`[value, setValue]`.

```tsx
import { useSessionState } from "@agentick/state/react";

function Draft() {
  const [count, setCount] = useSessionState("draftCount", 0);
  return <Section id="draft">Revisions so far: {count}</Section>;
}
```

Because the value lives on the harness (not in a `useState` cell), it survives
an unmount → remount of the component and a hibernate → resume of the session.

## API

### `@agentick/state`

- **`StateHarness`** — `BaseHarness<"state">` impl of `StateHarnessProtocol`.
  Construct with `(scopeId, journal, bus, inbox, options?)`;
  `StateHarnessOptions.store` overrides the durable value store (defaults to a
  fresh in-memory `createStateStore()`).
  - Sync reads: `get(key)` · `has(key)` · `list()` · `subscribe(key, fn)` ·
    `subscribeAll(fn)`. `list()` returns `{ key, value }` entries (the sibling
    projection depth — knobs descriptors, skills records), not bare keys.
  - Notify seam (ADR 75): `onChange(fn)` — typed push carrying the delta
    (`ChangeEvent<unknown>`): `set` → add/update, `delete` → remove. The push
    twin of the bare `subscribe` render-ping; the source a future `state`
    snapshot+delta channel projects from.
  - Async commands: `set({ key, value })` · `delete({ key })`.
- **Wire surface (`exposure: "wire"`, deny-by-default).** All four verbs
  project onto the dynamic-command lane so a client `session.state` handle can
  read AND mutate (three-audiences-plan G-prep — state had no read command and
  its mutations were exposure-less, so nothing was wire-reachable): `state/get`
  (`{ key }` → value) · `state/list` (→ `{ key, value }` entries) · `state/set`
  · `state/delete`. The `WireMethods` rows live in a type-only `wire-augment.ts`
  split (the `export {}` guard is load-bearing) so a future client subpath types
  them without pulling server-bridge code.
  - Snapshot: `exportSnapshot()` / `importSnapshot(values)`.
  - Store: `hydrate()` reloads the durable store into the sync projection
    (resume seam; not wired into session resume — `importSnapshot` owns that).
- **`createStateStore()`** — the bundled in-memory default value store
  (`CollectionStore<StateEntry, StateStoreQuery>`); single source of the default
  store config. **Types `StateEntry`** (`{ key, value }` cell) / **`StateStoreQuery`**
  (empty — state has no scoped read).
- **`withState(options?)`** — `SessionExtension` factory.
  `WithStateOptions.initial` seeds entries at construction (via
  `importSnapshot`); `WithStateOptions.store` threads a durable store through.
  Adopters wanting a custom backend (e.g. redis-backed) pass their own
  configured `withState({ ... })`.
- **`runStateHarnessConformance({ make })`** — protocol conformance suite for
  alternative impls.
- **Type `StateHandle`** — the curated `session.state` surface (hides `id` /
  `ready` / `close` / snapshot import-export).

### `@agentick/state/react`

- **`useSessionState<T>(key, initial)`** → `readonly [T, (v: T) => void]`.

### `@agentick/state/testing`

- **`stubStateHarness(initial?)`** — a real `StateHarness` on its own
  in-memory substrate; `initial` seeds entries.

The top-level `session.state` accessor is owned by
`@agentick/session` (which augments `SessionHarnessProtocol`), not by
this package.

## Patterns

**Component-local scratch that outlives a remount.** Any value a component
would keep in `useState` but wants to preserve across unmount/remount or
hibernate/resume: `useSessionState("filters", defaultFilters)`.

**Cross-component shared state.** Two components reading the same key share
one cell — write in one, the other re-renders. No context provider needed;
the harness is the store.

**Programmatic drive from tool handlers.** A tool handler holding the session
can `session.state.set(...)` to stash a result the JSX tree then reads via
`useSessionState` — server logic and render tree meeting on one key.

## `/client` — the client-side handle (ADR 87)

`@agentick/state/client` projects `session.state` to the wire client, per
the symmetry law (a harness that ships a session handle ships the matching
client handle). Importing the subpath self-assembles `client.session(id).state`:

```ts
import { createClient } from "@agentick/client"; // bundles this subpath
const session = client.session(id);
session.state.list();               // readonly StateListEntry[] (Enumerable)
session.state.get("cursor");        // { key, value } | undefined
await session.state.set("cursor", 4);
await session.state.delete("draft");
session.subscribe(() => render());  // zero-arg store contract
```

**RPC-backed, not channel-backed.** There is no `state-state` delta channel
(state is the adopter stash, not model-visible; a reactive mirror rides the
client channel-consumer primitive later). The read side is a poll:
`list()`/`get()` read a local snapshot seeded by an eager `state/list` fetch and
re-fetched after each mutation (fire-and-refetch); `refresh()` forces a re-poll.
The verbs ride the `state/*` dynamic-lane commands. Depends only on
`@agentick/client-core` + spec types — never the server harness — so it
stays out of a browser bundle.

## Status & roadmap

Extracted per ADR 26 Step 3a, modularized per ADR 27. Green.

- **`withState()` wiring (ADR 26 Step 8) — pending.** As with knobs, the
  `SessionInstaller` path is not yet the construction site: today the
  SessionHarness constructs `StateHarness` directly in `session-bridges.ts`.
  When Step 8 lands, `withState()` becomes the default session extension and
  adopters override by passing a configured `withState({ ... })`.
- **Snapshot durability.** Values are stored as `unknown` and round-tripped
  as-is; cross-process / cross-restart durability is bounded by JSON
  serializability — non-serializable values (functions, class instances)
  don't survive a real snapshot.

## Verified by

- `src/__tests__/harness.spec.ts` (5 tests) — sync surface (`get` / `has` /
  `list`), async commands (`set` / `delete`) through the Operation envelope,
  per-key + wildcard subscription fan, and snapshot round-trip firing
  subscribers on changed keys.
- `src/__tests__/store-backing.spec.ts` (12 tests) — the storification contract:
  every `set` / `delete` / `importSnapshot` dual-writes (projection + store),
  `hydrate()` rebuilds the projection from a pre-seeded store and pings
  subscribers (merge, not clear-first), `import`/`export` coexist with the
  store, and the `undefined`-value round-trip (write-through, `hydrate`,
  export/import all keep an `undefined`-valued cell present).
- `src/__tests__/change-stream.spec.ts` (4 tests) — the `onChange` notify seam:
  add (no prev) / update (with prev) on `set`, `remove` (value omitted) on
  `delete` / no-op delete emits nothing, the `existed`-not-`prev!==undefined`
  discriminator (`set(undefined)` then `set(value)` = add→update), and
  unsubscribe / multiple projections on one stream.
- `src/__tests__/integration-with-compiler.spec.tsx` (4 tests) —
  `useSessionState` initial registration, non-overwrite on re-mount,
  persistence across unmount → remount when the bridge is reused, and
  reactivity to external `set` against the real `CompilerHarness`.
- `src/conformance.ts` — `runStateHarnessConformance` exports the protocol
  battery for adopter impls (`list()` returns `{ key, value }` entries).
- `@agentick/transport-in-process` `src/__tests__/wire-reads-e2e.spec.ts` —
  `state/get` + `state/list` + `state/set` round-trip over the real gateway +
  dynamic lane, `commands/list` enumerates them, deny-by-default preserved.
- `src/client/__tests__/state-handle.spec.ts` (5 tests) — the client handle: the
  eager `state/list` poll seeds `list()`/`get()`, each verb's wire request shape
  (`set`/`delete`/`refresh`), fire-and-refetch (a mutation triggers a follow-up
  `state/list`), and the zero-arg `subscribe(cb)` store contract.
- `src/client/__tests__/session-state.spec.ts` (2 tests) — ADR 87 self-assembly:
  importing `@agentick/state/client` makes `client.session(id).state`
  resolve via `registerSessionHandleExtension`, polling a snapshot and issuing
  `state/set` over the transport.

@see [`docs/proposals/v2/blueprint/26-harness-api-shape.md`](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
@see [`docs/proposals/v2/blueprint/51-invocation-and-authorization.md`](../../docs/proposals/v2/blueprint/51-invocation-and-authorization.md)
