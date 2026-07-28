# @agentick/store

**The store is where data lives. A view is the synchronous working copy.** Everything in this package follows from that split: two in-memory store generics you parameterize instead of hand-rolling a `Map`, two projection primitives that give a harness sync reads over an async store, and one conformance skeleton every adapter delegates to.

The rule worth learning first: **a harness holds a view if and only if it has a synchronous read surface.** Reads served during a render pass cannot await, so those harnesses cache. A harness whose reads are all `async` reads the store live and holds no view at all — that is a deliberate posture, not an omission.

## Install

```bash
npm install @agentick/store
```

Subpaths: `.` (stores, views, decorators, `stubStoreCtx`) and `/testing` (the conformance skeleton, which imports `vitest` and so is deliberately unreachable from the main barrel).

## Quick start

Parameterizing `MemoryCollection` is how a keyed store gets its in-memory default. The only per-store code is a key accessor and a query predicate:

```ts
import { MemoryCollection, stubStoreCtx } from "@agentick/store";

interface Note {
  readonly id: string;
  readonly tag: string;
  readonly body: string;
}

const notes = new MemoryCollection<Note, { tag?: string }, number>({
  backend: "memory",
  keyOf: (n) => n.id,
  matchQuery: (n, q) => q?.tag === undefined || n.tag === q.tag,
  // Optional. Supplied ⇒ `notes.prune` exists; omitted ⇒ it genuinely doesn't.
  prunePredicate: (n, maxLength) => n.body.length > maxLength,
});

const ctx = stubStoreCtx();
await notes.put({ id: "n1", tag: "todo", body: "ship it" }, ctx);
await notes.get("n1", ctx); // the record
await notes.list({ tag: "todo" }, ctx); // a fresh array, filtered
await notes.delete("n1", ctx); // true — idempotent, reports prior existence
```

Every data method takes a `StoreCtx` as its final parameter. It carries the operation scope across the boundary between the Effect-shaped substrate and these Promise-shaped stores — `opId` for idempotency, `journalReader` and `asOf` for event sourcing, `signal` for cancellation. Pure in-memory stores accept it and ignore it; `stubStoreCtx()` is the canned one for tests.

## Two archetypes over one seam

`Store<T, Q, M>` is the universal seam, and it is small on purpose: read is always a **projection shaped by a query**, write is always a **mutation applied to the source**.

```ts
query(q: Q | undefined, ctx: StoreCtx): Promise<readonly T[]>;
mutate(m: M, ctx: StoreCtx): Promise<void>;
watch?(q: Q | undefined, ctx: StoreCtx): AsyncIterable<Change<T>>;
readonly backend: string;
```

Two profiles extend it with the ergonomics their shape earns, and each has a bundled in-memory default:

| Archetype      | Port                              | Mutation vocabulary               | Bundled default          |
| -------------- | --------------------------------- | --------------------------------- | ------------------------ |
| **Collection** | `CollectionStore<T, Q, PruneArg>` | `{ put } \| { delete }`           | `MemoryCollection<T, Q>` |
| **Log**        | `LogStore<T>`                     | `{ append: { logKey, entries } }` | `MemoryLog<T>`           |

The sugar is not a second contract. `MemoryCollection.query` delegates to `list`, and `mutate` delegates to `put` or `delete`, over the same `Map` — so a consumer written against the bare seam works against either profile.

> [!NOTE]
> The archetype ports live in [@agentick/spec](../spec) because they are cross-package contracts. The defaults and the conformance suite live here.

### The log side

`MemoryLog<T>` is append-only and payload-agnostic. `seq` is the frozen ordering identity: strictly increasing, never reused, and stable across `prune`.

```ts
import { MemoryLog, stubStoreCtx } from "@agentick/store";

const log = new MemoryLog<{ text: string }>();
const ctx = stubStoreCtx();

const seqs = await log.append("session-1", [{ text: "a" }, { text: "b" }], ctx); // [0, 1]
await log.read("session-1", ctx); // both entries, defensively copied
await log.history("session-1", { fromSeq: 1, limit: 10 }, ctx); // [{ seq: 1, entry }]
await log.history("session-1", { limit: 20 }, ctx); // the LAST 20 — the tail read
await log.keys(ctx); // ["session-1"] — only logs holding entries
await log.prune("session-1", { seq: 1 }, ctx); // 1 — erases below an ABSOLUTE seq
```

The window is `{ fromSeq?, toSeq?, limit? }`, both bounds inclusive, and `limit` truncates **from the end the query anchored at**: give a `fromSeq` and you get the first `limit` (forward paging); give none and you get the last `limit` at or below `toSeq`, defaulting to the log's tail. So `{ limit: 20 }` is the newest twenty and `{ fromSeq: 0, limit: 20 }` is the oldest twenty — one shape, both directions, and rows always come back ascending by `seq`.

Pruning advances the log's base so survivors keep their `seq` and the next append never reuses a retired one. There is deliberately **no bounding or eviction** here — a full array per log is the intended default, and how much history lives in RAM is a durable adapter's decision, not a framework mandate.

## `View` — the sync projection of a collection

`View` collapses three things every store-backed harness kept re-deriving: a synchronous read cache, write-through to the async store off the critical path, and two notification seams. Reactivity is opt-in — a view nobody subscribes to is a plain write-through cache.

For a pure mirror, `View.collection` prefills everything but the key accessor:

```ts
import { MemoryCollection, View, stubStoreCtx } from "@agentick/store";

interface Knob {
  readonly id: string;
  readonly value: unknown;
}

const store = new MemoryCollection<Knob, void>({
  backend: "memory",
  keyOf: (k) => k.id,
  matchQuery: () => true,
});
const view = View.collection(store, (k: Knob) => k.id);
const ctx = stubStoreCtx();

view.subscribe("verbose", () => rerender()); // render ping for one key
view.onChange((c) => console.log(c.key, c.value, c.prev)); // typed delta

view.write({ id: "verbose", value: true }, ctx); // cache set SYNCHRONOUSLY
view.getSync("verbose"); // already there — no await
await view.flush(); // the durability barrier
```

Two notification contracts, and the difference is load-bearing:

- **Single mutation** — `write` and `deleteSync` set the cache, kick the store write, ping the key, **and** emit a typed `{ key, value?, prev? }` change. These drive a harness's delta stream.
- **Bulk** — `replace` and `hydrate` mutate the whole cache first, then batch the render pings, and are **change-silent**. A wholesale replace means "everything became this set," which the harness's own aggregate snapshot frame says better than N spurious deltas. Batching also guarantees a subscriber reading during a ping sees the complete post-mutation state rather than a half-applied cache.

Add-versus-update rides cache **presence**, never `value !== undefined` — so a record whose stored value legitimately _is_ `undefined` still classifies as an add on first write.

### When the cache value isn't the stored record

The cache holds `TCache`; the store holds `TStore`. A pure mirror sets them equal. A **fused** view caches the persisted slice _plus_ live-only handles that must never round-trip through a store — an `AbortController`, a per-item event bus, a result deferred:

```ts
import { View, type ViewConfig } from "@agentick/store";

interface StoredTask {
  readonly id: string;
  readonly status: string;
}
interface LiveTask extends StoredTask {
  readonly abort: AbortController; // never persisted
}

const cfg: ViewConfig<LiveTask, StoredTask, void, { put: StoredTask } | { delete: string }> = {
  store: taskStore,
  keyOf: (t) => t.id,
  project: ({ id, status }) => ({ id, status }), // strips the handle on every write
  reconstruct: (r) => ({ ...r, abort: new AbortController() }), // rebuilds it on hydrate
  toPut: (record) => ({ put: record }),
  toDelete: (key) => ({ delete: key }),
};
const tasks = new View(cfg);
```

Sync reads always traffic in `TCache`; the store only ever sees `TStore`. `seedSync(item)` adopts a cache value whose record **came from** the store — resume, orphan accounting — with no store write and no change emit, because re-persisting it would be redundant and a delta would double-count it. Pass `{ ping: true }` when the adopt should still trigger a re-render.

`hydrate` needs `reconstruct` and throws a clear error if the view was built without one.

### The durability barrier

Store writes are fire-and-forget on the hot path so a durable-write failure can never crash a mutation whose read path already reflects it. But they are **tracked**, not swallowed: `flush()` awaits every pending write and surfaces the first latched failure, then clears it. That is the seam a graceful shutdown or hibernate needs. It's a no-op against the in-memory default, where writes settle synchronously.

## `LogView` — the sync projection of a log

`LogView : LogStore :: View : CollectionStore`. It owns the two-tier storage, version counters, identity-stable render snapshot, and write-behind pump that a log-backed harness would otherwise hand-roll.

```ts
import { LogView, MemoryLog, stubStoreCtx } from "@agentick/store";

class WriteFailed extends Error {}

const view = new LogView<{ text: string }>({
  store: new MemoryLog<{ text: string }>(),
  logKey: "session-1", // the partition this view projects
  writePolicy: "behind", // memory-authoritative; durability at flush()
  wrapWriteError: (cause) => new WriteFailed(String(cause)),
});

const ctx = stubStoreCtx();
await view.append([{ text: "hello" }], ctx); // both tiers update synchronously
view.read(); // the projection tier
view.readPersisted(); // the durable log tier
view.snapshot(); // { entries, version } — stable identity until a mutation

view.replaceProjection([{ text: "…compacted…" }], {
  at: Date.now(),
  source: "persisted",
  entriesBefore: 1,
  entriesAfter: 1,
});
view.resetProjection(); // re-mirror the durable log
await view.flush(); // throws the wrapped error if a buffered write failed
```

The two tiers are the point. **persisted** is append-only ground truth that only `append` mutates. **projection** is the read surface, normally a live mirror, which `replaceProjection` diverges — that's the compaction target. Appends land at the tail of both, giving the natural "compacted prefix plus recent" shape, and the durable log is never rewritten by a projection mutation.

`writePolicy` picks the tradeoff. Under `"behind"`, appends buffer and a single-flight pump drains off the critical path; **the pump never rejects** — a failed batch latches into an error that only `flush()` surfaces, so an un-awaited pump can't become an unhandled rejection. The latched error is left set: a view that has diverged from its store cannot silently recover. Under `"through"`, each append awaits the store inline and rejects with the same wrapped error.

`exportSnapshot()` / `importSnapshot()` round-trip both tiers, both version counters, and the last-compaction provenance. Import takes `mode: "as-is"` (trust the snapshot's projection verbatim) or `"reset-projection"` (restore only the durable log and re-mirror).

## Observing a store you don't exclusively own

`MemoryCollection.onChange` is the cross-consumer observation seam — synchronous, in registration order, error-isolated so one throwing listener never breaks the write or a sibling:

```ts
const stop = notes.onChange(({ key, value, prev }) => {
  if (value === undefined) console.log("removed", key, prev);
  else console.log(prev === undefined ? "added" : "updated", key, value);
});
```

`put` always fires. `delete` fires only when the key existed — a no-op delete is not a change.

It earns its keep when a store is **shared** across consumers, or when a durable backend surfaces changes this process did not originate: a sibling process editing a keychain, an operator pushing to KV. A harness that owns its store privately and is the only writer already knows what it changed, and deliberately does not subscribe — a listener-less `onChange` costs nothing.

## Two decorators

**`idempotentWrite(store)`** dedups retried writes on `ctx.opId`. The same operation retried — a redelivered inbox message, a client resend, a crash-recovery replay — carries the same `opId`, which makes it the natural idempotency key. Reads never dedup, and a write with no `opId` is never deduped because there is nothing to key on:

```ts
import { idempotentWrite } from "@agentick/store";

const durable = idempotentWrite(notes); // backend becomes "memory+idempotent"
```

This earns its keep at the durable, cross-process edge. The bundled in-memory defaults deliberately don't dedup: they are single-writer and last-write-wins, so a repeated in-process `put` just re-sets the same cell.

**`JournalProjectedStore`** is the reference event-sourced collection: it holds no `Map` at all. Every read folds the operation journal — the append-only record a harness already writes — into projected records on demand.

```ts
import { JournalProjectedStore } from "@agentick/store";

const projected = new JournalProjectedStore<Note, void>({
  scopeQuery: () => ({ surface: "session" }), // which events belong to this projection
  fold: (events) => events.map(toNote), // the store's entire interpretation
  keyOf: (n) => n.id,
});
```

Its writes are no-ops, and that is the honest shape rather than a gap: an event-sourced store's writes _are_ the journaled operations, appended through the harness before the store ever sees a call. A projection cannot forge the log it projects. `ctx.asOf` bounds the fold — omitted or `"latest"` gives current state, `{ offset: N }` time-travels to an earlier cursor, `"beginning"` gives the empty prehistory.

## Certifying an adapter

`runStoreConformance` holds the three behaviors that are genuinely archetype-independent: `backend` is a stable non-empty identifier, reading an unknown key yields the archetype's empty value, and deleting an absent key is idempotent. Everything shape-specific registers through `cases`, which runs inside the same `describe` so its assertions nest under the suite heading.

```ts
import { runStoreConformance } from "@agentick/store/testing";
import { MemoryCollection, stubStoreCtx } from "@agentick/store";
import { expect, it } from "vitest";

runStoreConformance<MemoryCollection<Note, { tag?: string }>>({
  label: "MemoryCollection<Note>",
  factory: () =>
    new MemoryCollection<Note, { tag?: string }>({
      backend: "memory",
      keyOf: (n) => n.id,
      matchQuery: () => true,
    }),
  emptyRead: { read: (s, k) => s.get(k, stubStoreCtx()), expected: undefined },
  idempotentDelete: (s, k) => s.delete(k, stubStoreCtx()),
  cases: ({ setup }) => {
    it("put then get round-trips", async () => {
      const store = await setup();
      const ctx = stubStoreCtx();
      await store.put({ id: "n1", tag: "todo", body: "b" }, ctx);
      expect(await store.get("n1", ctx)).toMatchObject({ id: "n1" });
    });
  },
});
```

Because the probes are closures, they accommodate shapes the skeleton knows nothing about: a log store passes `expected: []` instead of `undefined`, and a composite-keyed store reads through a closure that assembles its key. Pass `skip: true` — computed at the call site — to register the suite as skipped when a backend is absent from the environment, without ever constructing a store.

## API

### `@agentick/store`

| Export                                                                                                   | Purpose                                                                                  |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `MemoryCollection<T, Q, PruneArg>`                                                                       | In-memory collection store. Config: `backend`, `keyOf`, `matchQuery`, `prunePredicate?`. |
| `MemoryLog<T>`                                                                                           | In-memory append-only log. Config: `backend?` (default `"memory"`).                      |
| `View<TCache, TStore, Q, M>`                                                                             | Sync projection of a `Store`, plus the `View.collection` pure-mirror factory.            |
| `LogView<T>`                                                                                             | Sync projection of a `LogStore`: two tiers, versions, write-behind pump.                 |
| `IdempotentCollectionStore` / `idempotentWrite`                                                          | Decorator deduping retried writes on `ctx.opId`.                                         |
| `JournalProjectedStore`                                                                                  | Reference event-sourced store: reads fold the journal, writes are no-ops.                |
| `stubStoreCtx(overrides?)`                                                                               | A minimal `StoreCtx` for tests and conformance.                                          |
| `MemoryCollectionConfig` / `MemoryLogConfig` / `ViewConfig` / `LogViewConfig` / `JournalProjectedConfig` | Construction types.                                                                      |
| `CollectionChangeEvent<T>`                                                                               | The `onChange` delta, `{ key, value?, prev? }`.                                          |
| `LogViewSnapshot` / `LogViewReadSnapshot` / `LogProjectionMeta` / `LogViewImportMode`                    | `LogView` data types.                                                                    |

### `MemoryCollection`

| Member                             | Returns                                          |
| ---------------------------------- | ------------------------------------------------ |
| `put(item, ctx)`                   | Upsert keyed by `keyOf`; always fires `onChange` |
| `get(key, ctx)`                    | The record, or `undefined`                       |
| `list(query \| undefined, ctx)`    | A **fresh array** filtered by `matchQuery`       |
| `delete(key, ctx)`                 | `boolean` — whether the key existed; idempotent  |
| `prune?(arg, ctx)`                 | Present only when `prunePredicate` was supplied  |
| `query(q, ctx)` / `mutate(m, ctx)` | The seam, delegating to `list` / `put`+`delete`  |
| `onChange(listener)`               | `Unsubscribe`                                    |
| `backend`                          | The configured label                             |

### `MemoryLog`

| Member                             | Returns                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `append(logKey, entries, ctx)`     | The assigned `seq[]`; `[]` for an empty batch           |
| `read(logKey, ctx)`                | Full ordered read, defensively copied; `[]` when absent |
| `history(logKey, opts, ctx)`       | `SeqTagged<T>[]` for `{ fromSeq?, toSeq?, limit? }`     |
| `keys(ctx)`                        | Log keys currently holding entries                      |
| `delete(logKey, ctx)`              | `boolean`; ends that log's `seq` run                    |
| `prune(logKey, { seq }, ctx)`      | Count erased below an **absolute** `seq`                |
| `query(q, ctx)` / `mutate(m, ctx)` | The seam over `LogQuery` / `LogMutation`                |

### `View`

| Member                                                    | Behavior                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `View.collection(store, keyOf)`                           | Pure-mirror factory; `project`/`reconstruct` are identity    |
| `new View(config)`                                        | Full config, including `project` and optional `reconstruct`  |
| `getSync(key)` / `hasSync(key)` / `listSync()`            | Sync reads; never touch the store                            |
| `write(item, ctx)`                                        | Cache → store → ping + typed change                          |
| `deleteSync(key, ctx)`                                    | `boolean`; idempotent; emits a removal on a real delete      |
| `replace(items, ctx)`                                     | Bulk; cache-first, batched pings, **change-silent**          |
| `hydrate(q, ctx)`                                         | Merges `store.query`; returns loaded keys; **change-silent** |
| `seedSync(item, opts?)`                                   | Cache-only adopt: no store write, no change; `{ ping? }`     |
| `subscribe(key, fn)` / `subscribeAll(fn)` / `notify(key)` | The render-ping seam                                         |
| `onChange(fn)`                                            | The typed delta seam                                         |
| `flush()`                                                 | Awaits pending writes; throws then clears a latched failure  |

### `LogView`

| Member                                          | Behavior                                                     |
| ----------------------------------------------- | ------------------------------------------------------------ |
| `append(entries, ctx)`                          | Both tiers synchronously, then per `writePolicy`             |
| `read()` / `readPersisted()`                    | The projection tier / the durable log tier                   |
| `snapshot()`                                    | `{ entries, version }`, identity-stable until a mutation     |
| `subscribe(fn)`                                 | Keyless render pings                                         |
| `replaceProjection(entries, meta?)`             | Compaction target — projection tier only                     |
| `resetProjection()`                             | Re-mirror the durable log; clears provenance                 |
| `hydrate(ctx)`                                  | Load the durable log into both tiers (resume)                |
| `flush()`                                       | Write-behind barrier; throws the wrapped error, left latched |
| `exportSnapshot()` / `importSnapshot(s, opts?)` | Both tiers, versions, provenance                             |

### `@agentick/store/testing`

| Export                                                                      | Purpose                                                                                                                        |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `runStoreConformance(options)`                                              | The shared skeleton. Required: `label`, `factory`, `emptyRead`, `idempotentDelete`. Optional: `skip`, `capabilities`, `cases`. |
| `StoreConformanceOptions` / `StoreConformanceContext` / `StoreCapabilities` | Its types.                                                                                                                     |

## Patterns

**Ports in spec, defaults here.** [@agentick/spec](../spec) owns `Store`, `CollectionStore`, `LogStore`, `StoreCtx`, and the mutation and query shapes. A durable adapter imports the port from spec, the conformance skeleton from `/testing`, and the richer per-harness suite from the harness that owns the port refinement.

**Notification primitives.** [@agentick/pubsub](../pubsub) owns `KeyedNotifier`, `ChangeNotifier`, and `Notifier`. The views compose them rather than re-deriving a `Set` plus a try/catch fan-out loop.

**Log-backed harnesses.** [@agentick/timeline](../timeline) holds a `LogView` and keeps only its domain logic — turn boundaries, compaction strategies, declared commands. Its durable adapters are [@agentick/timeline-fs](../timeline-fs) and [@agentick/timeline-postgres](../timeline-postgres).

**Collection-backed harnesses.** [@agentick/tasks](../tasks) is the fused case, caching live handles alongside persisted records. [@agentick/knobs](../knobs), [@agentick/state](../state), [@agentick/skills](../skills), and [@agentick/prompts](../prompts) are pure mirrors built through `View.collection`. [@agentick/credentials](../credentials) is the deliberate no-view case: its reads are all async, so it reads the store live.

## Roadmap & known gaps

- **`onChange` does not fire on `prune`.** Bulk eviction is silent. No shared-store consumer needs to observe it yet, and emitting a removal per dropped record would be a real cost for a use case nobody has.
- **`idempotentWrite` dedups on `opId` alone.** One operation that both puts and deletes is out of scope for this reference — the second mutation short-circuits. Documented rather than over-engineered.
- **`IdempotentCollectionStore` remembers every `opId` for process life.** The set is unbounded in memory. Fine for the demonstration; a durable adapter needs its own eviction.
- **`JournalProjectedStore` bounds `asOf` by stream prefix, not journal offset.** The journal's read exposes a lower bound only, and its events carry no absolute offset, so this reference applies `asOf` as "the first N matched events." That is exact when the scope query is no sparser than the offset space it bounds — the common single-scope case. An offset-indexed durable projector would bound differently.
- **`watch` has no bundled implementation.** The optional reactivity member on `Store` is unimplemented by every store here; observation goes through `onChange` on the collection default instead.
- **`runStoreConformance` covers three cases.** It is a skeleton, not a certification. The archetype-specific behavior that actually matters — upsert semantics, query filtering, append ordering, `seq` monotonicity, prune bounds — lives in each owning package's suite.

## Verified by

- `src/__tests__/memory-collection.spec.ts` — upsert and round-trip, unknown-key `undefined`, query filtering, fresh-array `list`, delete reporting prior existence, `prune` presence as a capability signal and its predicate selection; and the full `onChange` seam: insert and overwrite deltas, removal carrying `prev`, silence on a no-op delete and on `prune`, unsubscribe, listener-error isolation, registration-order fan-out.
- `src/__tests__/memory-log.spec.ts` — append ordering and one `seq` per entry strictly increasing and never reused, empty-batch no-op, defensive-copy reads, per-log isolation, `keys` enumerating only non-empty logs, idempotent `delete`, configurable backend, `history` paging by inclusive `fromSeq` plus `limit`, the inclusive `toSeq` upper bound and the tail anchor (a bare `limit` reads the last n, and the seam query carries the same window), and `prune` by absolute `seq` including that a pruned-to-empty log does not restart its counter.
- `src/__tests__/view.spec.ts` — sync reads reflecting a write with no await, keyed and wildcard pings, add-then-update by cache presence, `undefined`-value classification, idempotent `deleteSync`, change-silent `hydrate` overlay and `replace` union-ping, the fused case (write persists only the projected record, `seedSync` writes no store and emits no change, `seedSync` pings only with `{ ping: true }`, `hydrate` reconstructs wrappers and throws without `reconstruct`), the `flush` barrier awaiting a deferred write and surfacing then clearing a failure, and that a view drives a store implementing **only** `query`/`mutate`.
- `src/__tests__/log-view.spec.ts` — both tiers and both versions advancing on append, subscriber pings, snapshot reference stability until mutation, write-behind memory authority with the store landing at `flush` (and `flush` idempotent, and a failed batch surfacing the wrapped error left latched), write-through durability without an explicit flush and rejecting `append` on failure, `replaceProjection` leaving `persisted` untouched, `resetProjection` re-mirroring and clearing provenance, `hydrate` replacing both tiers, and export/import round-trips in both modes.
- `src/__tests__/idempotent-write.spec.ts` — one effect for a repeated `opId`, distinct `opId`s each passing through, an absent `opId` never deduped, `delete` deduping too, reads never deduped, and the composed backend label.
- `src/__tests__/journal-projected.spec.ts` — `list` folding the journal while holding no `Map`, `get` picking one folded record, `asOf` time-travel on both, writes as no-ops, and a clear throw when no `journalReader` was threaded.
- End-to-end proof that these generics back real harnesses lives with those harnesses: [@agentick/tasks](../tasks) and [@agentick/timeline](../timeline) run their own store conformance suites through this skeleton, and the suites in [@agentick/timeline](../timeline) exercise `LogView` under append ordering, write-behind flush, compaction never touching the store, and kill-and-resume.
