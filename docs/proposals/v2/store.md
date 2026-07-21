# Store — the foundational data-source seam

**Status: BUILT — `Store` is the universal store contract.** The convergence
pivot: the nine store-backed harnesses each hand-roll the same machine. This
names the foundational pieces so the machine is *composed*, not copied — without
collapsing the store itself (Ryan: "it is concerning that we might collapse the
store"). As of Convergence Run 1 (2026-07-20), **every** store formally
`extends Store` — the two archetypes (`CollectionStore`, `LogStore`) and the
`CredentialsStore` are all `query`/`mutate` profiles over the ONE seam; there is
no store-level straddle.

## The one idea

A **store is thin**. It owns no state — the *source* does. It only ever:

- takes a **query** and returns a **projection** pulled from wherever the data
  lives (Postgres, S3, the filesystem, an HTTP API, a fold of the operation
  journal, an in-memory `Map` — *any* source, any nature), and
- takes a **mutation** and applies it to that source,
- and *may* expose a **change stream** — reactivity is a **capability, not a
  mandate** (Ryan: "not everything needs to be reactive, though being reactive-
  capable and shaped is a generally good thing").

The framework **never learns the nature of the source.** "How do I read a knob
from Postgres / a prompt from disk / a task from DynamoDB" is 100% the adopter's
code, behind three verbs.

> **Every read is a projection.** `get(key)`, `list(query)`, timeline's
> `read()`/`history(cursor)` — all of them are *queries that project from the
> source*. The store is a projection function with a write side.

## The seam (foundational, query-centric)

```ts
/** A change observed on a store's source (the reactive-capability payload). */
export interface Change<T> {
  readonly key: string;
  readonly value?: T; // present on insert/update
  readonly prev?: T;  // present on update/remove
}

/**
 * Store — the thin, source-agnostic seam every store IS.
 *
 * Three verbs. `Q` is the store's QUERY vocabulary (how you ask the source for
 * a projection), `M` is its MUTATION vocabulary (how you change the source).
 * Both are the store's own types — the framework never prescribes a query
 * LANGUAGE, only that a query is a small, serializable description the store
 * translates however it wants (a WHERE clause, a key, a cursor, a path glob).
 */
export interface Store<T, Q = void, M = never> {
  /** Read = a PROJECTION from the source, shaped by a query. Always. */
  query(q: Q, ctx: StoreCtx): Promise<readonly T[]>;

  /** Write = a mutation applied to the source. */
  mutate(m: M, ctx: StoreCtx): Promise<void>;

  /**
   * OPTIONAL reactivity — observe changes the source undergoes (a shared store,
   * a keychain rotation, a Postgres LISTEN/NOTIFY). A store may omit it and be
   * perfectly inert; harnesses that need liveness drive their own notify seam
   * off their writes and only subscribe here for changes they did NOT cause.
   */
  watch?(q: Q, ctx: StoreCtx): AsyncIterable<Change<T>>;

  /** Self-identifying backend label, for observability. */
  readonly backend: string;
}
```

That's the whole foundational contract. `StoreCtx` (Phase 2) carries the runtime
context across the Effect→Promise boundary; the store is Promise-shaped and
source-agnostic.

### Why this is NOT the god-supertype I argued against

Earlier I resisted a `Store` supertype because the *collection* and *log*
conformance barely shared. That still holds — and this doesn't violate it,
because **`Store` is a query/mutation seam, not an inheritance root.**
The two archetypes are not subclasses that inherit machinery; they are
**ergonomic profiles** — named query/mutation vocabularies over the same three
verbs. You reach for the profile, not the raw seam, day to day:

```ts
// COLLECTION profile — keyed CRUD. `Q` = a filter; `M` = put | delete.
export interface CollectionStore<T, Q> extends Store<T, Q, CollectionMutation<T>> {
  // Ergonomic sugar over the seam; each compiles to query()/mutate():
  get(key: string, ctx: StoreCtx): Promise<T | undefined>;      // = query(byKey(key))[0]
  list(query: Q, ctx: StoreCtx): Promise<readonly T[]>;         // = query(query)
  put(item: T, ctx: StoreCtx): Promise<void>;                   // = mutate({ put: item })
  delete(key: string, ctx: StoreCtx): Promise<boolean>;         // = mutate({ delete: key })
}
type CollectionMutation<T> = { readonly put: T } | { readonly delete: string };

// LOG profile — append-only, ordered, cursored. `Q` = a cursor window.
export interface LogStore<T> extends Store<T, LogCursor, LogMutation<T>> {
  read(logKey: string, ctx: StoreCtx): Promise<readonly T[]>;                // = query({ logKey })
  history(logKey: string, w: Window, ctx: StoreCtx): Promise<readonly SeqTagged<T>[]>;
  append(logKey: string, entries: readonly T[], ctx: StoreCtx): Promise<readonly number[]>;
  keys(ctx: StoreCtx): Promise<readonly string[]>;              // enumerate
}
type LogMutation<T> = { readonly append: { logKey: string; entries: readonly T[] } };
```

A store author implements **either profile** (or a bespoke one) — the
`Store` seam is what the *generic* infrastructure (a conformance runner,
a manifest, a wire projector) targets when it must be archetype-agnostic. The
profiles keep the ergonomics; the seam keeps the uniformity. *Both, at different
layers* — no god-object.

## How the various stores fit (the seam is honest across all of them)

Every store is `query` + `mutate` (+ maybe `watch`) over *its* source:

| Store | `query` projects from… | `mutate` writes to… | `watch`? |
|---|---|---|---|
| `MemoryCollection` | an in-process `Map` | the `Map` | fires on write |
| `timeline-postgres` | `SELECT … WHERE thread=$1 AND seq≥$2` | `INSERT … RETURNING seq` | LISTEN/NOTIFY |
| a filesystem `PromptLoader`-store | globbing `.md` files off disk | writing files | fs.watch |
| `JournalProjectedStore` (Phase 2) | **a fold of `ctx.journalReader.readByQuery`** | no-op (writes ARE journaled ops) | `journal.tail` |
| `CredentialsStore` (KV profile) | AWS Secrets Manager `GetSecretValue` (keyed by `ctx.principal`) | `PutSecretValue` | rotation events |

The point: **the framework's code is identical across every row.** It calls
`query`/`mutate`; the row's *nature* — SQL, S3, a journal fold, a keychain — is
sealed inside the adopter's implementation. That's "we don't care how the user
implements the underlying logic."

## The harness holds the projection — NOT the store

This is the part the convergence actually collapses. Today nine harnesses
hand-roll: a sync projection + write-through + `hydrate` + a notify seam +
`exportSnapshot`. That machine is one composable primitive — call it a
**`View`** — and it is *harness-side*, pulling from the store:

```ts
/**
 * View<T> — the harness-held, synchronous PROJECTION of a store.
 *
 * The store is where data lives; the view is the sync working copy the render
 * pass and the sync `exportSnapshot` read (both cannot await — Phase-3 finding).
 * It owns the three moves every store-backed harness re-hand-rolled:
 *   1. hydrate  — pull a projection from the store (query) into the sync cache
 *   2. write    — sync cache first, then mutate the store off the critical path
 *   3. notify   — emit a Change so the harness's channel/subscribers react
 *
 * Reactivity is OPT-IN: a view with no subscribers is a plain write-through
 * cache. Timeline is the log case — `read()` is a query; the view holds the
 * bounded/compacted projection the model sees.
 */
export class View<T, Q, M> {
  private readonly cache = new Map<string, T>();
  private readonly changes = createChangeNotifier<T>();
  constructor(
    private readonly store: Store<T, Q, M>,
    private readonly keyOf: (t: T) => string,
    private readonly toMutation: (t: T) => M, // how a record becomes a store write
  ) {}

  // sync reads — never touch the store (render + exportSnapshot safe)
  getSync(key: string): T | undefined { return this.cache.get(key); }
  listSync(): readonly T[] { return [...this.cache.values()]; }

  // write-through + notify (one place, was 9)
  write(item: T, ctx: StoreCtx): void {
    this.cache.set(this.keyOf(item), item);
    void this.store.mutate(this.toMutation(item), ctx).catch(() => undefined);
    this.changes.emitChange({ key: this.keyOf(item), value: item });
  }

  async hydrate(q: Q, ctx: StoreCtx): Promise<readonly string[]> {
    const items = await this.store.query(q, ctx);
    for (const it of items) this.cache.set(this.keyOf(it), it);
    return items.map(this.keyOf);
  }

  onChange(fn: (c: Change<T>) => void): Unsubscribe { return this.changes.onChange(fn); }
}
```

A harness then becomes: **`View` + its domain logic** (commands, wire,
channel). knobs = `View<KnobEntry>`. state = `View<StateEntry>`.
The *augmented* cases (tasks' live handles, prompts' `render` sidecar,
resources' resolver sidecars — ONE `View<ResourceDeclarationRecord>` over the
single kind-discriminated store, `write` for durable + `seedSync` for transient,
read-partitioned by `kind`) compose a `View` + a domain-owned sidecar — the
pattern prompts already proved.

The **taxonomy this closes** (post-convergence): a store-backed harness holds a
`View` / `LogView` **IFF it has a synchronous read surface** — not merely
because it is store-backed. Every render-read / sync-read harness (knobs, state,
skills, prompts, tasks, timeline, resources) holds one; the deliberate exception
is **credentials**, the async-only, never-rendered store — every read
(`get`/`has`/`keys`) awaits the store LIVE, it holds NO `View` and is not
`SnapshotCapable`. So the rule is not "every harness has a view" but "every
SYNC-READ harness does"; the async-only harness reads the store directly (a
`View` there would be dead weight — a cache no synchronous caller reads).

Nine hand-rolls collapse to one primitive + thin configs; the notify seam (E17)
dissolves into `View.onChange`; conformance is the parity guardrail.

## What this is and isn't

- **Is:** a thin seam (`Store`) + two ergonomic profiles + one harness-
  side projection primitive (`View`). Net *subtraction*: the nine
  storification hand-rolls collapse; E17 and the CollectionProjection variants
  fold in.
- **Isn't:** a mandate that every store be reactive (opt-in `watch`/`onChange`),
  a query *language* (the store owns its query type), or a collapse of the
  store/projection distinction (store = source seam; view = harness projection).
- **North star, not mandate:** `JournalProjectedStore` shows a `query` that is a
  `fold(log)`. Any store *may* be a journal projection; none must be.

## Locked (grounded in the renowned libraries)

1. **The deep `query`/`mutate` seam is the foundation; profiles are sugar.**
   TanStack Query — the cleanest, most-loved library here — has *one* query/
   mutation seam with a serializable key and no "collection vs log" store types;
   the ergonomics (`queryOptions`, `createEntityAdapter`) are sugar on top. We
   follow: `Store.query/mutate` is the seam; `CollectionStore`/`LogStore`
   `get`/`list`/`put`/`append` are ergonomic profiles over it.
2. **The query object stays, `queryKey`-disciplined.** Even TanStack *requires*
   `queryKey`, so `q` is needed — it's what lets the store push the projection
   down to the source (`WHERE`, key, cursor). Concrete failing case: the
   sessions-list must push `appId/status/recent` to Postgres, it can't read every
   session and filter in memory. Discipline: `Q` is a **plain serializable
   description, never a query language** (`['sessions', {appId,status}]`, not a
   fluent builder — the moment it grows operators we've become an ORM). `Q`
   defaults to `void` (session single-record, knobs return-all are `query(ctx)`).
3. **`watch` on the seam, keyed by query** — RxDB's `collection.find(q).$` is
   exactly this and is loved; real sources push (Postgres LISTEN/NOTIFY, keychain
   rotation). Optional; harnesses that own their writes drive their own notify and
   ignore it.
4. **`View` (Svelte-store-shaped) replaces `CollectionProjection`** in
   `store-next` and subsumes the notify seam (E17). We hold this ONE tiny sync
   cache; we do NOT own a client cache/sync engine (the bright line — that's the
   adopter's TanStack/ngrx). We are the seam those libraries are built *on*.

## The convergence cuts (staged, each net-removes + conformance-green)

- **Cut 1 (foundation + proof) — LANDED:** the `Store` seam (spec), `MemoryStore`
  (the in-memory Store) + `View` (store-next), with **knobs + state** migrated
  onto them — collapsing their `CollectionProjection` + the hand-rolled
  `KeyedNotifier`/`ChangeNotifier` into `View`.
- **Cut 2+ (`View` fan-out) — LANDED:** `View` fanned out to the remaining
  harnesses (augmented cases compose view + sidecar); `CollectionProjection`
  retired.
- **Convergence Run 1 (`Store` universal) — LANDED (2026-07-20):**
  `CollectionStore` and `LogStore` are now formal profiles that
  `extends Store<T, Q, M>` (`CollectionStore<T,Q,PruneArg> extends Store<T, Q,
  CollectionMutation<T>>`; `LogStore<T> extends Store<T, LogQuery,
  LogMutation<T>>`), and `CredentialsStore extends Store<CredentialEntry,
  CredentialQuery, CredentialMutation>`. Every concrete store — the in-memory
  defaults, the generic decorators (`IdempotentCollectionStore`,
  `JournalProjectedStore`), the Postgres/Fs adapters, and the credentials stores
  — implements `query`/`mutate`. The archetype split (collection + log) is a
  deliberate ergonomic distinction, both rooted in the ONE `Store` seam; the
  profile methods (`get`/`list`/`put`/`delete`, `read`/`append`/`history`/
  `keys`) stay as sugar. No store-level coexistence remains.
