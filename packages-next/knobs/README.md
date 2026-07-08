# @agentick/knobs-next

`KnobsHarness` — **model-visible, model-settable reactive state**. The one
primitive the model can both _read_ (rendered into its context) and _write_
(via the `set_knob` tool), with per-value subscription so the UI, the agent
tree, and the model all converge on the same cell.

This package is the flagship example of the v2 thesis that **React is a
binding over a programmatic core.** There is no "React knobs" and "server
knobs" — there is one `KnobsHarness` (get / set / register / dispatch /
subscribe), and `useKnob` is a thin `useSyncExternalStore` binding over the
exact same value cells. Everything `useKnob` can do, `session.knobs` /
`bridges.knobs` can do from plain server code; the hook adds only the render
lifecycle.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## What it is

A knob is a named reactive cell (`string | number | boolean`) plus an
optional descriptor (type, group, bounds, options, validator). Three facts
define the primitive:

1. **Model-visible.** Registered knobs render into a `<Knobs />` section so
   the model sees the current values as context.
2. **Model-settable.** `<Knobs />` also declares a `set_knob` tool; the model
   mutates knobs by calling it. Writes run a validation pipeline
   (type → options → bounds → length/pattern → custom `validate`).
3. **Reactive + subscribable.** Any write — from the model, from adopter
   code, from a remote inbox message — fires per-id subscribers, so
   `useKnob` re-renders and `session.knob(name).subscribe(...)` fires.

`readOnly` knobs are model-**visible** but not model-**settable**: they
render in the section (with a `read-only` hint) so the model can read the
state, but `set_knob` rejects writes to them by name and skips them in group
writes. Only application code mutates a read-only knob (via the `useKnob`
setter or `harness.set`). This is how a verified gate keeps its state
unforgeable by the model.

`KnobsHarness extends BaseHarness<"knobs">`, so `set` / `register` /
`dispatch` are declared commands (ADR 51): each write runs through
`runOperation` — the terminal envelope IS the change-event audit trail — and
each verb is inbox-addressable over the harness address (`knobs:{scopeId}`)
with no extra routing code. Reads (`get` / `has` / `list` / `subscribe` /
`subscribeAll`) are cheap synchronous Map reads, no envelopes.

## Dual surface

### Programmatic — the core

The harness is reachable three ways, all the same instance:

| Surface              | Where                                     | Shape                   |
| -------------------- | ----------------------------------------- | ----------------------- |
| `bridges.knobs`      | internal bridge plumbing / `useBridges()` | `KnobsHarnessProtocol`  |
| `session.knobs`      | adopter / server-side code                | `KnobsHandle` (curated) |
| `session.knob(name)` | per-knob access by reference              | `KnobHandle<T>`         |

```ts
// list / read / set / dispatch from plain server code — no React.
session.knobs.list(); // readonly KnobDescriptor[] (descriptor + current value)
session.knobs.get("verbosity"); // KnobPrimitive | undefined
await session.knobs.set({ id: "verbosity", value: 3 }); // async Operation envelope

// The set_knob validation pipeline, invoked directly (returns the same
// ContentBlock[] the model would receive):
await session.knobs.dispatch({ name: "verbosity", value: 3 });

// subscribe to one knob, or to any change:
const off = session.knobs.subscribe("verbosity", () => rerender());
session.knobs.subscribeAll(() => refreshDashboard());
```

Per-knob handle for reference-style access (sync setter — fires the async
Operation fire-and-forget):

```ts
const verbosity = session.knob<number>("verbosity");
verbosity.get(); // 3
verbosity.set(5); // queue the mutation, move on
verbosity.subscribe(() => console.log("changed to", verbosity.get()));
```

### React — a binding over the core

`useKnob` is `useSyncExternalStore` over `useBridges().knobs`. It registers a
descriptor in `useEffect` (fire-and-forget the async `register` Operation),
subscribes to the same per-id notifier, and returns `[value, setValue]` where
`setValue` fires `knobs.set(...)`. Nothing the hook touches is React-only —
it is the same harness the programmatic surface exposes.

```tsx
import { useKnob } from "@agentick/knobs-next/react";

function Agent() {
  const [verbosity, setVerbosity] = useKnob("verbosity", 3, {
    description: "How much detail to include",
    min: 1,
    max: 5,
    group: "output",
  });

  // Model-visible but NOT model-settable — only this component's setter
  // (or session.knobs.set) can change it.
  const [phase] = useKnob("phase", "planning", { readOnly: true });

  return (
    <>
      <Knobs />
      <Section id="status">Current phase: {phase}</Section>
    </>
  );
}
```

## `<Knobs />` — the model surface

`<Knobs />` renders the `set_knob` tool declaration **and** a
`<Section id="knobs">` listing every non-`inline` knob, grouped by `group`.
It returns `null` when no knobs are registered. Three modes:

```tsx
import { Knobs } from "@agentick/knobs-next/react";

// 1. default — tool + auto-formatted section
<Knobs />

// 2. render prop — tool + your custom section over the grouped knobs
<Knobs>{(groups) => <MyKnobTable groups={groups} />}</Knobs>

// 3. provider — <Knobs.Provider> + <Knobs.Controls /> + useKnobsContext()
//    for full custom rendering. The set_knob tool registers unconditionally.
<Knobs.Provider>
  <Knobs.Controls renderKnob={(k) => <MyKnob knob={k} />} />
</Knobs.Provider>
```

The model-facing formatter emits one line per knob —
`name [semantic-type]: value — description` followed by parenthesized hints
(options, range, `step`, `max N chars`, pattern, `required`, `resets after
use`, `read-only`) — with `### group` headings. `set_knob` delegates
validation + mutation to `harness.dispatch(...)`; there is no duplicate
validation logic in the tool. Supplying `{ group }` instead of `{ name }`
sets every settable knob in that group atomically after a shared type-check.

## API

### `@agentick/knobs-next`

- **`KnobsHarness`** — `BaseHarness<"knobs">` impl of `KnobsHarnessProtocol`.
  Construct with `(scopeId, journal, bus, inbox, parentLayer?)`.
  - Sync reads: `get(id)` · `has(id)` · `list()` · `subscribe(id, fn)` ·
    `subscribeAll(fn)`.
  - Async commands: `set({ id, value })` · `register({ id, descriptor })` ·
    `dispatch(input)` (the `set_knob` pipeline → `ContentBlock[]`).
  - Snapshot: `exportSnapshot()` / `importSnapshot(values)` round-trip the
    value cells (descriptors are re-declared on remount, not snapshotted).
  - **Layer-aware resolution (ADR 34 cascade).** The optional `parentLayer`
    is a read-only fallback `KnobsHarnessProtocol`: reads (`get` / `has` /
    `list`) fall through to it when self has no entry, **self shadows parent
    by id**, and writes (`set` / `register`) mutate **SELF ONLY** — the parent
    is never touched. Critically, `exportSnapshot()` captures the **SELF layer
    ONLY**: a session snapshot must not embed inherited (app-scoped) state,
    which is snapshotted at the parent's own scope. Named `parentLayer` to
    disambiguate from `BaseHarness.parent` (the ADR 31 harness-hierarchy
    parent). **Absent everywhere today** — the session constructs its knobs
    with no parent, so the chain is `[self]` and behavior is byte-identical to
    a single layer; the seam lets a future **app tier** drop in as a session's
    parent layer with no rewrite.
- **`withKnobs(options?)`** — `SessionExtension` factory.
  `WithKnobsOptions.initial` seeds values at construction (via
  `importSnapshot`).
- **`runKnobsHarnessConformance({ make })`** — protocol conformance suite;
  any `KnobsHarnessProtocol` impl (a redis-backed variant, a stub) can be
  driven through it to prove compliance.
- **Type `KnobsHandle`** — the curated `session.knobs` surface (hides `id` /
  `ready` / `close` / snapshot import-export / `register`).

### `@agentick/knobs-next/react`

- **`useKnob(id, initial, options?)`** → `readonly [T, (v: T) => void]`.
  `UseKnobOptions`: `description`, `valueType`, `group`, `options`, `min`,
  `max`, `step`, `maxLength`, `pattern`, `required`, `momentary`, `inline`,
  `readOnly`, `validate`, `schema`.
- **`Knobs`** (+ `Knobs.Provider`, `Knobs.Controls`) — the model surface.
- **`useKnobsContext()` / `useKnobsContextOptional()`** — read the grouped
  knob view inside `<Knobs.Provider>`.
- Types: `KnobsProps`, `KnobsRenderFn`, `KnobsContextValue`, `KnobInfo`,
  `KnobGroup`.

### `@agentick/knobs-next/testing`

- **`stubKnobsHarness(initial?)`** — a real `KnobsHarness` on its own
  in-memory substrate (journal / bus / inbox); `initial` seeds values.

Per-knob handle (`session.knob(name)` → `KnobHandle<T>`) and the top-level
`session.knobs` accessor are owned by `@agentick/session-next` (which
augments `SessionHarnessProtocol`), not by this package.

See the generated typedoc for the exhaustive descriptor / input types.

## Patterns

**Momentary trigger.** `useKnob("regenerate", false, { momentary: true })`
auto-resets to its initial value at execution end — a one-shot "do this once"
signal the model can flip, consumed exactly once per execution.

**Read-only status projection.** Expose derived application state to the
model without letting it write:
`useKnob("budgetRemaining", 100, { readOnly: true })`. Only your setter
mutates it; `set_knob` rejects the model's writes with an explanatory error
block.

**Grouped batch dispatch.** Tag related knobs with the same `group`; the
model calls `set_knob({ group: "output", value: true })` to flip them all at
once. Group writes skip read-only members and type-check the group first.

## Status & roadmap

Extracted per ADR 26 Step 2, modularized per ADR 27. Green.

- **`withKnobs()` wiring (ADR 26 Step 8) — pending.** The `SessionInstaller`
  path is not yet the construction site: today the SessionHarness constructs
  `KnobsHarness` directly in `session-bridges.ts`. When Step 8 lands,
  `withKnobs()` becomes the default session extension and adopters override by
  passing a configured `withKnobs({ ... })`. The extension factory here is
  already correct; only the wiring point moves.
- **Cross-process `validate` / `schema`.** The custom `validate` function and
  `schema` are non-serializable; cluster-routed registrations drop them (a
  remote node validates only the field-level constraints). Documented on the
  descriptor, not yet re-hydrated remotely.

## Verified by

- `src/__tests__/harness.spec.ts` (18 tests) — Operation envelopes
  (`set` / `register` / `dispatch` emit requested + terminal), inbox
  addressability (`knobs:set` / `knobs:register` / `knobs:dispatch` over the
  harness address), snapshot round-trip, read-only enforcement
  (`dispatch` rejects `set_knob` by name + skips read-only in group writes),
  and **layered resolution over a `parentLayer`** — `get` fall-through, self
  shadows parent by id, `set` / `register` write self only, `list` union with
  self-shadowing, and **`exportSnapshot` captures the self layer only** (never
  inherited parent state).
- `src/__tests__/integration-with-reconciler.spec.tsx` (10 tests) — `useKnob`
  descriptor registration, momentary reset at execution end, `<Knobs />`
  default rendering + render prop, and reactivity (external `set` re-renders
  subscribed components) against the real `ReconcilerHarness`.
- `src/conformance.ts` — `runKnobsHarnessConformance` exports the protocol
  battery (sync + async surface, stable `list()` reference, per-id vs
  wildcard subscription, `register` value preservation, `dispatch`
  validation → content blocks) for adopter impls.

@see [`docs/proposals/v2/blueprint/26-harness-api-shape.md`](../../docs/proposals/v2/blueprint/26-harness-api-shape.md)
@see [`docs/proposals/v2/blueprint/27-modular-built-ins.md`](../../docs/proposals/v2/blueprint/27-modular-built-ins.md)
