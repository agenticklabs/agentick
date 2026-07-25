# ADR 49 — Stores, not snapshots: the v2 durability model

**Status:** Draft · 2026-07-01
**Builds on:** ADR 14 (State tiers), ADR 26 (Harness API shape), ADR 27
(Modular built-ins), ADR 32 (Extension shape spectrum), ADR 42 (Slot
dichotomy), ADR 48 (Layered isolation)
**Touches:** `@agentick/spec` (store port types, observation-only),
`@agentick/timeline` (TimelineStore port, flush barrier),
`@agentick/state` (KV store port), `@agentick/session` /
`@agentick/app` (open-or-rehydrate), `@agentick/runtime`
(journal retention — resolves L7), every bundled harness README (state-class
declaration)
**Resolves:** A19 (`PersistenceBackend` shapes — by dissolution), L7
(idempotency-key growth), narrows E11 (restore version migration)

## TL;DR

**A session's durability comes from per-harness store ports plus
re-render, not from snapshots and not from journal replay.**

Session state divides into three classes with three different recovery
stories:

- **Class A — authoritative.** Timeline entries, credentials, skill/prompt
  catalogs. Durable via a **store port**: the harness wraps a
  Promise-shaped store interface; the bundled default is in-memory;
  adopters inject a durable implementation. `CredentialsStore` is already
  the reference shape — this ADR generalizes it.
- **Class B — re-derivable.** Sections, compiled context, tool registry,
  knob descriptors, formatter bindings. Persisted by nothing; recovered by
  **re-render**. *The JSX tree is the schema; render is the recovery
  path.* (Tools are "compiled per tick" — already ratified.)
- **Class C — ephemeral.** `useData` cache (re-fetches by contract),
  in-flight operations, task progress, state-harness K/V and knob values
  by default. Lost on restart unless the harness offers an opt-in store
  port or the adopter seeds them on open.

Consequences:

- **The timeline persisted tier is an append-only event log; recovery is
  its fold (re-render).** This is event sourcing over *outcome* events —
  see "Relationship to event sourcing." Three logs, one per plane:
  timeline (domain, recovery-bearing), operation journal (command +
  telemetry, never recovery-bearing), bus (transport). One mutation
  writes all three, in that order.
- **The journal is an observability + idempotency ledger, not a recovery
  log.** `findOrphaned` remains the crash *diagnostic*; the timeline is
  the crash *recovery*. Commands don't deterministically replay, so
  recovery ≠ journal replay. L7 becomes a TTL/LRU retention fix.
- **Snapshots move state across space; the log moves it across time.**
  `SnapshotCapable` stays for the space-movement jobs (spawn seeding,
  opt-in Class-C hibernation, cluster warm hand-off) — it leaves the
  across-time durability path, where the append-only log is authoritative.
- **Resume = load the log + re-render, on any node.** This is also the
  cluster failover mechanism (no live session migration — see ADR 35/38
  and the execution-lease note below).
- A19 dissolves: there is no monolithic `PersistenceBackend`. There are
  per-harness store ports — two archetypes (append-log, current-state
  KV) — each with its own conformance suite.

The first adopter is the existence proof: Knowify's `V1SessionStore`
(assistant-api) is an incremental write-behind projection of session
events into Postgres, with resume = load rows + rebuild. No snapshot is
ever taken. The local pole wants the same shape with a JSONL transcript
file. Same port, both poles.

## Problem

v2 currently carries **two parallel durability mechanisms and no
designated authority**:

1. `SnapshotCapable` / `ReconcilerSnapshot` / `SessionSnapshot` — a
   checkpoint model. `SessionSnapshot` bundles timeline + knobs + usage;
   the reconciler feature-detects `exportSnapshot` per bridge.
2. `OperationJournal` — an append-only operation log with
   `lookupTerminal` idempotency and `findOrphaned` crash detection, whose
   relationship to recovery was never pinned (A19 open; `DurableJournal`
   "not implementable until continuation primitives ship").

Neither matches what adopters actually do. The tension was already
acknowledged in-session: *"snapshots make sense unless the data/state is
already persisted elsewhere (Pg/other db) and that is the source of
truth."* This ADR resolves it in favor of that instinct.

Undecided durability semantics back-pressure everything downstream:
persistence backends can't be written (what would they store?), E11 can't
be answered (migrate *what* on restore?), L7's fix depends on whether
evicting an idempotency key is a correctness event, and the cluster
failover story (H4–H7) has no mechanism.

## The state-class taxonomy

Every bundled harness declares its class in its README. Current
assignments:

| Harness / state            | Class | Durability story                                                            |
| -------------------------- | ----- | --------------------------------------------------------------------------- |
| Timeline (persisted tier)  | **A** | `TimelineStore` port (this ADR)                                             |
| Timeline (projection tier) | B     | Derived view; rebuilt from persisted tier + `ProjectionStrategy`            |
| Credentials                | **A** | `CredentialsStore` port (shipped — the template)                            |
| Skills / Prompts catalogs  | **A** | Loaders are the read side today; a write-capable store port is additive     |
| Sections / compiled context| B     | Re-render                                                                   |
| Tool registry              | B     | Compiled per tick from the rendered tree                                    |
| Knob descriptors           | B     | Re-declared on mount                                                        |
| Knob values                | C     | Seedable via `initialKnobs`; adopters needing durable knobs use state + KV  |
| State harness K/V          | C     | Opt-in `KeyValueStore` port (this ADR)                                      |
| `useData` cache            | C     | Re-fetch by contract                                                        |
| Tasks (progress/results)   | C     | v2.0: documented lost-on-restart; store port with #292 lifetime work        |
| In-flight operations       | C     | `findOrphaned` reports them; the execution is not resumed (v2.x rung (d))   |

## The store port pattern

Generalized from `CredentialsStore`
(`packages/credentials/src/store.ts`). A store port is:

1. **Promise-shaped.** Implementer-facing surface; the Effect charter's
   "Effect internal, Promise external" rule applies. No Effect types in
   any store port.
2. **Scope-keyed, shared instance.** ONE store instance serves many
   harness instances, keyed by scope (sessionId, namespace) — the ADR 48
   model: per-scope harness over shared backing resource. No per-session
   store construction.
3. **Enumerable.** Every port ships a `keys`/`sessions`-class listing
   method (the enumeration-is-foundational rule). Status-keyed-by-known-id
   is a leaky API.
4. **Self-identifying.** `readonly backend: string` for observability.
5. **Optionally reactive.** `onChange?(listener)` where external mutation
   is meaningful (credentials yes; timeline no — the harness is the only
   writer for a given sessionId while it holds the lease).
6. **Injected flat.** `withX({ store })` / harness constructor option —
   no `config: {}` nesting, per the withX convention. In-memory default
   constructed when absent.
7. **Conformance-suited.** `runXStoreConformance(factory)` per port, so
   adopter implementations are certifiable without reading framework
   internals.

Construction types live with the runtime package that owns the harness;
spec-next carries observation shapes only if they cross the wire.

### Two archetypes

The store port has exactly two shapes, and a harness picks by what its
state fundamentally *is*:

- **Append-log port** — `load` / `append` (+ enumeration, + destructive
  `prune`). The state is a fold over immutable append-only history.
  **Timeline** is the only current instance. This is the event-sourcing
  archetype (see "Relationship to event sourcing").
- **Current-state KV port** — `get` / `set` / `delete` / `keys`. No
  events, no fold, no history. **Credentials, state K/V, task records.**
  A secret has no useful history; you want its *current* value, not its
  audit trail. These are emphatically **not** event-sourced.

Event sourcing is thus the persistence model of *one archetype*, not the
framework. The universal thing is the store port; ES is what an
append-log-backed harness looks like.

## TimelineStore (the flagship port)

Binds to the existing two-tier model
(`spec/src/protocol/timeline-harness.ts`): the **persisted tier** becomes
store-backed; the **projection tier** stays derived and is never stored.

The persisted tier is an **append-only event log** — the port has no
wholesale `replace`. Compaction operates on the *projection* tier only
(see below); the durable log is never rewritten. The single destructive
operation, `prune`, exists for retention / GDPR-class erasure and is
**never called by compaction**.

```ts
/** Promise-shaped durable backing for the timeline persisted tier —
 *  an APPEND-ONLY event log. One instance serves all sessions; entries
 *  are keyed by sessionId. */
export interface TimelineStore {
  /** Full ordered read of a session's persisted entries (the fold input). */
  load(sessionId: string): Promise<readonly TimelineEntry[]>;
  /** Append entries for a session. Called by the write-behind pump
   *  (batched) or per-append in write-through mode. The ONLY write. */
  append(sessionId: string, entries: readonly TimelineEntry[]): Promise<void>;
  /** Enumeration (foundational): which sessions does this store hold? */
  sessions(): Promise<readonly string[]>;
  /** Remove a session's entries entirely (session lifecycle end). */
  delete(sessionId: string): Promise<boolean>;
  /** DESTRUCTIVE retention/GDPR erasure — drop entries matching a
   *  predicate/range. Never called by compaction; the log is otherwise
   *  append-only. Optional: adapters without an erasure requirement omit it. */
  prune?(sessionId: string, before: { seq: number }): Promise<number>;
  readonly backend: string;
}
```

There is deliberately **no `replace`**. Rewriting the persisted log
would make the event-sourcing claim false — an event log you rewrite is
just mutable state with extra steps. Validated in production: Knowify
compacts only the projection; Postgres rows are never deleted, and the
full history is exactly what the persistence-backed inspector wants.

### Authority and write policy

**Memory is authoritative while the process holds the session; the store
trails (write-behind) with a flush barrier.**

- `append`/`queue`/`drain`/`compact` keep their current in-memory
  semantics and Operation envelopes — no latency added inside the tick
  loop.
- A per-session write-behind pump drains appended entries to the store
  in order. **Compaction never touches the store.** `compact` operates
  on the *projection* tier — it folds/summarizes the derived view for
  context-window management. The persisted tier (the durable log) is
  append-only and grows monotonically; the projection is the mutable,
  recompute-from-log view. This is the production-validated split
  (Knowify compacts the projection; the Postgres log is immutable).
- **Flush barrier:** `TimelineHarnessProtocol` gains
  `flush(): Promise<void>` — awaits the pump. The loop executor awaits
  it at **execution end** (and session `close()` awaits it). Invariant:
  *any process that loads the store sees every completed execution.* A
  crash mid-execution loses at most the in-flight turn — consistent with
  what the user experiences (the model call died anyway), and identical
  at both poles.
- **Write-through mode** (`writePolicy: "through"`) awaits the store on
  every append, for adopters whose product semantics demand zero loss.
- Flush failure is an operation failure at the barrier: surfaced on the
  bus as a failed operation, retried per store adapter policy, and the
  session transitions to an errored status rather than silently
  diverging from its store.

### Hydration (open-or-rehydrate)

`app.createSession({ sessionId })` with an id the timeline store already
holds is a **resume**: the timeline harness loads `store.load(sessionId)`
into the persisted tier during `ready`, before first render. Class B
state reconstructs on the first render; Class C applies its per-harness
policy. `SessionSnapshot` remains a *read projection* for observation
(status listings, wire), not a durability vehicle.

This is deliberately the same call, not a separate `resumeSession` —
create-or-resume is idempotent open, which is what stateless-replica
deployments need (any node, any time).

### Reference adapters — the ladder + dependency policy

Four rungs, in adoption order, with an explicit **bundling policy** (the
two-pole test applied to dependencies):

1. **in-memory** — bundled default, zero deps. `:memory:` semantics.
2. **JSONL file** (`@agentick/timeline-fs`) — zero-dep file
   persistence, one append-only transcript file per session.
   Human-greppable; the local-pole durable shape.
3. **SQLite** (`@agentick/timeline-sqlite`) — the *recommended
   first durable adapter* and a natural single-node event store
   (append-only rows, range reads for the fold). **A separate package,
   never bundled into the `agentick` metapackage** — a SQLite driver is
   a native dependency (node-gyp) and its compile cost must stay opt-in.
   Driver choice (`node:sqlite` once stable on our supported matrix vs.
   `better-sqlite3`) is decided when the adapter is written; verify
   `node:sqlite` stability first.
4. **Postgres** (`@agentick/timeline-postgres`) — the **shared
   source of truth across stateless replicas** (the cloud pole; the
   Knowify shape). SQLite-on-local-disk cannot fill this role (single
   writer, local file), so Postgres is not optional for multi-replica —
   it's the cloud-pole default.

Schema policy (all SQL rungs): **frozen tiny schema, opaque JSON
payloads, schema-on-read versioning** — `(session_id, seq, entry JSON)`,
never migrated; entry evolution handled by `specVersion` + pure
migration functions at load (E11). **No ORM** — the surface is a handful
of statements; Kysely-vs-raw-SQL is decided when the first SQL adapter
is written, not here.

**`seq` semantics are pinned on the port (#133, landed):** `seq` is
**store-assigned, strictly increasing, never reused, and stable across
`prune`** — a `BIGSERIAL` column, not a positional index. `append` returns
the assigned seqs; `prune(before: { seq })` erases by *absolute* seq and
survivors keep theirs. The conformance suite validates this against
`MemoryTimelineStore` (which tracks `baseSeq + index`), so a Postgres
serial adapter is conformant out of the box and no cursored recipe is
inexpressible for want of an ordering column. Cursored reads
(`load({ fromSeq })`, seq-tagged entries) remain the deferred additive
extension (open question 1). This is why it was frozen pre-adapter:
schema-on-read protects opaque payloads, not a missing column.

All certified by `runTimelineStoreConformance`, which runs from plain
vitest with no Effect imports.

### Adapter construction — NO `define*` helper (amendment 2026-07-07)

A `defineTimelineStore(hooks)` / generic `defineStore` helper was weighed
and **rejected**. Adapters follow the `CredentialsStore` precedent exactly
(the port this generalizes from ships **no** `defineCredentialsStore`): a
per-backend factory returning an object that `implements TimelineStore`
directly —

```ts
export function fsTimelineStore(opts): TimelineStore { /* … */ }
export function postgresTimelineStore(opts): TimelineStore { /* … */ }
```

Reasoning (weighed across elegance / idiom / performance):

- **No shared code to hoist.** The two archetypes (append-log, current-state
  KV) share a *pattern* (the 7 points) + the *conformance discipline*, not
  code — a `defineStore` supertype would abstract over ~3 lines (`backend`
  label, reject-on-error, enumeration). False unification.
- **A helper can't own the one hard invariant.** `seq` is *backend-assigned*
  (`BIGSERIAL` / line ordinal); a helper that owned `seq` would hold an
  in-process per-session counter and forbid DB-assigned serials — breaking
  the stateless-replica resume story. It could own only trivia
  (load↔history derivation, codec), which is ~5 lines and differs per
  backend anyway. Indirection without leverage.
- **The interface is already the custom seam.** "Go fully custom" = implement
  the 4 load-bearing methods (`append`/`load`/`sessions`/`delete`; `prune`/
  `history` optional) — minimal, and exactly how adopters extend
  `CredentialsStore` today. The `define*` idiom in this repo is reserved for
  spec→factory transforms with real assembly (`defineConnector`,
  `defineCluster`); a store is I/O behind an interface → `create*`/
  `<backend>X(opts)`, not `define*`.
- If author ergonomics ever demand it, ship **pure utilities** (a load↔history
  seq-tag deriver, a default codec) from `timeline-next` — primitives, not a
  wrapper — and only when a *fourth* backend asks (three-consumers rule).

**Escape hatches live in the Postgres factory's options — the library never
owns your schema:** `postgresTimelineStore({ executor /* BYO pg.Pool | {query} */,
table, columns /* map onto existing columns */, sql /* per-op FULL override */,
codec /* jsonb + schema_ver */, migrate: "off" /* default; "create-if-absent"
opt-in — never forced */ })`. Default DDL is *shipped for manual apply*, not
auto-run.

**Performance:** the write-behind pump hands `append(sessionId, entries[])` a
**batch** → one multi-row `INSERT … RETURNING seq` (one round-trip per flush,
not per entry); reads are cold (hydration once per open; `history` paging on
demand) over the indexed PK `(session_id, seq)`; the default codec is
near-zero (pg passes the entry to the driver as `jsonb`; fs `JSON.stringify`s a
line it writes anyway). No wrapper sits in the append path.

## KeyValueStore (state harness, opt-in)

Same pattern, trivial surface: `get/set/delete/has/keys` scoped by
`(sessionId, key)`, `backend`. `withState({ store })`. Default remains
in-memory; `StateHarnessProtocol` is unchanged for reads/writes — the
store rides behind `set`/`delete` operations with the same write-behind
pump + flush barrier. Class C by default means: no store injected → K/V
is ephemeral and the README says so.

## The journal, reclassified

`OperationJournal` keeps its interface (`lookupTerminal`, `readByQuery`,
`tail`, `findOrphaned`) and its jobs:

- **Idempotency** (`lookupTerminal`) — bounded by a retention policy:
  idempotency keys get TTL/LRU eviction (resolves L7). Evicting a key
  past its window is a correctness non-event because the journal is not
  load-bearing for recovery.
- **Observability/audit** — devtools and the future persistence-backed
  production inspector consume it. A durable journal *adapter* is an
  observability feature, not a recovery feature.
- **Crash diagnostics** — `findOrphaned` reports operations stuck
  without a terminal at boot. v2.0 reports; it does not resume.

`DurableJournal extends OperationJournal` stays exactly where it is: the
cluster rung-(d) seam for **durable execution** (resuming in-flight
work), explicitly v2.x, gated on continuation primitives. Nothing in
this ADR blocks it; this ADR simply refuses to make session durability
wait for it.

## Relationship to event sourcing

This ADR *is* event sourcing for the timeline — stated in the
framework's own vocabulary. Naming it precisely prevents two recurring
questions ("why don't we just replay the journal?" and "shouldn't the
event log be more comprehensive?").

### Three planes, one mutation

The system has **three logs, one per plane** — because
event-sourcing-sufficiency and telemetry-comprehensiveness are different
virtues, and one log cannot serve both without the ES fold bloating with
events it must skip:

| Plane | Log | Virtue | Recovery-bearing? |
| --- | --- | --- | --- |
| **Domain** | Timeline persisted tier | **Sufficiency** — exactly the outcome events whose fold reconstructs state | **Yes — the only one** |
| **Command / telemetry** | `OperationJournal` | **Comprehensiveness** — every operation envelope, every phase | No (commands don't deterministically replay) |
| **Transport** | Bus | Fan-out | No (bounded-retention, not a log of record) |

One mutation touches all three planes, in order:

```
timeline append   (durability — the ES log)
   → operation envelope   (audit / idempotency — comprehensive ledger)
   → bus event   (transport — bounded fan-out)
```

Same fact, three planes, three retention policies. **Recovery reads only
the timeline.** The journal is never recovery-bearing — which is the
formal answer to "why not replay the journal."

### Outcome events, not command events (why recovery ≠ journal replay)

The ES fold must be deterministic. What you choose as your *events*
decides whether it can be:

- **Command events** (`call-tool`, `model-tick`) → fold = **re-execute**
  → non-deterministic, expensive, wrong. You cannot replay an LLM call.
- **Outcome events** (the assistant message, the tool *result*) → fold =
  **re-render the declarative tree given the outcomes** → pure, cheap,
  correct.

Timeline entries are *outcomes*. The operation journal holds *commands*.
That is precisely why the timeline is recovery-bearing and the journal
is not — and why re-render (over recorded outcomes) is a sound fold
while journal-replay (over side-effecting commands) is not.

### Scope: ES is one archetype's model, not the framework's

Event sourcing is the persistence model of the **append-log port**
archetype (timeline). The **current-state KV** archetype (credentials,
state K/V, task records) is not event-sourced and should never be — a
secret has no useful history; you want its current value, not its audit
trail. The framework's universal primitive is the store *port*; ES is
what an append-log-backed harness looks like. (See "Two archetypes.")

## Snapshot demotion

**Snapshots move state across *space*; the log moves state across
*time*.** A snapshot ships a session's live state from one process to
another (space); the append-only log reconstructs a session after a
crash (time). They are not competitors — they serve orthogonal axes.
The smell this ADR kills is using a snapshot where *log-across-time* is
the honest mechanism (crash recovery, resume). Used for space-movement,
snapshots are correct and stay.

`SnapshotCapable`, `ReconcilerSnapshot`, and the mapped-type bridge
snapshot machinery are unchanged in shape and keep three
space-movement jobs:

1. **Spawn/seed** — `initialKnobs`/`initialState` at construction.
2. **Opt-in hibernation** — an adopter may capture Class C and reseed it.
3. **Cluster warm hand-off** — moving a live session between nodes can
   ship a snapshot as an optimization over cold rehydrate. Optimization,
   not mechanism: cold rehydrate (log-across-time) must always work.

What changes is the *contract language*: no harness may rely on
snapshot/restore as its durability (across-time) story for Class A
state, and no new code should add snapshot plumbing where a store port
is the honest answer.

## Cluster corollary: failover is rehydration

With store ports in place, node death = next `send` rehydrates the
session on whichever node receives it. The remaining distributed-state
problem is narrow: **execution leases** — at most one node executes a
given session at a time; a lease expires on node loss; a queued send
acquires it. This is a small ownership problem over the existing
partitioning seam, not a state-transfer problem. Live migration
machinery is explicitly out of scope. (Companion note to land with the
cluster workstream; interface sketch deferred to that note.)

## What this does NOT propose

- **No persistence "harness" or subsystem.** Store ports are constructor
  options on existing harnesses — compose primitives, not subsystems.
- **No removal of `SnapshotCapable`** or the reconciler snapshot path.
- **No durable execution.** In-flight operations are not resumed; that
  remains rung (d), v2.x.
- **No journal-replay recovery.** If a future adopter genuinely needs
  event-sourced session rebuild, `readByQuery` exists; nothing here
  forecloses it. It is not the v2.0 contract.
- **No tenancy nouns.** Stores are scope-keyed by sessionId/namespace;
  multi-tenant layering falls out of ADR 48 scope keys + principal.

## Open questions

1. **Paged/lazy timeline load.** `load()` returns the full persisted
   tier; very long sessions may want `load(sessionId, { from, limit })`
   + lazy tail. Defer until a real adopter hits it (Knowify compacts
   aggressively; local transcripts are small). The port can grow an
   optional method without breaking conformance.
2. **Entry wire-shape versioning (E11 residue).** Stored `TimelineEntry`
   rows outlive deploys. Proposal: stamp `specVersion` per store record;
   adapters run pure migration functions at load. Needs a one-pager when
   the first breaking entry-shape change appears.
3. **Knob values: C or A-lite?** Model-set knob values arguably deserve
   durability without adopter ceremony. Holding at Class C (seedable)
   until an adopter asks; revisit with evidence.
4. **Skills/prompts write path.** Loaders cover read-side hydration;
   `remember`-style agent-written skills need a write-capable store.
   Additive follow-up; the port pattern applies verbatim.
5. **`TimelineStore` → `TranscriptStore` rename (deferred).** The
   persisted tier is precisely a *transcript* — the immutable record of
   what was said — so the append-log port is arguably `TranscriptStore`,
   even if the harness stays `timeline` (which correctly names the
   living structure: transcript + projection + queue). Attractive, but a
   rename: it rides the v2.0-cut sweep (#243/#275). **Do not start it
   mid-stream.**

## References

- `packages/credentials/src/store.ts` — the template port
- `packages/spec/src/protocol/timeline-harness.ts` — two-tier model
  this ADR binds to
- `packages/spec/src/protocol/journal.ts` — journal surface
  (unchanged, reclassified)
- `docs/proposals/v2/CUT-PLAN.md` §3 — workstream context, acceptance
  tests (kill-and-resume on both poles)
- Knowify `apps/assistant-api/src/v2/v1-session-store.ts` — production
  prior art (write-behind projection, resume-from-rows)
- ADR 14 (state tiers), ADR 35/38 (cluster seams/ownership), ADR 48
  (per-scope harness over shared resource)
