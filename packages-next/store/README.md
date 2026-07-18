# @agentick/store-next

Generic **store substrate** for Agentick v2 — the reusable in-memory store
generics (both archetypes) and the shared conformance skeleton every
store-backed harness parameterizes instead of hand-rolling a `Map`.

`@agentick/store-next` is the "conform, don't reinvent" package for **both**
store archetypes (data-layer plan §2.1/§2.2): the **collection** (keyed upsert,
queryable) and the **log** (append-only, ordered, cursored). A store-backed
harness gets its default backing by parameterizing one generic; a store adapter
proves itself by delegating to one conformance suite. The archetype **port**
shapes (`CollectionStore<T, Q>`, `LogStore<T>`) live in `@agentick/spec-next`
(the cross-package contract) — the defaults and conformance live here.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## Purpose

Before this package, every store-backed harness reinvented the same three
things: a `Map<key, record>`, a bespoke `scopeMatches`/filter loop, and a
copy-pasted conformance suite. This package factors all three out:

- **`MemoryCollection<T, Q, PruneArg>`** — a `Map`-backed generic that fully
  backs `InMemoryTaskStore`, `inMemoryCredentialsStore`, and is the target for
  knobs / state / session. The only per-store code is a `keyOf` accessor and a
  `matchQuery` predicate. Exposes an optional **`onChange`** shared-store
  observation seam (below).
- **`MemoryLog<T>`** — the **log**-archetype sibling: a `Map`-of-`{ entries,
  baseSeq }` generic that fully backs `MemoryTimelineStore` (`T =
  TimelineEntry`). Append→`seq`, cursored `history`, `keys` enumerate,
  prune-by-absolute-seq, defensive-copy read — payload-agnostic over `T`. A
  **full in-memory array per log is the intended default** (no bounding /
  eviction — that is a durable adapter's concern, data-layer plan §2.7); the
  only per-store knob is the `backend` label.
- **`CollectionProjection<T, Q, PruneArg>`** — the synchronous read-model over
  an async `CollectionStore`: sync cache + write-through + hydrate. The
  primitive that fell out of runs #1 (tasks) and #2 (knobs) — a store-backed
  harness whose protocol reads are **synchronous** (served during render)
  composes this instead of re-deriving the projection + dual-write by hand.
  Async-only, never-rendered harnesses (credentials) read the store live and
  need NO projection — the projection rule is conditional on render-read.
- **`runStoreConformance`** — the shared conformance skeleton the per-store
  suites (`runTaskStoreConformance`, `runTimelineStoreConformance`,
  `runCredentialsStoreConformance`) delegate their store-agnostic cases to
  (backend-id stable + non-empty; unknown-key → empty; delete idempotent). The
  KV `(namespace, key)` credentials store proves the probes accommodate keyed
  values via read/delete closures, not just single-key collections; the timeline
  store proves they work for the **log** archetype too — its empty-read value is
  `[]` (not the collection's `undefined`), passed through the same `emptyRead`
  closure.

## Quick Start

Parameterize the generic to get a store-backed harness's in-memory default:

```ts
import { MemoryCollection } from "@agentick/store-next";
import { matchesScope } from "@agentick/utils-next";

const store = new MemoryCollection<TaskRecord, TaskStoreQuery, number>({
  backend: "memory",
  keyOf: (r) => r.taskId,
  matchQuery: (r, q) => {
    if (q === undefined) return true;
    if (q.scope !== undefined && !matchesScope(q.scope, r.scope)) return false;
    return statusMatches(r, q);
  },
  // Optional — present ⇒ `store.prune` exists; absent ⇒ it doesn't.
  prunePredicate: (r, before) => isTerminal(r) && r.updatedAt < before,
});
```

Delegate the store-agnostic conformance cases and add your shape-specific ones:

```ts
import { runStoreConformance } from "@agentick/store-next";

runStoreConformance<TaskStore>({
  label: "InMemoryTaskStore",
  factory: () => new InMemoryTaskStore(),
  emptyRead: { read: (s, k) => s.get(k), expected: undefined },
  idempotentDelete: (s, k) => s.delete(k),
  cases: ({ setup }) => {
    it("put then get round-trips", async () => {
      /* store-specific assertions */
    });
  },
});
```

## API

### `MemoryCollection<T, Q, PruneArg = never>` implements `CollectionStore<T, Q, PruneArg>`

| Member                          | Behavior                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `new MemoryCollection(config)`  | `config`: `{ backend, keyOf, matchQuery, prunePredicate? }`          |
| `put(item)`                     | Upsert keyed by `keyOf(item)` — a later `put` replaces              |
| `get(key)`                      | Read one; `undefined` when absent                                   |
| `list(query?)`                  | Filter by `matchQuery`; returns a **fresh array** each call         |
| `delete(key)`                   | Idempotent; returns whether the key existed                         |
| `prune?(arg)`                   | Present only when `prunePredicate` given; drops predicate-selected  |
| `onChange(listener)`            | Subscribe to `put`/`delete` deltas; returns unsubscribe (below)     |
| `backend`                       | The configured backend label                                        |

#### `onChange` — the shared-store observation seam

`onChange(listener)` observes changes to the (possibly **shared**) store and
returns an unsubscribe function. It fires a `CollectionChangeEvent<T>`
(`{ key, value?, prev? }`, the canonical `@agentick/pubsub-next` `ChangeEvent`)
synchronously, in registration order, error-isolated (one throwing listener
never breaks the write or a sibling):

- **`put`** always fires — `{ key, value }` on insert, `{ key, value, prev }` on
  overwrite.
- **`delete`** fires ONLY when the key existed — `{ key, prev }`. A no-op delete
  is not a change.
- **`prune`** does not fire today (no shared-store consumer needs bulk-eviction
  observation yet — see the `TODO(store-phase-4)` marker).

This is the **cross-consumer / external-observation** seam — distinct from a
single harness's self-caused change stream. A harness that owns its store
privately and is the only writer already knows what it changed and does not
subscribe (knobs, behind a private `CollectionProjection`, deliberately does
not — a listener-less `onChange` is a no-op cost). `onChange` earns its keep
when a store is shared OR a durable backend surfaces changes the process did not
originate. `inMemoryCredentialsStore` is its first real consumer, forwarding
these into the credentials harness fan-out. It composes the canonical
`ChangeNotifier` notify seam rather than re-deriving a `Set` + try/catch loop.

### `MemoryLog<T>` implements `LogStore<T>`

The **log**-archetype default backing — an in-process append-only log per
`logKey`, payload-agnostic over `T`. Binds trivially to a concrete entry type
(`MemoryTimelineStore extends MemoryLog<TimelineEntry>` is an empty subclass —
timeline needs nothing the generic doesn't provide).

| Member                          | Behavior                                                             |
| ------------------------------- | ------------------------------------------------------------------- |
| `new MemoryLog(config?)`        | `config`: `{ backend? }` — backend label, defaults to `"memory"`   |
| `append(logKey, entries)`       | Append in order; returns the assigned `seq[]` (strictly increasing) |
| `read(logKey)`                  | Full ordered read; `[]` when absent; **defensive copy** each call   |
| `history?(logKey, opts?)`       | Cursored seq-tagged read: `{ fromSeq?, limit? }` → `SeqTagged<T>[]`  |
| `keys()`                        | Enumerate log keys that hold entries (foundational enumerate verb)   |
| `delete(logKey)`                | Idempotent; returns whether entries were removed; ends the `seq` run |
| `prune?(logKey, { seq })`       | Erase entries below an ABSOLUTE `seq`; survivors keep their `seq`    |
| `backend`                       | The configured backend label                                        |

The frozen `seq` contract (strictly increasing, never reused, stable across
`prune`) is tracked as `baseSeq + index`; `baseSeq` advances on `prune` so a
pruned-empty log's next append never reuses a retired `seq`. **No memory
strategy is legislated** — a full array is the intended default; a durable
adapter picks differently behind the same `LogStore` port.

### `CollectionProjection<T, Q = unknown, PruneArg = never>`

The synchronous read-model over an async `CollectionStore` — exactly three
things: a sync read cache, write-through, and hydrate. A store-backed harness
whose protocol reads must be **synchronous** (served during render) composes
this instead of hand-rolling a `Map` projection kept in lockstep with the store.

| Member                        | Behavior                                                              |
| ----------------------------- | -------------------------------------------------------------------- |
| `new CollectionProjection(store, keyOf)` | Wrap an async `CollectionStore` with a sync read-model    |
| `getSync(key)`                | Read the cache; NEVER touches the store                              |
| `hasSync(key)`                | Presence in the cache                                                |
| `listSync()`                  | Fresh array of every cached record                                   |
| `write(item)`                 | Set cache synchronously, then fire-and-forget `store.put` off-path   |
| `deleteSync(key)`             | Drop from cache synchronously, then fire-and-forget `store.delete`   |
| `hydrate(query?)`             | Load `store.list()` into the cache as an OVERLAY; returns loaded keys |

Deliberately NOT owned here: change-notification, the substrate channel, list
invalidation, layer chains — all harness-specific. This is a **write sink** that
sits beside the harness's notify seam, never a source of it (`hydrate` returns
changed keys so the harness fires its own notifications).

**When you do NOT need it.** Async-only, never-rendered harnesses read the store
LIVE and hold no projection — credentials is the deliberate counter-example
(`get`/`has`/`keys` each `await` the store directly). "Store-backed harness ⟹
projection" is conditional on render-read, not universal.

### `runStoreConformance<S>(options)`

| Option             | Purpose                                                              |
| ------------------ | ------------------------------------------------------------------- |
| `label`            | `describe` heading                                                   |
| `factory`          | Fresh, isolated store per test                                       |
| `skip?`            | Register the suite as skipped (backend absent in env)               |
| `capabilities?`    | `{ prune? }` — forwarded to `cases`                                  |
| `emptyRead?`       | `{ read, expected, key? }` — unknown-key → empty-value probe        |
| `idempotentDelete?`| `(store, key) => Promise` — delete-absent-twice probe               |
| `cases?`           | `(ctx) => void` — register shape-specific `it`s under the describe  |

## Patterns

- **Port in spec, default + conformance in the substrate.** `CollectionStore`
  is a `@agentick/spec-next` type; the generic and the suite are here. A durable
  adapter (Postgres, …) imports the port from spec and the conformance from the
  owning harness package.
- **No supertype `Store`.** Two structural archetypes (log = `LogStore<T>` /
  `MemoryLog`; collection = `CollectionStore` / `MemoryCollection`) sharing
  characteristics — `backend`, an enumerate verb, optional `prune`, a
  conformance suite — not a nominal base class. (`EventLog<E>` in spec is the
  Effect-flavored *substrate* log — bus / journal — a different beast from the
  Promise-shaped `LogStore` adopter store.)
- **`prune` presence is a capability signal.** Omit `prunePredicate` and the
  method is genuinely absent, so `typeof store.prune === "function"` — the
  conformance capability gate — reads correctly.

## Status

Landed across the data-layer store-substrate runs:

- **Run #1 (tasks)** — `MemoryCollection` + `runStoreConformance` extracted; the
  task store refactored onto the generic; `runTaskStoreConformance` delegates
  its store-agnostic cases.
- **Run #2 / 2.5 (knobs)** — `CollectionProjection` extracted (the sync
  read-model + write-through + hydrate that both tasks and knobs hand-rolled).
- **Run #3 (credentials)** — `MemoryCollection.onChange` (the shared-store
  observation seam) landed with `inMemoryCredentialsStore` as its first
  consumer; that store now composes `MemoryCollection` (composite `(namespace,
  key)` addressing) instead of a hand-rolled `Map` + listener set, and
  `runCredentialsStoreConformance` delegates its store-agnostic trio to
  `runStoreConformance` via KV closures.
- **Run #6 (timeline)** — `MemoryLog<T>` extracted (the **log**-archetype
  generic); `MemoryTimelineStore` collapses to an empty
  `extends MemoryLog<TimelineEntry>` subclass, the `LogStore<T>` port lands in
  spec-next (`TimelineStore extends LogStore<TimelineEntry>`, port-home §6-D),
  and `runTimelineStoreConformance` delegates its store-agnostic trio to
  `runStoreConformance` — proving the shared skeleton generalizes to the **log**
  archetype (empty-read `[]`), the first non-collection to meet it.

## Roadmap & known gaps

- `StoreCtx` (`{ journal, scope, principal, signal, asOf }`) is not threaded
  into store methods yet (data-layer plan §2.4) — the pure in-memory stores
  don't need it. Threading it (and the journal-derived reference store) is a
  later phase. <!-- TODO(store-phase-2): thread StoreCtx once the journal seam lands. -->
- `MemoryCollection.onChange` does NOT yet fire on `prune` — no shared-store
  consumer needs bulk-eviction observation yet. <!-- TODO(store-phase-4): emit per-key removal onChange from prune when a shared store needs it. -->

## Verified by

- `src/__tests__/memory-collection.spec.ts` — the generic's put/get/list/delete/
  prune behavior, fresh-array `list`, prune-presence-as-capability, the shared
  skeleton driven against a throwaway record type, and the `onChange`
  seam (put insert/overwrite deltas, delete `prev`, no-op-delete and prune
  silence, unsubscribe, listener-error isolation, registration-order fan-out).
- `src/__tests__/memory-log.spec.ts` — the log generic's append→seq / read /
  history-paging / keys / delete / prune-by-absolute-seq behavior, defensive-copy
  read, per-log isolation, configurable backend, and the shared skeleton driven
  against the LOG archetype (empty-read `[]`).
- `src/__tests__/collection-projection.spec.ts` — the sync read-model: sync
  reads never touch the store, write-through, and hydrate-as-overlay returning
  loaded keys.
- `@agentick/tasks-next` `runTaskStoreConformance` (`src/__tests__/store.spec.ts`)
  — end-to-end proof `MemoryCollection` fully backs a real `TaskStore`.
- `@agentick/credentials-next` `runCredentialsStoreConformance`
  (`src/__tests__/conformance.spec.ts`) — end-to-end proof `MemoryCollection`
  backs a composite-keyed KV credentials store AND that `runStoreConformance`'s
  probes accommodate the KV shape via closures.
- `@agentick/timeline-next` `runTimelineStoreConformance`
  (`src/__tests__/store.spec.ts`) — end-to-end proof `MemoryLog` fully backs a
  real `TimelineStore` AND that `runStoreConformance`'s probes accommodate the
  LOG archetype (empty-read `[]`) via closures.
