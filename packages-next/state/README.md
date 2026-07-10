# @agentick/state-next

`StateHarness` — **session-internal reactive key/value storage**. Arbitrary
adopter state, keyed by string, that survives re-mounts and hibernate-resume,
with per-key subscription. The v2 analog of v1's `useComState`.

The one thing to hold onto: **state is NOT model-visible.** Unlike knobs,
nothing here renders into the model's context and the `set_knob` tool does not
reach it. State is the adopter's private stash — component-local scratch, a
counter, a cached fetch result — parallel to the timeline, owned entirely by
your code.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## What it is

A `Map<string, unknown>` behind the full harness contract. Two surfaces:

- **Sync reads** — `get(key)` · `has(key)` · `list()` · `subscribe(key, fn)`
  · `subscribeAll(fn)`. Cheap Map reads; no envelopes.
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

## Contrast with knobs

|                          | `@agentick/state-next`  | `@agentick/knobs-next`            |
| ------------------------ | ----------------------- | --------------------------------- |
| Model can read           | no                      | yes (rendered in `<Knobs />`)     |
| Model can write          | no                      | yes (`set_knob` tool)             |
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
session.state.list(); // ["draftCount"]

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
import { useSessionState } from "@agentick/state-next/react";

function Draft() {
  const [count, setCount] = useSessionState("draftCount", 0);
  return <Section id="draft">Revisions so far: {count}</Section>;
}
```

Because the value lives on the harness (not in a `useState` cell), it survives
an unmount → remount of the component and a hibernate → resume of the session.

## API

### `@agentick/state-next`

- **`StateHarness`** — `BaseHarness<"state">` impl of `StateHarnessProtocol`.
  Construct with `(scopeId, journal, bus, inbox)`.
  - Sync reads: `get(key)` · `has(key)` · `list()` · `subscribe(key, fn)` ·
    `subscribeAll(fn)`.
  - Notify seam (ADR 75): `onChange(fn)` — typed push carrying the delta
    (`ChangeEvent<unknown>`): `set` → add/update, `delete` → remove. The push
    twin of the bare `subscribe` render-ping; the source a future `state`
    snapshot+delta channel projects from.
  - Async commands: `set({ key, value })` · `delete({ key })`.
  - Snapshot: `exportSnapshot()` / `importSnapshot(values)`.
- **`withState(options?)`** — `SessionExtension` factory.
  `WithStateOptions.initial` seeds entries at construction (via
  `importSnapshot`). Adopters wanting a custom backend (e.g. redis-backed)
  pass their own configured `withState({ ... })`.
- **`runStateHarnessConformance({ make })`** — protocol conformance suite for
  alternative impls.
- **Type `StateHandle`** — the curated `session.state` surface (hides `id` /
  `ready` / `close` / snapshot import-export).

### `@agentick/state-next/react`

- **`useSessionState<T>(key, initial)`** → `readonly [T, (v: T) => void]`.

### `@agentick/state-next/testing`

- **`stubStateHarness(initial?)`** — a real `StateHarness` on its own
  in-memory substrate; `initial` seeds entries.

The top-level `session.state` accessor is owned by
`@agentick/session-next` (which augments `SessionHarnessProtocol`), not by
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
- `src/__tests__/change-stream.spec.ts` (4 tests) — the `onChange` notify seam:
  add (no prev) / update (with prev) on `set`, `remove` (value omitted) on
  `delete` / no-op delete emits nothing, the `existed`-not-`prev!==undefined`
  discriminator (`set(undefined)` then `set(value)` = add→update), and
  unsubscribe / multiple projections on one stream.
- `src/__tests__/integration-with-reconciler.spec.tsx` (4 tests) —
  `useSessionState` initial registration, non-overwrite on re-mount,
  persistence across unmount → remount when the bridge is reused, and
  reactivity to external `set` against the real `ReconcilerHarness`.
- `src/conformance.ts` — `runStateHarnessConformance` exports the protocol
  battery for adopter impls.

@see [`docs/proposals/v2/blueprint/26-harness-api-shape.md`](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
@see [`docs/proposals/v2/blueprint/51-invocation-and-authorization.md`](../../docs/proposals/v2/blueprint/51-invocation-and-authorization.md)
