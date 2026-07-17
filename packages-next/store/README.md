# @agentick/store-next

Generic **store substrate** for Agentick v2 — the reusable in-memory
collection-store generic and the shared conformance skeleton every store-backed
harness parameterizes instead of hand-rolling a `Map`.

`@agentick/store-next` is the "conform, don't reinvent" package for the
**collection** store archetype (data-layer plan §2.1/§2.2). A store-backed
harness gets its default backing by parameterizing one generic; a store adapter
proves itself by delegating to one conformance suite. The archetype **port**
shapes (`CollectionStore<T, Q>`) live in `@agentick/spec-next` (the cross-package
contract) — the defaults and conformance live here.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## Purpose

Before this package, every store-backed harness reinvented the same three
things: a `Map<key, record>`, a bespoke `scopeMatches`/filter loop, and a
copy-pasted conformance suite. This package factors all three out:

- **`MemoryCollection<T, Q, PruneArg>`** — a `Map`-backed generic that fully
  backs `InMemoryTaskStore` and is the target for credentials / knobs / state /
  session. The only per-store code is a `keyOf` accessor and a `matchQuery`
  predicate.
- **`runStoreConformance`** — the shared conformance skeleton the per-store
  suites (`runTaskStoreConformance`, `runTimelineStoreConformance`) delegate
  their store-agnostic cases to (backend-id stable + non-empty; unknown-key →
  empty; delete idempotent).

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
| `backend`                       | The configured backend label                                        |

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
- **No supertype `Store`.** Two structural archetypes (log = `EventLog` /
  `TimelineStore`; collection = `CollectionStore`) sharing characteristics, not
  a nominal base class.
- **`prune` presence is a capability signal.** Omit `prunePredicate` and the
  method is genuinely absent, so `typeof store.prune === "function"` — the
  conformance capability gate — reads correctly.

## Status

Landed in the data-layer store-substrate "run #1" (tasks as the crucible). The
task store is refactored onto `MemoryCollection`; `runTaskStoreConformance`
delegates its store-agnostic cases to `runStoreConformance`.

## Roadmap & known gaps

- `MemoryLog<T>` (the **log** archetype generic) is not yet extracted here —
  the timeline store still ships its own `MemoryTimelineStore`. Extracting it
  and having `runTimelineStoreConformance` delegate to `runStoreConformance` is
  the next run. <!-- TODO(store-phase-2): extract MemoryLog + delegate timeline conformance. -->
- `StoreCtx` (`{ journal, scope, principal, signal, asOf }`) is not threaded
  into store methods yet (data-layer plan §2.4) — the pure in-memory stores
  don't need it. Threading it (and the journal-derived reference store) is a
  later phase. <!-- TODO(store-phase-2): thread StoreCtx once the journal seam lands. -->
- `onChange` fan-out (free-for-all via the generic, plan §2.2) is not yet
  provided — credentials still hand-rolls its listener set. <!-- TODO(store-phase-3): add optional onChange to MemoryCollection. -->

## Verified by

- `src/__tests__/memory-collection.spec.ts` — the generic's put/get/list/delete/
  prune behavior, fresh-array `list`, prune-presence-as-capability, and the
  shared skeleton driven against a throwaway record type.
- `@agentick/tasks-next` `runTaskStoreConformance` (`src/__tests__/store.spec.ts`)
  — end-to-end proof `MemoryCollection` fully backs a real `TaskStore`.
