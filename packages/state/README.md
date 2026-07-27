# @agentick/state

**State is the half of session storage the model never sees.** A string-keyed cell set that survives component remounts and session resume, with per-key subscription — a filter set, a cursor, a cached fetch result, anything your code needs to remember and the model has no business reading.

That exclusion is the design, not an omission. Nothing here renders into context and no tool reaches it, so a value you put in state cannot be leaked into a prompt by accident or overwritten by a model that decided it knew better. When you _do_ want the model in the loop, that's [@agentick/knobs](../knobs) — same shape, opposite policy.

## Install

```bash
npm install @agentick/state
```

Subpaths: `/react` (hook), `/client` (browser-side handle), `/testing` (stub + conformance suite).

## Quick start

```tsx
import { Section } from "@agentick/compiler-react";
import { useSessionState } from "@agentick/state/react";

export function DraftStatus() {
  const [revisions, setRevisions] = useSessionState("draft.revisions", 0);

  return (
    <Section id="draft">
      {revisions === 0 ? "No draft yet." : `Draft revised ${revisions} times.`}
    </Section>
  );
}
```

`useSessionState` is a `useSyncExternalStore` binding over the session's cells, not a `useState` cell. Unmount the component, remount it, resume the session in another process — the value is still there. It seeds `initial` with a fire-and-forget write only when the key is absent, so a remount never clobbers what's already stored.

## Choosing between state and knobs

|                 | `@agentick/state`   | `@agentick/knobs`                 |
| --------------- | ------------------- | --------------------------------- |
| Model can read  | no                  | yes — rendered by `<Knobs />`     |
| Model can write | no                  | yes — the `knob_set` tool         |
| Value type      | `unknown`           | `string \| number \| boolean`     |
| Descriptors     | none                | type, bounds, options, `validate` |
| Purpose         | the adopter's stash | model-facing tunable parameters   |

Everything else is shared: both are cells behind an audited write path, both are store-backed, both ship a client handle.

## The programmatic surface

`session.state` is the same cell set without React. Reads are synchronous; writes are operations with `requested → terminal` envelopes on the bus.

```ts
await session.state.set({ key: "draft.revisions", value: 3 });

session.state.get("draft.revisions"); // 3 (typed unknown — narrow at the call site)
session.state.has("draft.revisions"); // true
session.state.list(); // readonly StateListEntry[] — [{ key, value }, …]

const off = session.state.subscribe("draft.revisions", () => rerender());
session.state.subscribeAll(() => refreshDashboard());

await session.state.delete({ key: "draft.revisions" }); // fires the subscriber too
off();
```

Both verbs are inbox-addressable at `state:{scopeId}` — `state:set` and `state:delete` — so a message from outside the process runs the identical operation an in-process call would.

> [!IMPORTANT]
> `get` cannot distinguish "absent" from "present, holding `undefined`" — like `Map.get`. Presence is a `has()` question, and `has()` is a key-membership check all the way down to the stored cell. An `undefined`-valued key survives write-through, `hydrate()`, and export/import as a _present_ key.

That distinction is why `useSessionState` checks `has()` before seeding, instead of testing the value it reads back.

## Host code and the render tree meet on a key

Anything holding the session writes the cell; anything in the tree reading the same key re-renders. That is the cheapest route from a server-side result into the model's context — no props to thread, no provider to mount.

```tsx
import { Section } from "@agentick/compiler-react";
import { useSessionState } from "@agentick/state/react";
import type { SessionHarnessProtocol } from "@agentick/spec";

// An HTTP route, a queue worker, a tool handler — anywhere the session is in hand.
async function recordSearch(session: SessionHarnessProtocol, hits: number) {
  await session.state.set({ key: "search.lastHits", value: hits });
}

function SearchStatus() {
  const [lastHits] = useSessionState<number | null>("search.lastHits", null);
  if (lastHits === null) return null;
  return <Section id="search-status">Last search returned {lastHits} hits.</Section>;
}
```

Two components reading the same key share one cell for the same reason — write in one, the other re-renders.

## Durable values

Values are backed by a `Store` of `{ key, value }` cells; the synchronous read surface is a cache over it, so reads never await. The default store is in-memory. Inject an adapter and state outlives the process — `hydrate()` merges the store back into the read cache.

```ts
import { withState, createStateStore } from "@agentick/state";

const extension = withState({
  initial: { "draft.revisions": 0 }, // seed at construction
  store: createStateStore(), // swap for a durable adapter
});
```

`exportSnapshot()` / `importSnapshot()` round-trip the entries for hibernate and resume. `importSnapshot` is a wholesale replace: keys absent from the incoming record are dropped from both the cache and the store.

> [!WARNING]
> Values are stored as-is with no serialization contract. A function, a class instance, or a live handle is fine in-process and gone after a real snapshot round-trip. If it has to survive a restart, keep it JSON-shaped.

## Over the wire

Four verbs project onto the dynamic-command lane, deny-by-default like every sibling: `state/get`, `state/list`, `state/set`, `state/delete`. Importing `@agentick/state/client` registers `session.state` on the wire client:

```ts
import "@agentick/state/client";

const state = client.session(sessionId).state;

state.subscribe(() => render(state.list())); // zero-arg store contract
state.list(); // readonly StateListEntry[]
state.get("cursor"); // { key, value } | undefined — the row, not the bare value

await state.set("cursor", 4);
await state.delete("draft");
await state.refresh(); // force a re-poll
state.close();
```

**RPC-backed, not channel-backed.** There is no delta channel for state — it isn't model-visible, so nothing was already fanning its changes out. The read side is a poll: an eager `state/list` seeds the local snapshot and every mutation re-fetches it. `list()` and `get()` read that snapshot synchronously, which is what lets the handle drop straight into `useSyncExternalStore`.

`stateHandle(client, sessionId)` is the same handle as a free factory when you'd rather compose than rely on the registered slot.

## API

### `@agentick/state`

| Export                                   | Purpose                                                    |
| ---------------------------------------- | ---------------------------------------------------------- |
| `withState(options?)`                    | Session extension: `initial` seed entries, `store` backing |
| `StateHarness` / `StateHarnessOptions`   | The implementation, for direct construction                |
| `createStateStore()`                     | The bundled in-memory value store                          |
| `StateHandle` (type)                     | What `session.state` exposes                               |
| `StateEntry` / `StateStoreQuery` (types) | The stored `{ key, value }` cell and its (empty) query     |

### `session.state`

| Method                | Returns                                          |
| --------------------- | ------------------------------------------------ |
| `get(key)`            | `unknown` — the value, or `undefined`            |
| `has(key)`            | `boolean` — key membership, independent of value |
| `list()`              | `readonly StateListEntry[]` — `{ key, value }`   |
| `set({ key, value })` | `Promise<void>` — journaled write                |
| `delete({ key })`     | `Promise<void>` — journaled removal              |
| `subscribe(key, fn)`  | Fires when that key changes, deletes included    |
| `subscribeAll(fn)`    | Fires on any entry change                        |

On a `StateHarness` instance, additionally: `onChange(fn)` (typed `ChangeEvent` push — `set` yields add/update, `delete` yields remove), `exportSnapshot()` / `importSnapshot()`, and `hydrate()`.

### `@agentick/state/react`

| Export                             | Purpose                        |
| ---------------------------------- | ------------------------------ |
| `useSessionState<T>(key, initial)` | `readonly [T, (v: T) => void]` |

### `@agentick/state/client`

| Export                           | Purpose                                                                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------- |
| `session.state`                  | Registered on import: `list` / `get` / `set` / `delete` / `refresh` / `subscribe` / `close` |
| `stateHandle(client, sessionId)` | The same handle as a free factory                                                           |
| `StateClientHandle` (type)       | The handle contract                                                                         |

### `@agentick/state/testing`

| Export                       | Purpose                                      |
| ---------------------------- | -------------------------------------------- |
| `stubStateHarness(initial?)` | A real harness instance on its own substrate |
| `runStateHarnessConformance` | Certify an alternate implementation          |

## Patterns

**Model-visible instead?** [@agentick/knobs](../knobs) is this package plus descriptors, a validation pipeline, and a tool the model calls.

**Rendering.** [@agentick/compiler-react](../compiler-react) owns `<Section>`, `createTool`, and the bridge context `useSessionState` reads.

**Shapes.** [@agentick/spec](../spec) owns `StateListEntry`, `StateSetInput`, `StateDeleteInput`, and the `Store` seam a durable adapter implements.

**Client.** [@agentick/client-core](../client-core) owns the `ClientHandle` / `Enumerable` contracts and the session sub-handle registry the `/client` subpath registers into.

## Roadmap & known gaps

- **No live client mirror.** The client handle polls. State has no snapshot-plus-delta channel, so a UI bound to it updates after its own mutations, not when the session mutates a key on its own. The wire codec for such a channel has to encode a present-but-`undefined` value explicitly, or the key vanishes on apply.
- **No model-facing tools.** There are deliberately no `state_get` / `state_set` tools. Whether session state should ever get a model surface — and how that would relate to knobs — is an open policy question, not a missing feature.
- **`hydrate()` is not the resume path.** `importSnapshot` still owns session resume; `hydrate()` is tested and reachable but nothing calls it during restore yet.
- **`withState()` is not the construction site yet.** Sessions construct their state directly; the extension factory is correct but the wiring point still moves.

## Verified by

- `src/__tests__/harness.spec.ts` — `set` and `delete` emitting `requested → terminal` envelopes, inbox addressability for both verbs, the sync read surface, and snapshot round-trip.
- `src/__tests__/store-backing.spec.ts` — every `set` / `delete` / `importSnapshot` reaching the store, upsert on re-set, `hydrate()` rebuilding the read cache as a merge and pinging subscribers, `importSnapshot` dropping absent keys from both tiers, and the `undefined`-value round-trip staying a present key through write-through, hydrate, and export/import.
- `src/__tests__/change-stream.spec.ts` — the `onChange` seam: add vs update on `set`, remove on `delete`, nothing for a no-op delete, the presence-based discriminator (`set(undefined)` then `set(value)` reads as add then update), unsubscribe, and multiple projections on one stream.
- `src/__tests__/integration-with-compiler.spec.tsx` — against the real compiler: `useSessionState` seeding on first render, not overwriting an existing value on remount, surviving unmount → remount, and re-rendering on an external `set`.
- `src/client/__tests__/state-handle.spec.ts` + `session-state.spec.ts` — the eager `state/list` poll seeding `list()`/`get()`, each verb's request shape, fire-and-refetch after a mutation, `refresh()` resolving the fresh snapshot, the zero-arg `subscribe` contract, and `session.state` self-assembling on the client session handle.
- `src/conformance.ts` — `runStateHarnessConformance`: the protocol battery, including `list()` returning `{ key, value }` entries.
- [@agentick/transport-in-process](../transport-in-process) `src/__tests__/wire-reads-e2e.spec.ts` — `state/get`, `state/list`, and `state/set` round-tripping the real gateway and dynamic lane, enumerating via `commands/list`, with deny-by-default preserved.
