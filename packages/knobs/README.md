# @agentick/knobs

**A knob is the one cell the model can both read and write.** Registered knobs render into the model's context as a section; the `knob_set` tool lets the model change them. Every write runs a validation pipeline, lands as an audited operation, and fires per-value subscribers — so the render tree, the host process, and the model all converge on the same cell.

That symmetry is the bet. There is no "React knobs" and no "server knobs": there is one cell set — get / set / register / dispatch / subscribe — and `useKnob` is a `useSyncExternalStore` binding over exactly those cells. Everything the hook can do, plain server code does through `session.knobs`; the hook adds only the render lifecycle.

## Install

```bash
npm install @agentick/knobs
```

Subpaths: `/react` (hook + components), `/client` (browser-side handle), `/testing` (stub + conformance suite).

## Quick start

```tsx
import { Section, System } from "@agentick/compiler-react";
import { Knobs, useKnob } from "@agentick/knobs/react";

export function Agent() {
  const [verbosity] = useKnob("verbosity", 3, {
    description: "How much detail to include",
    min: 1,
    max: 5,
    group: "output",
  });

  return (
    <>
      <System>You are a helpful assistant.</System>
      <Section id="style">Answer at verbosity level {verbosity} of 5.</Section>
      <Knobs />
    </>
  );
}
```

`<Knobs />` renders both halves of the contract: a `<Section id="knobs">` listing every registered knob, and the `knob_set` tool declaration. The model reads the section, calls the tool, the cell changes, the component re-renders, and the next tick's context reflects the new value.

> [!NOTE]
> `<Knobs />` returns `null` when nothing is registered. Drop it from the tree and `useKnob` still gives you a live, subscribable cell — it just stops being model-visible and model-settable.

## What the model sees

The formatter emits one line per knob — `id [semantic-type]: value — description` plus parenthesized hints — with `### group` headings and ungrouped knobs first:

```text
Knobs are adjustable parameters you can modify using the knob_set tool.

mood [select]: "curious" — Agent mood (options: "curious", "decisive")

### output
verbose [toggle]: false — Verbose output
verbosity [range]: 3 — How much detail to include (1 - 5)
```

The semantic type is derived, not declared: `boolean` → `toggle`, `number` with `min`/`max` → `range`, bare `number` → `number`, `string` with `options` → `select`, otherwise `text`. Hints cover `options`, the numeric range, `step`, `max N chars`, `pattern`, `required`, `resets after use`, and `read-only`.

`inline: true` keeps a knob out of the listing (per-message collapse state and similar high-cardinality cells) while leaving it settable by name; the section notes that inline knobs exist.

## Validation is one pipeline

`knob_set` owns no validation logic of its own — it forwards to `dispatch`, which runs the checks in a fixed order and returns the content blocks the model receives either way:

1. exactly one of `name` / `group`
2. the knob exists
3. it isn't read-only
4. `typeof value` matches `valueType`
5. the value is in `options`, when declared
6. `min` / `max` for numbers
7. `maxLength` / `pattern` for strings
8. the custom `validate(value)` predicate

```ts
await session.knobs.dispatch({ name: "verbosity", value: 9 });
// → [{ type: "text", text: 'Value for "verbosity" must be <= 5. Got 9.' }]
```

Because it is the same entry point, calling `dispatch` from host code is indistinguishable from the model calling the tool — which is what makes it testable without a model in the loop.

### Read-only knobs

`readOnly` splits visible from settable. The knob renders in the section (tagged `read-only`) so the model can reason about it, but `knob_set` refuses it by name and skips it in group writes. Only application code mutates it:

```tsx
function BudgetStatus({ remaining }: { remaining: number }) {
  const [, setRemaining] = useKnob("budgetRemaining", remaining, {
    description: "Tokens left in this run",
    readOnly: true,
  });
  useEffect(() => setRemaining(remaining), [remaining, setRemaining]);
  return null;
}
```

This is the mechanism [@agentick/gates](../gates) builds on: a verified gate registers its backing knob read-only, so the model cannot set itself past a failing check.

### Group writes

Tag related knobs with the same `group` and the model can flip them all at once. The batch type-checks the whole group before mutating anything, skips read-only members, and rejects when the members disagree on `valueType`:

```ts
await session.knobs.dispatch({ group: "output", value: true });
// → [{ type: "text", text: 'Set 2 knobs in group "output" to true: verbose, showSources.' }]
```

### Momentary knobs

`momentary: true` makes a one-shot trigger: the model flips it, your tree reacts, and the value resets to its initial at the end of the execution — not the end of the tick, so it survives the tool round-trip that acts on it.

```tsx
const [regenerate] = useKnob("regenerate", false, {
  description: "Redraw the plan from scratch on this turn",
  momentary: true,
});
```

## The programmatic surface

`session.knobs` is the same cell set without React. Reads are synchronous `Map` lookups; writes are operations with `requested → terminal` envelopes on the bus.

```ts
session.knobs.list(); // readonly KnobDescriptor[] — descriptor + current value
session.knobs.get("verbosity"); // KnobPrimitive | undefined
session.knobs.has("verbosity"); // boolean

await session.knobs.set({ id: "verbosity", value: 3 }); // journaled write
await session.knobs.dispatch({ name: "verbosity", value: 3 }); // + validation

const off = session.knobs.subscribe("verbosity", () => rerender());
session.knobs.subscribeAll(() => refreshDashboard());
off();
```

`session.knob(name)` is the same cell by reference, with a synchronous setter that fires the write and moves on:

```ts
const verbosity = session.knob<number>("verbosity");
verbosity.get(); // 3
verbosity.set(5); // queue the mutation
verbosity.subscribe(() => console.log("now", verbosity.get()));
```

Each verb is also inbox-addressable at `knobs:{scopeId}` — `knobs:set`, `knobs:register`, `knobs:dispatch` — so a remote actor mutating a knob runs the identical operation an in-process call would, with no extra routing code.

### Composing writes with Effect

A `KnobsHarness` instance exposes `fx`: the un-run Effect twins of the same three commands. Reach for it when you want several writes in one fiber tree instead of a chain of awaits; the Promise methods are the derived edge facade over these.

```ts
import { Effect } from "effect";
import { stubKnobsHarness } from "@agentick/knobs/testing";

const knobs = stubKnobsHarness();

await Effect.runPromise(
  Effect.gen(function* () {
    yield* knobs.fx.set({ id: "verbosity", value: 5 });
    yield* knobs.fx.set({ id: "tone", value: "terse" });
  }),
);
```

## Durable values

Values are backed by a `Store` of `{ id, value }` cells; the synchronous read surface is a cache over it, so reads never await. The default store is in-memory. Inject an adapter and knob values outlive the process — `hydrate()` loads the store back into the read cache.

```ts
import { withKnobs, createKnobStore } from "@agentick/knobs";

const extension = withKnobs({
  initial: { verbosity: 3 }, // seed at construction
  store: createKnobStore(), // swap for a durable adapter
});
```

Descriptors are never stored. They are re-declared by the tree on every mount, which is why `exportSnapshot()` / `importSnapshot()` round-trip values only.

## State reaches clients as a patch stream

Knob state leaves the session two ways. The coarse way is `exportSnapshot()` — the whole store, re-sent. The fine way is the `knobs-state` channel: one opening `snapshot` frame, then RFC 6902 JSON-Patch `delta` frames, one op per knob that changed.

Delta generation needs no diffing. Every mutation already notifies per-id, so a changed knob _is_ a single `add` or `replace` op; only the far side applies a patch.

```ts
import { KNOBS_STATE_CHANNEL_FQN, type KnobsStateFrame } from "@agentick/knobs";
import { applyJsonPatch } from "@agentick/utils";

let store = knobs.stateSnapshotFrame().values; // seed (or re-seed) from the current state

for await (const frame of frames as AsyncIterable<KnobsStateFrame>) {
  store = frame.kind === "snapshot" ? frame.values : applyJsonPatch(store, frame.ops);
}
```

Frames carry a monotonic `version`; a gap means a dropped delta, so re-seed from `stateSnapshotFrame()`. Emission is fire-and-forget and bus-only — state frames are not journaled.

The snapshot frame carries **descriptors, not just values**: each knob's id, current value, and declared metadata. That is enough to render a real control with no second round-trip. `validate` and `schema` are stripped — a function and a live schema object can't cross a transport — and everything else passes through verbatim.

## The client handle

Importing `@agentick/knobs/client` registers `session.knobs` on the wire client. It folds the `knobs-state` channel, so `list()` reflects state from before you connected:

```ts
import "@agentick/knobs/client";

const knobs = client.session(sessionId).knobs;

knobs.subscribe(() => render(knobs.list())); // zero-arg store contract
for (const k of knobs.list()) {
  slider({ label: k.description ?? k.id, value: k.value, min: k.min, max: k.max });
}

await knobs.set("verbosity", 3); // fire-and-observe
knobs.close();
```

`set` issues `knobs/set` and resolves `void`. It does **not** patch the local view — the new value comes back as a delta on the same channel and re-folds it. One write path, one read path.

`await knobs.commands()` is the other `knobs/*` row a client can reach: the declared verbs with their exposure, so a UI can ask what this session's knobs surface accepts rather than assume `set` is granted. Nothing on the handle implements it — it is the discovery door every harness serves, described in [@agentick/gateway](../gateway#discovery--two-doors).

`knobs.use(middleware)` scopes a client middleware to the `knobs/*` verbs. `knobsHandle(client, sessionId)` is the same handle as a free factory when you'd rather compose than rely on the registered slot, and `knobsStateView(client, sessionId)` is the lower-level values-only fold (`Record<id, value>`) for consumers that don't want descriptors.

> [!IMPORTANT]
> Two things are named `session.knobs` and they are not the same object. The server-side one is the authority: per-knob `get(name)` / `set({ id, value })` / `dispatch` / `subscribe(name, …)`. The client-side one is a read replica plus a flat `set(id, value)`. Same noun, different vantage — a CQRS split, not a duplicated API.

## API

### `@agentick/knobs`

| Export                                             | Purpose                                                   |
| -------------------------------------------------- | --------------------------------------------------------- |
| `withKnobs(options?)`                              | Session extension: `initial` seed values, `store` backing |
| `KnobsHarness`                                     | The implementation, for direct construction; carries `fx` |
| `createKnobStore()`                                | The bundled in-memory value store                         |
| `knobsWireExtension`                               | Serves `knobs/set` over the gateway                       |
| `KNOBS_STATE_CHANNEL` / `KNOBS_STATE_CHANNEL_FQN`  | `"knobs-state"` and its bus topic                         |
| `knobPointer(id)` / `toWireDescriptor(descriptor)` | RFC 6901 pointer for a knob; strip `validate`/`schema`    |
| `KnobsHandle` (type)                               | What `session.knobs` exposes                              |
| `KnobsStateFrame` (type) + frame subtypes          | The `snapshot` \| `delta` union on the channel            |
| `WireKnobDescriptor` (type)                        | `KnobDescriptor` minus `validate` and `schema`            |
| `KnobEntry` / `KnobStoreQuery` (types)             | The stored `{ id, value }` cell and its (empty) query     |

### `session.knobs`

| Method                | Returns                                                  |
| --------------------- | -------------------------------------------------------- |
| `list()`              | `readonly KnobDescriptor[]` — descriptors + values       |
| `get(id)` / `has(id)` | Current value; whether a value exists                    |
| `set(input)`          | `Promise<void>` — journaled write, no validation         |
| `dispatch(input)`     | `Promise<readonly ContentBlock[]>` — the `knob_set` path |
| `subscribe(id, fn)`   | Fires when that value changes                            |
| `subscribeAll(fn)`    | Fires on any value or descriptor change                  |

`session.knob(name)` returns a `KnobHandle<T>`: `name`, `get()`, `set(value)`, `subscribe(fn)`.

On a `KnobsHarness` instance, additionally: `fx` (the Effect twins), `onChange(fn)` (typed `ChangeEvent` push), `stateSnapshotFrame()`, `exportSnapshot()` / `importSnapshot()`, and `hydrate()`.

### `@agentick/knobs/react`

| Export                                            | Purpose                                          |
| ------------------------------------------------- | ------------------------------------------------ |
| `useKnob(id, initial, options?)`                  | `readonly [T, (v: T) => void]`                   |
| `Knobs`                                           | Section + `knob_set` tool; render prop supported |
| `Knobs.Provider` / `Knobs.Controls`               | Full custom rendering                            |
| `useKnobsContext()` / `useKnobsContextOptional()` | The grouped view inside `<Knobs.Provider>`       |

`UseKnobOptions`: `description`, `valueType`, `group`, `options`, `min`, `max`, `step`, `maxLength`, `pattern`, `required`, `momentary`, `inline`, `readOnly`, `validate`, `schema`.

Three rendering modes:

```tsx
<Knobs />                                            {/* section + tool */}
<Knobs>{(groups) => <MyKnobTable groups={groups} />}</Knobs>  {/* your section + tool */}
<Knobs.Provider>                                     {/* tool registers unconditionally */}
  <Knobs.Controls renderKnob={(k) => <MyKnob knob={k} />} />
</Knobs.Provider>
```

### `@agentick/knobs/client`

| Export                              | Purpose                                                                      |
| ----------------------------------- | ---------------------------------------------------------------------------- |
| `session.knobs`                     | Registered on import: `list` / `get` / `subscribe` / `set` / `use` / `close` |
| `knobsHandle(client, sessionId)`    | The same handle as a free factory                                            |
| `knobsStateView(client, sessionId)` | Values-only fold (`Record<id, value>`)                                       |
| `KNOBS_STATE_CHANNEL` / `_FQN`      | The channel name, for a consumer subscribing itself                          |

Types: `KnobsState`, `KnobsClient`, `KnobsCommandClient`, `KnobsHandle`, `WireKnobDescriptor`, `KnobsStateChannelName`, `KnobsStateFrame`, `KnobsStateSnapshotFrame`, `KnobsStateDeltaFrame`. The channel name and frame shapes live here so a browser bundle never has to reach for the root barrel — which would drag the server harness in with them. `toWireDescriptor` and `knobPointer` stay off this barrel: they operate on the server's live descriptor and generate patches, and the client only reads.

### `@agentick/knobs/testing`

| Export                       | Purpose                                      |
| ---------------------------- | -------------------------------------------- |
| `stubKnobsHarness(initial?)` | A real harness instance on its own substrate |
| `runKnobsHarnessConformance` | Certify an alternate implementation          |

## Patterns

**Gates.** [@agentick/gates](../gates) is knobs plus a continuation rule — a gate's value _is_ a knob value, and a verified gate's read-only backing knob is what makes its check unforgeable.

**Rendering.** [@agentick/compiler-react](../compiler-react) owns `<Section>`, `<System>`, `createTool`, and the bridge context `useKnob` reads.

**Shapes.** [@agentick/spec](../spec) owns `KnobDescriptor`, `KnobPrimitive`, `KnobsSetInput`, `KnobsDispatchInput`, and `KnobHandle`.

**Client.** [@agentick/client-core](../client-core) owns `channelView`, the `ClientHandle` / `Enumerable` contracts, and the session sub-handle registry the `/client` subpath registers into.

**Not model-visible?** Use [@agentick/state](../state) instead. Same shape, no descriptors, no tool — the adopter's private stash.

## Roadmap & known gaps

- **`validate` and `schema` don't cross a process boundary.** They are a function and a live schema object, so a cluster-routed registration drops them; a remote node validates only the declared field constraints. Not re-hydrated remotely.
- **Layered resolution is present but unreachable.** `KnobsHarness` accepts a read-only parent layer — reads fall through, self shadows by id, writes and snapshots stay self-only — and it is tested, but nothing constructs a parent today. It exists so an app-scoped tier can drop in without a rewrite.
- **`withKnobs()` is not the construction site yet.** Sessions construct their knobs directly; the extension factory is correct but the wiring point still moves.
- **`knob_set` captures its dependency at render.** Sibling tools resolve their collaborator from the handler context at dispatch. This one still uses render-time capture, pending a change in where knobs is constructed.

## Verified by

- `src/__tests__/harness.spec.ts` — operation envelopes for `set` / `register` / `dispatch`, inbox addressability over `knobs:{scopeId}`, snapshot round-trip (values only, descriptors re-declared), read-only enforcement by name and in group writes, and layered resolution over a parent (fall-through, self shadowing, self-only writes, self-only `exportSnapshot`).
- `src/__tests__/integration-with-compiler.spec.tsx` — against the real compiler: descriptor registration and `valueType` inference, value preservation on re-registration, momentary reset at execution end, `<Knobs />` default rendering (including the formatter output and the `knob_set` declaration), inline knobs hidden, the render prop suppressing the default section, and re-render on an external `set`.
- `src/__tests__/state-channel.spec.ts` — `add` vs `replace` deltas, monotonic gap-free `version`, defaulted `register` emitting while descriptor-only does not, `importSnapshot` emitting a fresh snapshot frame, `stateSnapshotFrame()` not advancing the version, RFC 6901 id escaping, and a snapshot seed plus applied deltas reconstructing the live store.
- `src/__tests__/descriptors-wire.spec.ts` — the snapshot frame carries declared metadata, strips `validate`/`schema`, and the channel-snapshot provider path returns the descriptor-carrying frame.
- `src/__tests__/change-stream.spec.ts` — the `onChange` seam: add vs update, defaulted register, dispatch riding the same write path, unsubscribe, and multiple projections on one stream.
- `src/__tests__/store-backing.spec.ts` — every write path reaching the store, `hydrate()` repopulating and pinging subscribers as a merge, and export/import coexisting with the store.
- `src/__tests__/fx-surface.spec.ts` — `fx.set` returns an un-run Effect, the plain method is the Promise facade, both drive the same command, twins nest in one `Effect.gen`, and `fx.dispatch` yields the `knob_set` blocks.
- `src/__tests__/wire.spec.ts` — `knobs/set` resolves the session and calls `set({ id, value })`; an unresolved session id throws.
- `src/client/__tests__/knobs-handle.spec.ts` + `knobs-handle.conformance.spec.ts` + `knobs-state-view.spec.ts` + `session-knobs.spec.ts` — the write request shape, `list()`/`get()` over descriptors, the snapshot-then-delta CQRS round-trip, the zero-arg `subscribe` contract, the values-only fold, and `session.knobs` self-assembling on the client session handle.
- `src/conformance.ts` — `runKnobsHarnessConformance`: the sync and async surface, stable `list()` references, per-id vs wildcard subscription, `register` preserving an existing value, and `dispatch` validation producing content blocks.
