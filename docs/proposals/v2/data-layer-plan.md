# v2 Data Layer / Store Substrate — Plan of Attack

**Status: LOCKED (shape + algorithm) — EXECUTING the run list.** Committed: tasks
✓, knobs ✓, `CollectionProjection` ✓; credentials in flight. The load-bearing
forks are resolved (§6); the §3.5 Playbook (P0–P9) is the ratified per-harness
algorithm, refined against each entity as we go. Remaining: state, session,
timeline, prompts/skills/resources, then Phase-2 (`StoreCtx`/journal) + Phase-4
(manifest).
Consumes [`data-layer-working-notes.md`](./data-layer-working-notes.md)
(the exploration log). Built from three ground-truth code surveys of the
current snapshot/restore flow, the timeline tiers, and the store/conventions —
cited inline as `pkg/path:line`.

**Churn stance:** churn is *invited* where it reaches a brighter design. The bar is
not "minimal diff" but "the pattern is right and uniform." Parity (§7) is the
guardrail — behavior maps or is a documented drop — but wide refactors (removing
`_persisted`, deleting hand-rolled matchers, storifying knobs/state/session/
prompts/skills/resources) are expected, not avoided. Tests and lint fail forward
and guide the way.

---

## 0. What we're building (one paragraph)

Every stateful harness's state becomes **store-backed** (default in-memory, like
tasks and timeline already are). The session "snapshot" degrades from an
embedded blob to a **manifest of per-store cursors** — resume gathers latest
state from each store, not from one god snapshot. Stores optionally **derive
their state from the journal** (`ctx.journal` seam → event-sourcing / time-travel
as opt-in, never a framework mode). Each store projects a **canonical client
surface** — wire methods (reads/writes) + a change channel (observe) — that
`ui-next` consumes at the framework minimum and the app extends freely. No store
supertype: two structural archetypes (log, collection) sharing characteristics
(`backend`, an enumerate verb, `XStoreQuery`, optional `prune`/`onChange`, a
conformance suite).

---

## 1. Ground truth — the baseline we're changing

### 1.1 Two snapshot layers exist, and neither is the target

- **Layer A — `SessionSnapshot`** (`spec/src/protocol/session-harness.ts:397`):
  monolithic, **hand-picks two harnesses** — `timeline` (full `TimelineEntry[]`
  inline) + `knobs` (full record inline) — in `SessionHarness.snapshot()`
  (`session/src/harness.ts:693`). **State, prompts, skills are silently
  dropped.** There is **no `SessionHarness.importSnapshot`/restore at all.** The
  code says so: `// SessionSnapshot — Step 6 (SnapshotHarness) will compose
  per-harness snapshots into the session shape` (`session/src/harness.ts:694`).
  **The manifest IS the un-built Step 6.**
- **Layer B — `ReconcilerSnapshot`** (`spec/src/data/reconciler-snapshot.ts:37`):
  generic, **feature-detected** per-bridge map. `captureBridgeSnapshots`
  (`reconciler-react/src/harness/reconciler-harness.ts:919`) iterates
  `HookBridges`, calls `exportSnapshot()` via `typeof` (structural, not
  `instanceof`). Restore (`applyBridgeSnapshots`, :939) fires every
  `importSnapshot` concurrently under `Promise.all` — **no cross-harness
  ordering today.** `data` is special-cased into `dataCache`.

### 1.2 `SnapshotCapable` participants — and the two that already escaped

`SnapshotCapable<T>` (`spec/src/protocol/hook-bridges.ts:120`) = `exportSnapshot()`
+ `importSnapshot()`.

| Harness | Snapshot shape | Participation |
|---|---|---|
| knobs | `Record<string, KnobPrimitive>` | formal (`extends SnapshotCapable`) |
| state | `Record<string, unknown>` | formal |
| timeline | `TimelineHarnessSnapshot` (persisted+projection+versions) | formal |
| prompts | `Record<string, PromptsSnapshotEntry>` | runtime-only (`typeof`-detected) |
| skills | `Record<string, Skill>` | runtime-only |
| data | `DataCacheEntry[]` | runtime-only, special-cased → `dataCache` |
| **tasks** | — | **NOT participating — lives in `TaskStore`** |
| **credentials** | — | **NOT participating — lives in `CredentialsStore`** (`credentials/src/augment.ts:16`) |

**tasks and credentials are already on the target model.** They are the proof
the pattern works; the plan generalizes them.

### 1.3 Three stores, two archetypes

| | `TimelineStore` | `TaskStore` | `CredentialsStore` |
|---|---|---|---|
| Archetype | **log** | **collection (CRUD)** | **collection (KV)** |
| Key | `sessionId` (+`seq`) | `taskId` | `(namespace, key)` |
| Write | `append`→`seq[]` | `put` (upsert) | `set` (upsert) |
| Read | `load` | `get` | `get` |
| Enumerate | `sessions()` | `list(query?)` | `keys(namespace)` |
| Query struct | none (`history` cursor) | `TaskStoreQuery` | none (ns prefix) |
| Prune | `prune?(id,{seq})→num` | `prune?(before:num)` | none |
| onChange | none | none (bus is live) | `onChange?` |
| `backend` | ✓ | ✓ | ✓ |
| Port home | **timeline pkg** | **spec-next** | credentials pkg |

Doc lineage already asserts the convention informally: TimelineStore is
"generalized from `CredentialsStore`" (`timeline/src/store.ts:3`); TaskStore
"mirrors `TimelineStore`" (`tasks-store.ts:103`). **Port-home is inconsistent**
(TaskStore in spec, TimelineStore package-local) — §6 decision.

### 1.4 The journal is real and foldable — and it is NOT the timeline

- `OperationJournal extends EventLog<ProtocolEvent>` (`spec/src/protocol/journal.ts:85`)
  — the substrate append-only envelope log, already a `bus/inbox/journal` slot on
  **every** `BaseHarness`. Exposes `readByQuery(query: EventQuery, from:
  JournalReadFrom)` (scope-filterable, offset-cursored, foldable) + `tail(query)`
  (live) + `read(cursor, matcher)`. **This is the event source** a derived store
  folds. Effect-flavored → crosses to Promise-shaped stores at the runtime edge.
- `DurableJournal.replay(from)` (`cluster/src/journal.ts`) — replay primitive,
  cluster seam, out of scope v2.0 but the durability path for event-sourcing.
- **`journal` ≠ `TimelineStore`.** TimelineStore is a journal *in spirit*
  (append-log + `seq`) but is never named one, and sits at the
  conversation-entry layer, not the protocol-envelope layer.

### 1.5 Timeline holds the whole log in memory — the smell we remove

The harness holds **three** things where it should hold two: `_projection` (the
bounded working set for `read`/`subscribe` — legitimate) **and `_persisted`: a
full in-memory copy of the entire log** (`harness.ts:173`), plus `store:
TimelineStore` (durable). Worse, the default `writePolicy` is `"behind"` — the
comment says **"memory-authoritative write-behind pump"** (`harness.ts:120`): the
in-memory array is the source of truth and the store *lags*. `applyAppend` pushes
to `_persisted` (:695); `hydrate()` does `_persisted = [...store.load()]` (:404) —
**resume loads the whole timeline into RAM**; `snapshot()` embeds
`persisted: [...this._persisted]` (:621) — **the god-blob is a direct consequence
of the in-memory mirror.** This is the naive-load ghost, in the code. §2.7 removes
it: *the log IS the store; hold only the bounded projection.*

The projection fold (`compactBody`/`CompactRun`) is **explicitly allowed to be
non-deterministic (LLM-driven)** (`spec/.../timeline-harness.ts:11`): the log
replays deterministically, the projection does not (§6-E, now resolved via
ES-snapshots). `history({fromSeq,limit})` + the frozen `seq` contract are fully
specced + conformance-tested, but the **`session.history()` consumer is a stub**
(`session/src/define-session.ts:356`).

### 1.6 Two store-scoping shapes

- **Session-scoped**: TimelineStore, keyed `${sessionId}:timeline`, injected via
  session-options cascade (`withTimeline({store})`).
- **App-singleton**: TaskStore + CredentialsStore, constructed once at app/extension
  layer (detached tasks outlive sessions; credentials app-wide).

The store slot (§2.3) must serve both. Manifest references a store by
`(scope, key)`.

---

## 2. Target architecture

### 2.1 Store convention — two archetypes, no supertype

No nominal `Store` base (rejected over-taxonomy). Two **structural** shapes +
shared characteristics enforced by a shared conformance skeleton:

```ts
// LOG — append-only, ordered, cursored. (timeline; any event-sourced source)
interface LogStore<T> {
  append(key: string, entries: readonly T[], ctx: StoreCtx): Promise<readonly Cursor[]>;
  read(key: string, ctx: StoreCtx): Promise<readonly T[]>;             // full ordered (fold input)
  history?(key: string, q: { fromSeq?: Cursor; limit?: number }, ctx: StoreCtx):
    Promise<readonly SeqTagged<T>[]>;                                  // cursored page
  keys(ctx: StoreCtx): Promise<readonly string[]>;                     // enumerate
  delete(key: string, ctx: StoreCtx): Promise<boolean>;
  prune?(key: string, before: { seq: Cursor }, ctx: StoreCtx): Promise<number>;
  readonly backend: string;
}

// COLLECTION — keyed upsert, queryable. (tasks, credentials, knobs, state)
interface CollectionStore<T, Q> {
  put(item: T, ctx: StoreCtx): Promise<void>;                         // upsert
  get(key: string, ctx: StoreCtx): Promise<T | undefined>;
  list(query: Q | undefined, ctx: StoreCtx): Promise<readonly T[]>;   // enumerate + query
  delete(key: string, ctx: StoreCtx): Promise<boolean>;
  prune?(predicate: unknown, ctx: StoreCtx): Promise<number>;
  onChange?(listener: (e: ChangeEvent<T>) => void): () => void;
  readonly backend: string;
}
```

Shared characteristics (the "convention", not a base class): `backend`, an
enumerate verb, optional `prune`, optional `onChange`, an `XStoreQuery` per
store, a conformance suite by factory. **`ctx: StoreCtx` is new** and carries
`{ journal, scope, principal, signal }` — §2.4.

> **Open (§6-A): does `ctx` land on every method, or only reads?** Writes to a
> pure store don't need the journal. Threading it everywhere is uniform but
> noisy. Lean: everywhere, uniform, `ctx` unused by pure stores. This is the
> concrete instance of the `thread-ctx-into-methods` thread.

### 2.2 Generic in-memory defaults — "trivial custom store" made real

The survey confirmed feasibility. Ship two generics; the three existing stores
+ knobs/state collapse onto them:

- **`MemoryLog<T>`** subsumes `MemoryTimelineStore` verbatim (it's already
  payload-agnostic: `{ entries: T[]; baseSeq }` + seq-window math). ~0 store-specific.
- **`MemoryCollection<T, Q>`** subsumes `InMemoryTaskStore` +
  `InMemoryCredentialsStore` + future knobs/state, parameterized by
  `{ backend, keyOf, matchQuery, prunePredicate?, onChange? free }`. The only
  per-store code is a small `matchQuery` predicate. onChange fan-out
  (currently hand-rolled only in credentials) becomes free for all.

A new store-backed harness gets its default by **parameterizing one generic**,
not writing a Map. That is the "trivial" criterion, satisfied.

### 2.3 BaseHarness store slot + hydration-into-`ready`

Today every store-backed harness reinvents: `store?` option → `store` field →
`?? new InMemory…` → a hydration barrier. **And it fights BaseHarness**: tasks
keeps a *separate* `hydrated` promise because `ready` is a readonly BaseHarness
field, with a live TODO "fold into `ready` if BaseHarness gains…"
(`tasks/src/harness.ts:298`). BaseHarness has **no** store/snapshot/persist
notion today (`runtime/src/substrate/base-harness.ts`).

Add to BaseHarness, optionally:
- a `store?` slot (instance | factory, mirroring `bus/inbox/journal`),
- a `hydrate()` hook **chained into `ready`** so a store-backed harness is
  never "open before hydrated" — closing the tasks TODO and the timeline
  before-mount ordering in one primitive.

Default backing = in-memory generic. This is the "**all state store-backed,
default in-memory**" substrate.

### 2.4 The `ctx.journal` seam — event-sourcing as opt-in, not a mode

`StoreCtx.journal` is a read handle to the harness's `OperationJournal`
(already a BaseHarness slot). A store is then either:

```ts
// PURE — holds its own state. Resume-latest only. (default; MemoryCollection)
list(q, ctx) { return this.records.filter(match(q)); }

// DERIVED — owns nothing; folds the journal. Time-travel for free.
async list(q, ctx) {
  const events = await runEffect(ctx.journal.readByQuery(scopeOf(q), ctx.asOf ?? "beginning"));
  return fold(events).filter(match(q));
}
```

Ship the seam + a **reference event-sourced store** (proof). Default pure. `asOf`
on `ctx` (`"latest"` | an offset) is what makes time-travel a read parameter, not
a subsystem. Edge: Effect→Promise crossing (`Effect.runPromise` at the store
edge); the journal's `EventQuery` must express a harness's scope filter (E4).

### 2.5 Snapshot as manifest, not blob (finishing Step 6)

`SessionSnapshot` stops embedding data. It becomes:

```ts
interface SessionManifest {
  readonly specVersion: string;
  readonly id: string; readonly parentSessionId?: string;
  // Minimal index identity only. Session metadata (currentTick / usage / status /
  // metadata) is NOT embedded here — it lives in the SessionStore (E11), referenced
  // in `stores.session` like any other harness. All state is store-backed.
  // per-harness store references — NOT embedded state
  readonly stores: Readonly<Record<string /*harness, incl. "session"*/, {
    readonly scope: string; readonly key: string;
    readonly backend: string; readonly cursor: Cursor; // seq / version / offset
  }>>;
  // tree-derived declarations to re-run on restore (prompts/skills/cron/webhook)
  readonly intents: readonly SubscriptionIntent[];
}
```

> **Bootstrapping note:** the manifest is the *index* you read to discover a
> session exists before loading its stores, so it keeps minimal identity
> (`id`/`specVersion`). `status` for a "which sessions can I resume?" listing is
> read from the `SessionStore` enumerate — the manifest doesn't duplicate it.

- **`SessionHarness.snapshot()`** composes the manifest (the un-built Step 6):
  flush each store's write-behind, record its cursor.
- **`SessionHarness.restore(manifest)`** is **net-new** (no session-level restore
  exists today): for each `stores[h]`, rehydrate harness `h` from its store to
  `cursor` (latest for resume; a target for time-travel where derived).
- Coexists with residual embedded snapshot during migration — the generic
  feature-detection already tolerates heterogeneity.

**The consistency guarantee (cost #1, non-negotiable to state):** independent
stores have **no global consistency point** — a crash can skew store A ahead of
store B (Chandy-Lamport). Event-sourcing (single journal, one cursor, all
derived) is the **only** atomic-resume path. **Default = resume-latest,
eventually-consistent**; document it, minimize the window with a flush barrier
at snapshot, offer journal-derived stores for anyone needing atomicity/time-travel.

### 2.6 Client data-plane — the wire surface

A store projects a canonical client surface, decomposed on the CQRS line:

- **Reads/writes → wire methods** (ADR 46). The demand-resolver over the wire:
  client hands a canonical demand (cursor/page/query), the store's handler
  translates. `tasksWireExtension` already is this. **Framework minimum:**
  `enumerate` + `page`. Everything richer (fork, search, joins) = app-added.
- **Change → a channel** (ADR 33): snapshot + delta, cursor-resumable. Knobs
  already ships `knobs-state` this way. **Framework minimum:** one change topic
  per store. Timeline needs an `added/removed` topic for infinite-scroll + realtime.
- **`ui-next`** `useTimeline` (paginated, scroll-back via `history` cursor —
  and **wire the `session.history()` stub to `timeline.history`**),
  `useTasks`, `useKnobs` compile onto exactly this pair.
- **Over-fetch / open-entry (new commitment):** the store may return **more**
  than the framework's floor; the wire validates **presence of required** (`⊇`,
  `.passthrough()`), never validate-and-strip. Surplus rides to model/UI.
- **credentials proves the wire surface is optional** — its surface is *empty*
  (server-resident, never crosses the wire). A store with no `wire`. Good
  falsification test.

> **Fork (§6-B): extending a built-in store's namespace.** Exclusive namespaces
> (confirmed `gateway/src/wire-registry.ts`) forbid `timeline/myQuery` on the
> built-in namespace. (a) **Co-locate** the wire surface with the store (custom
> store brings its own methods; extend via a sibling `myapp-timeline/*` that
> calls the store) — keeps namespaces exclusive, my lean; vs (b) **namespace
> augmentation** — allow multiple contributors to one namespace, ergonomic for
> "just one more method."

### 2.7 Timeline: the log is the store; compaction is an overlay event *(RESOLVED — de-opinionated)*

**Correction (Ryan, on my over-reach):** an earlier draft here mandated a
*bounded* projection + write policy at the framework level. That is **impl
opinion and belongs in the in-memory store default, not the framework.** The
framework's line for the timeline:

- **Contract (framework):** the entry store is a **`LogStore`** — append + a
  cursored read (+ ordering). The harness *appends to it* and *reads what it needs
  to compile* through that contract. Nothing more.
- **Opinion (in-memory default, swappable):** full array vs bounded window, write-
  behind vs -through, eviction, how much lives in RAM. `MemoryLog` holding a full
  array is a **fine default**, not a smell to legislate away. A durable adapter
  picks differently; the framework never sees it.
- The one non-opinion cleanup: `_persisted` is a full log mirror living **in the
  harness** (storage in the logic layer). Move log storage *into the store* (the
  store it moves into may still hold a full array) — separation of concerns, a
  *harness* refactor separable from the store-contract run.

**Compaction = an overlay event, not a rewrite and not a second store (Ryan).**
The timeline stays **one append-only log, never rewritten**. A compaction is an
**event in it** — a `TimelineEntry` carrying a first-class optional `compaction`
bag: `{ range: {fromSeq,toSeq}; summary: ContentBlock[]|string; metadata? }`. The
raw entries it covers **stay** in the log; the compaction event is an *overlay*
("for the model view, render this range as this summary"). So:

- **`projection = fold(timeline)`** — walk the log; at a compaction event, collapse
  its `range` with its `summary`. Held as a **plain in-memory list** (Ryan's call —
  start simple, graduate later; NOT mandated bounded).
- **Deterministic** — the non-determinism happened once, when the compaction was
  *created* (the LLM); the summary is **durable on the event**. Replay is a
  deterministic fold → **§6-E dissolves**, no re-running the model, no
  projection-cache store.
- **Framework knows the *structure* (range + summary) to fold for the MODEL; the
  app owns the *content* (summary text, strategy) + *UI rendering*** (full history,
  compacted view, or "span summarized" markers — it has raw entries + overlays).
  Capability/opinion drawn at the seam; the `compaction` bag is the over-fetch
  principle on the entry.

---

## 3. Per-harness disposition — the discriminator applied

The rule that predicts "needs a store": **does the state have a lifecycle
independent of the session-snapshot envelope?** If yes → store. If it's derivable
by re-render / re-declaration → intent, not store.

Every entity is store-backed (the store is the single source of truth); the
column that matters for *how* is the **projection strategy** — eager write-through
(`CollectionProjection`) for read-after-write-hot mutable state, lazy
throw-on-pending (`useData`) for load-once definition sources, or none for
async-only/never-rendered state.

| Harness | State | Store | Projection strategy |
|---|---|---|---|
| timeline | conversation log | `LogStore` (has one); manifest = log cursor (E5) | **bounded fold** (not a mirror) |
| tasks ✓ | task FSM records | `CollectionStore` (has one); app-singleton | **eager augmented-cache** (record + non-persisted live handles) |
| credentials ✓ | secrets | composes `MemoryCollection`; app-singleton; **empty wire surface**; `onChange` source | **NONE** — async-only, server-resident, never rendered (the counter-example) |
| knobs ✓ | model-set values | store-backed (`MemoryCollection` via `CollectionProjection`) | **eager pure-mirror**; channel stays harness-level; `exportSnapshot` coexists → Phase-4 sweep. ADDITIVE, not a deletion |
| state | `useState` cells | `CollectionProjection` (eager) | **eager pure-mirror** (same shape as knobs) |
| session | tick/usage/status/metadata | `SessionStore` (E11 — no scalar exception) | **eager**, likely single-record |
| **skills** | `Skill` (all strings) | `CollectionStore<Skill>` + loaders | **none** (async) — the definition-library PURE floor |
| **prompts** | `PromptDeclaration` | `CollectionStore` + loaders + `render`/`template` augmentation | **none** (async) — skills + augmentation |
| **resources** | `{uri, meta, sourceConfig}` | `CollectionStore` + tree-mount **+ DB/fs loader** + `resolver` augmentation | **eager** (catalog folded into IR) — the rich instance |
| data | fetch cache | already the `DataBridge` | **lazy** (`useData`) — the reference lazy case |

**The definition-library archetype (corrected — supersedes both "lazy `useData`"
and "resources is a different kind"; verified by a 3-harness compare).**
prompts/skills/resources are ONE archetype: a `CollectionStore<Declaration>`
(serializable, string-keyed) + pluggable **sources** (the shared `Loader<T>`:
array/module/url/fs/**DB**/tree-mount) + an optional **non-serializable runtime
augmentation** re-attached at restore (the tasks pattern: `render`/`resolver` fn;
skills has none) + a **projection strategy** set by the read pattern (none for
async reads; eager for resources' render-read catalog). Skills is the pure floor,
prompts adds one augmentation, resources is the rich instance (augmentation +
eager catalog projection + dual-key `uri`/`uriTemplate` query + the durable DB/fs
source it lacks today, overlaid by transient `<Resource>` tree-mounts). The
`Loader` (read-only source) stays a source that FEEDS the store — it is not
dissolved into it. Run order by axes-turned-on: **skills → prompts → resources**.

The broader picture (runs #1–6a): storifying a render-read harness is **additive**
(add store + projection beside the existing notify seam), NOT a code-deletion win —
the `exportSnapshot` deletion is the coordinated **Phase-4 manifest sweep**, not
per-run. credentials proves an async-only harness needs **no projection at all**.

---

## 3.5 The Playbook — the repeatable per-harness algorithm

**Every layer/harness runs the same checklist. Groq one, groq all.** The framework
already converged on the primitives; the playbook is mostly *conform + verify*, not
*invent*. Reuse targets (do NOT reinvent — grep first):

| Concern | Canonical primitive | Home |
|---|---|---|
| Log shape | **`EventLog<E>`** (`append`/`appendBatch`/`read(cursor,matcher)`) | `spec/protocol/event-log.ts` (bus + journal specialize it) |
| Position | **`Cursor { value }`** (opaque, monotonic, log-scoped) | `spec/protocol/event-log.ts` |
| Scope base | **`EventScope`** + **`EventScopeExtensions`** (empty-seed augmentation) | `spec/data/events.ts` |
| Query | **`EventQuery`** (surface/name/phase/scope/tags) + store-specific fields | `spec/data/events.ts` |
| Matcher | **`CompiledMatcher<E>`** via `compileQuery` / `matchesEventFilter` | `runtime/substrate/query.ts` + **`utils/match-filter.ts`** |

### The algorithm (checklist — run per entity)

- [ ] **P0 — Classify.** Discriminator: does the state have a lifecycle
      *independent of the session snapshot*? If no and it's tree-derivable →
      `SubscriptionIntent` (re-declare), not a store. If yes → store. Then pick the
      **archetype: log** (append-only, ordered, replayable → conform to `EventLog`)
      **or collection** (keyed upsert, queryable → `CollectionStore<T,Q>`).
- [ ] **P1 — Identify the store shape.** The entity's key, its record type, its
      enumerate verb, whether it needs `onChange`, whether it's session-scoped or
      app-singleton (E1).
- [ ] **P2 — Spec it in `spec-next`.** Port interface + data-shape type live in
      spec-next (the cross-package contract; §6-D makes this canonical for ALL
      stores, unifying timeline). Augment **`EventScopeExtensions`** with the
      harness's identifier dimension (the `sandboxId`/`mcpConnectionId` pattern) so
      its scope is first-class, not bespoke.
- [ ] **P3 — Align the query.** The query = **`EventScope`-based scope** (+ the
      harness's augmented dimension) **+ range/order/cursor + store-specific
      predicates**. It identifies *scope, range, order, basic params* and **leaves
      fulfillment to the store**. Compile it to a `CompiledMatcher` via the shared
      `compileQuery`/`match-filter` mechanism — **never a hand-rolled `scopeMatches`.**
      No framework query language beyond this; `raw` escape for backend-specific needs.
- [ ] **P4 — Implement the in-memory base.** Parameterize `MemoryLog<T>` (log) or
      `MemoryCollection<T,Q>` (collection) with `{ backend, keyOf, matchQuery,
      prunePredicate? }`. The ONLY store-specific code is the matcher/keyOf. This is
      the default backing; conformance-green = done.
- [ ] **P5 — Wire to BaseHarness + choose the projection.** Mount on the `store?`
      slot; hydration via the `hydrate()`-into-`ready` hook (§2.3). A render-read
      harness needs a **sync-read cache** (mandatory — each render pass is sync and
      the throw-on-pending render loop needs a cache to terminate; `useData` is an
      instance of this, not a counter-example). The FREE choice is *population*:
      **EAGER write-through** = `CollectionProjection<T>` (`store-next`) for
      read-after-write-hot MUTABLE state (knobs/state/session); **LAZY
      throw-on-pending** = the `useData` model for **load-once definition sources**
      (prompts/skills/resources). An **async-only, never-rendered** harness
      (credentials — server-resident) needs **NO projection**: read the async store
      directly. Never hold the full log (§2.7). **Projection archetypes:** eager
      *pure-mirror* collection = `CollectionProjection` (knobs, state); eager
      *augmented* collection = hand-rolled, cache holds the record + non-persisted
      extras (tasks: `live` = record + fibers/abort); eager *augmented single-record*
      = hand-rolled, one record + ephemeral extras (session: `SessionRuntime` = record
      + `currentTick`/listeners); *lazy* = `useData` (prompts/skills/resources); *none*
      = async-only (credentials); *bounded fold* (timeline). Augmented/single-record
      cases stay hand-rolled — a collection primitive for one record, or one wrapping
      non-persisted handles, is ceremony (the call tasks + session made). **NAMING
      (non-negotiable): the durable backing is a `Store` (`CollectionStore`/`LogStore`
      + a `createXStore` factory); the live sync working copy is a PROJECTION — name
      it by role (`projection` / `live` / `runtime`), NEVER `…Store`.** (`SessionStateStore`
      next to `SessionStore` was the one violation; fixed in `2f85520e`.)
- [ ] **P6 — Client surface.** Framework-minimum: `enumerate` + `page` wire methods
      + one change channel. App extends freely. `⊇` pass-through over-fetch.
      (credentials = empty surface, and that's valid — E7.)
- [ ] **P7 — Manifest.** `snapshot()` records the store's cursor; remove any
      `exportSnapshot` embed. Restore rehydrates from the store to the cursor.
- [ ] **P8 — Conformance + parity.** Extend `runStoreConformance` with the entity's
      cases; every prior behavior maps or is a *documented* drop (§7). Type-enforce
      the shape via the shared archetype interfaces so drift breaks the build.
- [ ] **P9 — Update README if necessary, when and where applicable.** Any package
      whose public surface, patterns, or "Verified by" changed gets its README
      brought current (new exports like `CollectionProjection`, the store the harness
      now takes, the projection strategy it uses). Skip only when nothing
      user-facing changed. Back-propagate to earlier runs' packages too.

### Guidelines (augment as we learn)

- **All state is store-derived AND store-persisted — the store is the single
  source of truth.** Every harness/layer's state *comes from* the store (read /
  hydrate) and is *stored to* the store (write / persist). No exceptions —
  including the session harness itself (`SessionStore`, E11) and the substrates.
  Any in-memory projection is a **DERIVED cache** (reconstructible from the store
  via `hydrate`), NEVER a second home for state; the manifest references the
  store, never the cache. The purest form holds no cache at all (credentials:
  read the async store live). A cache is an optimization on top of this invariant,
  not an exception to it.
- **The query/input identifies scope + range + order + basic params; the store
  decides how to fulfill.** Could be event-sourced (journal projection) or
  otherwise persisted — **the framework does not care**, it just asks and receives.
- **Reuse the matcher/scope/query/cursor primitives** (`EventScope` /
  `EventQuery` / `CompiledMatcher` / `Cursor` / `utils/match-filter`). Reinvention
  is a code smell; grep before writing.
- **Substrates are store-backed** (confirmed): bus + journal = `EventLog`; inbox =
  `MessageInbox`. The playbook *verifies* them, doesn't rebuild them.
- **The pattern must be characteristic and intuitive** — type-enforced by the
  shared archetype interfaces + the shared conformance skeleton, so consistency is
  mechanical, not aspirational.
- **`ctx.journal` makes "store = journal projection" a first-class option** — a
  store MAY fold `journal.readByQuery(scope, from)` instead of holding state (§2.4).

### The run list — every entity the playbook targets

| Entity | Archetype | Store today? | P1 shape |
|---|---|---|---|
| **bus** | log | ✓ `EventLog` (`EventBus`) | verify/align only |
| **journal** | log | ✓ `EventLog` (`OperationJournal`) | verify/align; the event-source for derived stores |
| **inbox** | collection/queue | ✓ `MessageInbox` | verify/align |
| **timeline** | log | ✓ `TimelineStore` | align to `EventLog`; remove `_persisted` (§2.7); port → spec |
| **tasks** | collection | ✓ `TaskStore` | delete hand-rolled `scopeMatches` → shared matcher |
| **credentials** | collection (KV) | ✓ `CredentialsStore` | empty wire surface (E7) |
| **knobs** | collection | ✗ | → `KnobStore` (`MemoryCollection`); delete bespoke export/import |
| **state** | collection | ✗ | → `StateStore` |
| **session** | collection (1-record) | ✗ | → `SessionStore` (tick/usage/status/metadata) |
| **prompts** | collection | ✗ | → `PromptStore` — **may be filesystem-backed** |
| **skills** | collection | ✗ | → `SkillStore` — **may be filesystem-backed** |
| **resources** | collection (URI-keyed) | ✗ | → `ResourceStore` — URI-addressed, **filesystem-natural** |
| **data** | collection (cache) | ~ `dataCache` | fetch cache; likely stays intent-declared |

**On prompts / skills / resources (revised — §6-C):** these get stores too. Their
store is the **definition source** — and it can be a **filesystem store**
(markdown prompts, skill files, resource files on disk). The framework doesn't
care where definitions live; it asks the store. This is orthogonal to their
session registration being tree-declared (they can be both: a `PromptStore`
sources definitions; the tree references them; restore re-declares the
references). Resources especially fit — they're already URI-addressed
(`resources/src/uri-template.ts`), i.e. a collection keyed by URI, filesystem-natural.

### Validated by runs #1–2.5 (tasks, knobs, CollectionProjection) — findings that refine the pattern

Committed: #1 tasks (`24e23740` — `@agentick/store-next` with `MemoryCollection` +
`runStoreConformance`, `CollectionStore` port in spec-next,
`matchesScope`/`compileScopeMatcher` in utils, tasks refactored on), #2 knobs
(`8a57e663` — first storification), 2.5 (`36b74fc4` — `CollectionProjection`
extracted, knobs retrofit, tasks documented-variant). Run #3 credentials in flight.
What they taught us:

1. **The shared conformance is deliberately THIN — only 3 archetype-agnostic
   cases** (backend-id, empty-read, idempotent-delete); everything else is
   store-specific via a `cases` hook. This *confirms* "no `Store` supertype" — even
   the conformance barely shares, because log and collection genuinely diverge.
2. **The conformance probes accommodate KV via closures.** `emptyRead.read` /
   `idempotentDelete` are `(store, key) => …`, so a namespace-keyed store passes
   `read: (s, key) => s.get("ns", key)`. No KV special-case needed (the credentials
   run relies on this).
3. **The shared scope matcher needs two forms** (both in `utils/match-filter.ts`):
   `matchesScope(filter, scope)` for cold single-shot callers (`matchesQuery`, a
   store's `list`), and `compileScopeMatcher(filter) → (scope)=>bool` for hot
   per-event paths (`compileQuery` on the publish loop) — pre-extracts the
   constrained keys once. One semantics, two entry points.
4. **`onChange` is for EXTERNAL / cross-consumer observation, NOT self-caused
   changes.** (Corrected — the reverted doc said "lands with knobs", which run #2
   disproved.) A single harness's self-caused change stream (knobs' `set` → its
   own channel) stays harness-level; the store never sources it. `onChange`
   observes changes to a **shared** store that a consumer did *not* cause
   (credentials app-singleton: consumer A sees consumer B's writes; a keychain
   rotation). So `onChange` lands with **credentials** (run #3), not knobs.
   `StoreCtx`/`ctx.journal` (+ idempotency, E16) is the Phase-2 seam.
5. **Storification is ADDITIVE + splits eager/lazy (runs #2, 2.5, reconciler
   discussion).** A render-read harness needs a sync-read cache (mandatory: sync
   render passes + the throw-on-pending loop needs a cache to terminate; `useData`
   is an instance). EAGER write-through (`CollectionProjection`) for
   read-after-write-hot mutable state; LAZY `useData` for load-once definition
   sources (prompts/skills/resources); NONE for async-only (credentials). The
   `exportSnapshot` deletion is the Phase-4 sweep, not per-run — expect net-additive.
6. **CLAUDE.md's New Package Checklist is stale for `-next` packages** —
   `.changeset/config.json` `linked` is `[]` and tracks no `-next` package, so
   `store-next` was (correctly) NOT changeset-registered. Revisit tracking policy
   at v2 cut.

---

## 4. Phased work breakdown

> Each phase below **runs the §3.5 playbook** against one or more entities from the
> run list. The phase boundaries are grouping + ordering; the per-entity checklist
> is identical every time.

Each phase is independently landable, conformance-gated, and (per the hard
criterion) **adoptable one store at a time, coexisting with the old**.

### Phase 0 — Store convention + generics + shared conformance *(pure additive, zero behavior change)*
- Land `LogStore` / `CollectionStore` shape types + `Cursor`/`SeqTagged`/`ChangeEvent`/`StoreCtx` in spec-next.
- Land `MemoryLog<T>` + `MemoryCollection<T,Q>` generics (`@agentick/runtime-next` or a new `@agentick/store-next`).
- Refactor `MemoryTimelineStore` → `MemoryLog`, `InMemoryTaskStore` + `InMemoryCredentialsStore` → `MemoryCollection` (**behavior-preserving; existing conformance suites are the gate**).
- Extract `runStoreConformance` base skeleton; `runTimelineStoreConformance`/`runTaskStoreConformance` extend it.
- **§6-D port-home decision**: move `TimelineStore` port to spec-next (match `TaskStore`); adapters re-point imports.
- README per new package; `@verifiedBy` on every claim.
- *Gate:* all existing store + harness conformance green, workspace typecheck, no behavior delta.

### Phase 1 — BaseHarness store slot + `hydrate()`-into-`ready`
- Add optional `store?` slot + `hydrate()` hook chained into `ready` on BaseHarness.
- Migrate `TasksHarness` onto the slot (already store-backed) → **delete its separate `hydrated` promise + close the TODO** (`tasks/harness.ts:298`).
- Migrate `TimelineHarness` onto the slot; its before-mount hydration becomes the standard hook.
- *Gate:* kill/resume acceptance (`runKillResumeAcceptance`), timeline two-tier conformance, tasks conformance.

### Phase 2 — `ctx.journal` seam + reference event-sourced store
- Thread `StoreCtx` (`{journal, scope, principal, signal, asOf}`) into store methods.
- Bridge `OperationJournal.readByQuery` (Effect) → Promise at the store edge; define the `EventQuery` scope mapping (E4).
- Ship one reference **derived** `CollectionStore` (folds the journal) + conformance for the derived path + a time-travel (`asOf`) test.
- *Gate:* pure stores unaffected; derived store passes the same collection conformance + a replay/`asOf` test.

### Phase 3 — knobs ✓ + state become store-backed *(first storification; additive)*
- knobs (DONE, run #2 8a57e663 + run 2.5 36b74fc4): `MemoryCollection` via
  `CollectionProjection` (eager pure-mirror); `values: Map` becomes the sync
  projection; the `knobs-state` channel stays **harness-level** (self-caused — NOT
  `store.onChange`); `exportSnapshot` COEXISTS (Phase-4 sweep deletes it).
- state: same template — `CollectionProjection` (eager), sync projection kept,
  channel harness-level, `exportSnapshot` coexists.
- *Gate:* channel snapshot+delta parity; kill/resume with knobs/state; sync reads
  unchanged; **net-additive is expected** (store + projection beside the notify
  seam) — the deletion is Phase 4, not here.

### Phase 4 — Manifest + `SessionStore` + `SessionHarness.restore` *(the un-built Step 6)*
- **`SessionStore`** — migrate session metadata (currentTick / usage / status / session-state) into a store (E11); the session harness becomes store-backed like the rest. No manifest scalars.
- `SessionManifest` type; `SessionHarness.snapshot()` → manifest (flush-then-record-cursor barrier).
- **Net-new `SessionHarness.restore(manifest)`**: per-store rehydrate to cursor; restore ordering (journal → derived stores → mount) — the first place ordering matters (E12).
- Coexist path for un-migrated harnesses (residual embedded).
- Document the **eventually-consistent resume** guarantee (E2).
- *Gate:* kill/resume acceptance passes via manifest for all migrated harnesses; skew-window test; heterogeneous (some embedded, some manifest) resume.

### Phase 5 — definition-library stores (skills → prompts → resources)
The three unify under the **definition-library archetype** (§3 disposition):
`CollectionStore<Declaration>` + `Loader<T>` sources + optional non-serializable
augmentation + a projection strategy. Run by axes-turned-on:
- **skills** (pure floor): async `CollectionStore<Skill>`; loaders feed it; register/
  update/remove → put/delete; NO augmentation, NO projection; `exportSnapshot`
  coexists (Phase-4 sweep). The template.
- **prompts** = skills + the `render`/`template` **runtime augmentation** (re-attached
  on restore, tasks-style; snapshot drops it as today).
- **resources** = the rich instance: + **eager catalog projection** (the render-read
  IR fold), + dual-key `uri`/`uriTemplate` query, + a NEW durable **DB/fs `Loader`**
  source (it has none today) overlaid by transient `<Resource>` tree-mounts. Touches
  the reconciler default-projection — do last, with care.
- *Gate:* per harness — store round-trip + loader population + (resources) catalog
  projection parity + template resolution; existing conformance green.

### Phase 6a — Timeline **entry-log store** *(the clean, opinion-free run — next)*
- Bring `TimelineStore` onto the shared **`LogStore` archetype**: contract in
  spec-next (append + cursored read + `seq`), `MemoryLog<T>` generic default (a
  full array is a fine default — NO memory-strategy opinion, §2.7),
  `runStoreConformance` delegation, port-home → spec (§6-D).
- Does NOT touch the harness `_persisted`/`_projection`/write-behind (impl
  opinion, left as-is) — this is *just the store archetype*, like every prior run.
- *Gate:* existing timeline store-conformance green via the shared skeleton; `seq`
  contract preserved; no behavior delta.

### Phase 6b — Compaction overlay + fold *(additive, follows 6a)*
- Add the first-class optional **`compaction` bag** to `TimelineEntry` (`{ range;
  summary; metadata? }`, §2.7). `projection = fold(timeline)` applies overlays;
  raw entries stay (append-only). Held as a plain list.
- **Resolves E5/§6-E deterministically** — summaries are durable on the events, so
  replay is a deterministic fold; no projection-cache store, no re-running the LLM.
- Retire the `TimelineImportMode` enum ("as-is/persisted-only/rehydrate") — restore
  becomes replay-the-log-and-fold.
- The `_persisted`-in-harness → move-to-store cleanup (§2.7) rides here or separately.
- *Gate:* fold determinism (same log ⇒ same projection); full-vs-compacted render
  from one log; append-only preserved (compaction never deletes entries).

### Phase 7 — Client data-plane
- Per-store wire surface (`enumerate` + `page`) + change channel (framework minimum); `.passthrough()` over-fetch.
- **Wire `session.history()` stub → `timeline.history`** (close the stub).
- `ui-next`: `useTimeline` (infinite scroll-back), `useTasks`, `useKnobs`.
- §6-B namespace fork decision (co-locate vs augment).
- *Gate:* language-agnostic wire (no TS-inference dependency); ui-next hooks against a real gateway; over-fetch surplus reaches UI, framework ignores it.

---

## 5. Edge inventory — every hard problem

- **E1 — Store scoping (session vs app-singleton).** Timeline is per-session
  (`${sessionId}:timeline`); tasks/credentials are app-singletons. The slot must
  serve both; manifest references `(scope, key)`. *Do not* force timeline into an
  app-singleton or detached tasks into per-session.
- **E2 — No atomic resume without event sourcing (cost #1).** Independent stores
  skew on crash. Default resume-latest is eventually-consistent. This is a
  *stated guarantee*, not a bug. Flush barrier narrows the window; journal-derived
  is the only true fix.
- **E3 — Write-behind durability window.** Timeline flushes async; on crash the
  in-memory tier is ahead of the store. Resume reads the store (durable) → the
  un-flushed tail is lost. Snapshot must flush-then-record. Acceptable, must be
  understood.
- **E4 — `EventQuery` must express a harness's scope.** The `ctx.journal.readByQuery`
  fold is only real if `EventQuery` can filter to one harness's events. Verify the
  `EventScope`/`EventQuery` shape covers `(surface, scopeId, principal)`. If not,
  extend it — this is the load-bearing unknown for §2.4.
- **E5 — Non-deterministic timeline projection. RESOLVED (§2.7 / Phase 6b) —
  compaction-as-overlay-event.** The LLM non-determinism happens once, when a
  compaction is *created*; its `summary` is stored **on the compaction event** in
  the one append-only log. Replay is then a **deterministic `fold(timeline)`** —
  no re-running the model, no projection-cache store, no `TimelineImportMode`. The
  raw entries stay (append-only); the compaction event is an overlay.
- **E6 — knobs values vs descriptors.** Store holds **values**; descriptors stay
  tree-derived (re-registered on render). Clean — the current channel already does
  exactly this.
- **E7 — credentials empty wire surface.** A store that projects *nothing* to the
  client. Proves the wire surface is optional; must not assume every store has one.
- **E8 — prompts/skills/resources: RESOLVED → the definition-library archetype
  (§6-C).** Not intent, not lazy-`useData`: one `CollectionStore<Declaration>` +
  `Loader<T>` sources + optional augmentation + projection strategy. Run
  skills→prompts→resources.
- **E9 — Incremental migration / heterogeneity.** During migration, some harnesses
  are manifest-backed, some still embedded. The feature-detection tolerates it;
  the manifest+embedded coexist until all migrate. Hard criterion: one store at a
  time or it's disqualified.
- **E10 — `SessionHarness.restore` is net-new.** No session-level restore exists.
  Building the manifest means building the inverse from scratch, plus its ordering.
- **E11 — Session metadata → `SessionStore`. RESOLVED + fleshed out.** The session
  harness is itself stateful, so it gets a **`SessionStore = CollectionStore<SessionRecord,
  SessionStoreQuery>`** (keyed by `id`, **app-singleton** like `TaskStore`; port +
  record in spec-next, `InMemorySessionStore` composing `MemoryCollection` in
  session-next). It is bigger than it looks: this store IS **the session registry +
  the resume index + the backing for every "list/resume my sessions" UI** — its
  `list(query)` (by `appId`/`status`/`parentSessionId`/recent-`updatedAt`) *is* the
  sessions-list wire surface, `enumerate` is foundational, and the SessionRecord is
  the natural home for the Phase-4 per-store cursor **manifest** (`stores?`), making
  it the entry point for resume. Projection: **none** (async-read, like credentials —
  read by the client/app, not hot render-read). `SessionRecord` shape, grouped by
  ownership:
    - *identity/lifecycle (framework-owned):* `id`, `createdAt`, `updatedAt`,
      `status`, `parentSessionId?` (spawn ancestry → session tree), `appId?`.
    - *runtime accounting (framework-owned), hierarchy-aware (session → execution →
      tick):* `currentExecutionId?` + `executionCount` (NOT `currentTick` — tick is
      **execution-local**, resets per execution, so it's execution-scoped runtime,
      not session metadata); `usage` aggregates across executions.
    - *descriptive (app-owned SLOTS — framework STORES, never POPULATES):* `title?` /
      `description?` (the app generates them — auto-summary / user-edit; framework is
      blind to the semantics), `metadata?: Record<string, unknown>` (the open bag /
      over-fetch home).
  **Model RESOLVED (Ryan):** **1 agent : 1 session** — the spawn tree IS the session
  tree. A sub-agent is spawned with a **child session** (`parentSessionId`), either
  clean-slate or **inheriting context from the parent via store cascade** (the knobs
  `parentLayer` read-through fallback is the existing prototype — a child store reads
  through to the parent's). `executionId` is `exec:${ulid()}` (globally unique,
  sortable; already in `EventScope`), so executions stay addressable across the tree.
  ⇒ `agentId?` is a legitimate **optional first-class slot** (1:1 makes it meaningful
  for the sessions-list), populated when the agent has a stable id/name; not required.
  **The live-registry-vs-record-store distinction (falls out):** the app's session
  registry maps `sessionId → LIVE SessionHarness` (routing, in-memory, ephemeral — a
  live-object map like tasks' `live`) and is NOT replaced. The `SessionStore` holds
  `sessionId → SessionRecord` (durable metadata, queryable) — the **superset** (every
  session ever, incl. closed/historical) + the durable + enumerable surface. Deferred:
  an `ExecutionStore` (level below session) — the timeline already captures the
  conversation, so per-execution records are audit/replay sugar, not yet required.
- **E12 — Restore ordering (new).** Today none (`Promise.all`). Derived stores need
  the journal restored first; timeline-before-mount already exists. Manifest restore
  introduces a dependency order: journal → derived stores → mount.
- **E13 — Effect ↔ Promise boundary.** Journal is Effect-flavored; stores are
  Promise-shaped. The seam crosses at the store edge (`Effect.runPromise`). Keep
  stores Promise-shaped (adopter-friendly); confine Effect to the fold.
- **E14 — `onChange` semantics across backends.** In-memory fires synchronously;
  a Postgres store needs LISTEN/NOTIFY or polling. `onChange` stays optional; the
  change *channel* (client-facing) is fed by the harness's own writes when the
  store can't observe external changes (matches credentials' documented split).
- **E15 — Over-fetch re-touches persistence + diffing.** Surplus fields must survive
  snapshot/restore/wire (pass-through), AND the change channel diffs entries — so
  surplus generates wire deltas the framework is nominally blind to. Lean: the app
  asked for them, it pays for the deltas; verify it doesn't re-import the
  merge/consistency problem behind the bright line.
- **E16 — Idempotency: reuse the existing key, thread it to the store (Phase 2).**
  Idempotency already exists two-layered: operation-level
  `OperationJournal.lookupTerminal(opId)` (replay short-circuit at command entry) +
  wire-level `_meta.idempotencyKey` (client `retry` generates it for non-idempotent
  methods, omits it for naturally-idempotent `get*` —
  `client-extensions/retry/predicates.ts:72`). The store seam is NOT a new key — it
  is threading the EXISTING key (`opId` / `_meta.idempotencyKey`) into the write
  path via `StoreCtx` so a store that owns persistence MAY dedupe. Load-bearing for
  **`append`** (log — retrying an append duplicates); `put` (collection) is
  naturally idempotent by key. Framework provides key + seam; store/app owns the
  guarantee (dedup needs persistence). Complements, not replaces, the journal's
  operation-level idempotency.
- **E17 — Notify seam duplicated across harnesses. PARKED (teed up, do after the
  run list).** Every state-holding harness re-hand-rolls `subscribe` /
  `subscribeAll` (bare render pings, `KeyedNotifier`) + `onChange` (typed
  `ChangeEvent` stream, `ChangeNotifier`) — knobs, state, and more, plus the
  `TODO(notify-seam): promote to protocol` trailhead. The *primitives* already
  exist cross-platform in `pubsub-next` (`createNotifier`/`createKeyedNotifier`/
  `createChangeNotifier`) — NOT Node's `EventEmitter`. What's duplicated is the
  method boilerplate + protocol typing. Formalize-on-recurrence (same rule as
  `CollectionProjection`): a **composable `Notifiable` capability** near
  `BaseHarness` — NOT baked into every harness (stateless ones don't need it) — and
  it likely **unifies with the store's `onChange`** (E14 / the `MemoryCollection`
  seam). Do NOT touch mid-run-list; revisit after timeline + prompts/skills/resources.

---

## 6. Decisions to make (the genuine forks)

Each is a real choice with a cost, not a detail. My lean is stated; none is ratified.

- **§6-A — `ctx` on all store methods or reads only?** Lean: all, uniform.
- **§6-B — Extend built-in store namespace: co-locate vs augment?** Lean: co-locate
  (keep namespaces exclusive), revisit if the "one more method" ergonomics bite.
- **§6-C — prompts/skills/resources: RESOLVED — one definition-library archetype.**
  (Supersedes "lazy `useData`" AND "resources is a different kind" — a 3-harness
  compare showed prompts≈skills mirror line-for-line, resources is the same
  archetype with more axes on.) All three: `CollectionStore<Declaration>` + shared
  `Loader<T>` sources + optional non-serializable augmentation (`render`/`resolver`;
  skills none) + projection strategy (none async / eager for resources' catalog).
  skills = pure floor, prompts = + augmentation, resources = + eager projection +
  dual-key query + a durable DB/fs source it lacks today. Run skills→prompts→
  resources. See §3 disposition + Phase 5.
- **§6-D — Store port home: spec-next canonical?** Lean: yes — ports + data shapes
  in spec-next, defaults + conformance in the harness package; unify timeline.
- **§6-E — Timeline projection on restore. RESOLVED — compaction-as-overlay-event
  (Ryan).** Not re-derive-and-accept-difference, and not a separate checkpoint
  store: a **compaction is a `TimelineEntry` with a `compaction` bag** (`range` +
  `summary` + `metadata?`) in the one append-only log. The LLM runs once at
  create-time; the `summary` is durable on the event; `projection = fold(timeline)`
  is a **deterministic** replay (collapse each compaction's range with its stored
  summary). Same-log ⇒ same-projection, exactly, with no re-run and no second
  store. Raw entries never deleted (overlay, not rewrite). Retires
  `TimelineImportMode`. See §2.7 / Phase 6b.
- **§6-F — Consistency default. RESOLVED (event sourcing baked in).** Event
  sourcing is a **first-class, always-available capability** (the `ctx.journal`
  seam). Default resume = latest-from-each-store (eventually-consistent, simple).
  Atomic / point-in-time / restore-from-a-slice = **you opt into event sourcing**
  for that harness. The framework guarantees the *capability* is universal; the
  *behavior* is opt-in. Capability-not-opinion.

---

## 7. Parity checklist — what must not regress

Inventoried from the conformance suites (the fear is silent behavior loss):

- **Store conformance** (`runTimelineStoreConformance`, `runTaskStoreConformance`):
  backend-id stable; unknown-key→empty; round-trip ordering; append seq
  monotonic/never-reused; `history` paging + prune-stability; per-session
  isolation; defensive copies; enumerate; delete idempotent; prune-by-absolute-seq.
- **Timeline harness conformance** (`runTimelineHarnessConformance`): append→both
  tiers; compact→projection-only, log untouched, provenance recorded;
  replaceProjection→projection-only; resetProjection→mirror; snapshot round-trip;
  import modes (until retired in §6-E).
- **Kill/resume acceptance** (`runKillResumeAcceptance`, ADR 49): open-or-rehydrate;
  hydrate-before-first-render; resumed conversation intact.
- **Knobs**: state-channel snapshot + JSON-Patch delta; version-gap re-seed.
- **The frozen `seq` contract** (#133): strictly increasing, never reused, stable
  across prune — a Postgres `BIGSERIAL` stays conformant.

Every migrated harness must keep its conformance green or **document a deliberate
drop** — never an accidental one.

## 8. Non-goals / bright lines

- **No sync engine.** The framework ships loaders + a change signal; the app owns
  merge/cache/consistency (ngrx/TanStack/PouchDB). Owning merge = Replicache/Zero/
  Electric = a multi-year product. Do not cross.
- **No framework query language.** Canonical cursor + demand-name + a `raw` escape;
  the query impl lives in the store.
- **No client cache in the framework.**
- **No god snapshot.** The manifest references; stores hold. (This *is* the plan.)
- **Wire is language-agnostic.** TS types are a codegen/shared-schema layer over the
  wire, never runtime inference (tRPC out — client isn't strictly TS).
- **No supertype `Store`.** Structural archetypes + shared conformance only.

---

*Companion: [`data-layer-working-notes.md`](./data-layer-working-notes.md) (the
exploration log). Prior art to conform to (steal the spec): Ports & Adapters /
Repository, Event Sourcing + CQRS, Relay cursor connections, K8s list+watch
(`resourceVersion`), ORM lifecycle hooks. Avoid: Replicache / Zero / ElectricSQL
(sync engines — the bright line).*
