# v2 Data Layer — working design notes

**Status: EXPLORATION IN PROGRESS — NOT an ADR, nothing decided/committed.**
A compaction of a long design thread so it can be continued fresh. Marked
tentative on purpose. Ryan owns the conviction; this is the map so far.

## The question

How does data get into/out of the framework so that (a) the framework gets the
**minimum it needs**, and (b) the user can do **whatever they want** with their
data — store it anywhere, query it their way, use their own client state — on
**both server and client**?

## Hard constraints / principles

- **Vercel principle (the tension-dissolver).** Opinion lives in the zero-config
  DEFAULT IMPL; flexibility lives in the minimal CONTRACT the framework depends
  on. Different layers → "opinionated" and "flexible" stop fighting. Depend on
  the minimum; ship an opinionated default that satisfies it; escape-hatch at
  every layer.
- **Users own the data.** Framework prescribes SHAPES at the seams (a page, a
  change, content/entry conformance) — NOT storage, query language, joins, or the
  client cache.
- **The framework never defines a query language.** It passes a trivially-small
  "what I need" spec; the query IMPL lives in the store, in the store's own terms.
- **The client is NOT strictly TypeScript.** ⇒ the **wire must be
  language-agnostic** (a protocol any client speaks). TS-typed access is a
  convenience LAYER over the wire, not the wire. **This is why tRPC is out**
  (TS-inference-bound). Types likely come from the store contract generating BOTH
  a wire schema AND TS client types (codegen / shared schema), not runtime
  inference.
- **The framework owns NO client cache.** Client feeds the store's data into its
  OWN state layer (ngrx / TanStack / PouchDB / custom). Framework provides loaders
  - a change signal; the app owns merge / cache / consistency.
  * **THE BRIGHT LINE:** the moment we own merge/cache/consistency we've signed up
    to build a **sync engine** (Replicache / Zero / ElectricSQL / Meteor) — a
    multi-year product, not a feature. Every pull toward "make the client smarter
    about merging" is the wheel we must NOT rebuild.

## Tentatively landed (collapses; low-regret)

- **"Resource" ≈ "Store."** The resource-vs-store split was over-taxonomy. What
  survives: a **Store** (implements the framework minimum + whatever rich methods
  it wants) + its **wire surface** (the subset exposed to the client). Drop
  "Resource" as a distinct primitive.
- **Framework minimum = `append` + `read`(current).** Pull-based: read current
  for context, append output, and steering is a pull-check at the tick boundary
  (ADR 53: `inputEntryCount() > seen`). `observe` (push) is a CLIENT concern
  (channels), NOT a framework need.
- **Interface segregation.** Framework holds a NARROW typed view (`Backing`:
  append/read) — literally can't do more. The user's store is that keyhole + a
  whole room. Client reaches the room via the store's wire surface. "User does
  whatever" and "framework can't be broken by it" are the same fact.
- **Client data plane = wire methods** over the language-agnostic wire. No
  separate client-side Resource machinery.
- **Canonical cursor:** opaque payload, canonical position (continuation token) —
  pass it back for the next page without knowing what's inside. Generic
  pagination with no framework query language. Conform to Relay connections.
- **`raw` opaque escape** on a query for backend-specific needs (join / vector /
  fts) the canonical shape can't express.
- **Stores stay mostly as-is.** `Backing` just NAMES the minimum slice existing
  stores already satisfy. Not a rewrite.

```ts
// the framework's keyhole — the ONLY thing it depends on
interface Backing<T> {
  append(ctx: Ctx, entry: T): Promise<Cursor>;
  read(ctx: Ctx): Promise<readonly T[]>; // the store-BOUNDED current working set (see open #1)
}
// the user's store = Backing + a whole room; the room's public methods are the
// (language-agnostic) wire surface the client calls. Framework never sees the room.
```

## Still open (loose ends — why it isn't loved yet)

1. **`read`/`current` honesty** — the naive-load ghost. Only works if
   store-BOUNDED (working window, not the whole log). "The store decides how much"
   is quiet load-bearing work. Is `current` one honest thing, or secretly two
   (render-window vs. a real read)?
2. **`observe`: framework-need or purely client?** Leaning purely-client + maybe a
   lightweight **wake** for the idle/blocked (full-duplex/live) case. Unsettled.
3. **Exclusive wire namespaces block extending built-ins** — CONFIRMED in
   `gateway/src/wire-registry.ts` ("one extension per namespace", collisions
   throw). A user CANNOT add `timeline/myQuery` to a built-in namespace. Fork:
   allow **namespace augmentation** vs. "bring your own namespace / replace the
   built-in store wholesale."
4. **Which store methods are client-exposed** — "all public" is a security
   footgun; need an explicit marker (`@wire` / a `wire: {}` block / a base class).
   Not zero-ceremony.
5. **Language-agnostic typing** — how the TS convenience layer gets types without
   tRPC inference (shared schema / codegen from the store contract).
6. **The harness / addressing / config-cascade layer PARKED.** The data-layer
   question was extracted from the "trifold substrate / BaseHarness-as-resolution-
   node / addressable entities / config-cascade" thread. Revisit AFTER the data
   contract is nailed. (Key parked idea: the scope tree is ONE resolution tree;
   addressing + config-cascade are two walks of it; BaseHarness becomes a memoized
   resolution node; the interceptor snapshot+live-link hack collapses into one
   `resolve(concern)`.)

## Prior art to CONFORM TO (steal the spec, don't rediscover the pitfall)

- **Ports & Adapters / Repository** — `Backing` is a port; the store an adapter.
- **Event Sourcing + CQRS + Kafka** — log + projection; correction/tombstone/
  compaction — for log-shaped stores (timeline).
- **Relay cursor connections** — pagination; adopt the spec.
- **K8s list+watch (`resourceVersion`)** — observe consistency: watch FROM the
  read's cursor to avoid the snapshot/observe race. (Only if observe stays.)
- **ORM lifecycle hooks** (ActiveRecord/Ent/Prisma/Mongoose) — before/after-save
  transformers; hooks are on the store's verbs.
- **Angular hierarchical DI / React Context / CSS cascade / prototype chain** —
  config cascade (parked harness layer).
- **Actor / Durable Objects / Orleans** — addressing (parked harness layer).
- **AVOID: Replicache / Zero / ElectricSQL / Meteor** (sync engines) — the bright
  line.

## Next concrete step (agreed method — stop designing in the abstract)

SPIKE in isolation, zero churn:

1. `Backing` (append + read) + a default in-memory store.
2. Express the EXISTING timeline as a store fulfilling `Backing` + a rich `query`
   (canonical cursor) — WITHOUT touching other packages.
3. A toy custom user store (pg/todos) to prove "user does whatever."
4. Measure: does timeline fit the minimum cleanly? does the canonical-cursor query
   feel right? does the wire exposure work language-agnostically? where does it
   squeak?

Judge by **parity + fall-out + contained-unknowns**. Squeak at the contract ⇒
learned cheap, no churn spent.

## Meta (how to work this)

- Taste judges _things_, not ideas → build small concrete artifacts to react to.
- Parity is the fear → inventory current behavior from the **conformance suites**
  - ADRs alongside the spike; every behavior maps or is a _documented deliberate
    drop_, never accidental.
- Incremental adoptability is a criterion → if it can't be adopted one store at a
  time coexisting with the old, that's a disqualifier, not a migration cost.
