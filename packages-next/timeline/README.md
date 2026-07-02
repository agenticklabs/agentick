# @agentick/timeline-next

The **timeline** harness: an append-only conversation log paired with a
materialized projection. The timeline *is* the conversation — every
message, tool call, and event that happened, plus the compacted/windowed
view the model actually sees.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently. Adopters consume `withTimeline()` +
`TimelineHarness` via the metapackage.

## Status

Shipped: the two-tier harness (persisted log + projection), queue/drain,
compaction strategies, snapshot/restore, the React surface
(`useTimeline`, token-budget helpers), and — **ADR 49** — the durable
**`TimelineStore` port** with a bundled in-memory default, write-behind /
write-through policies, and a `flush()` barrier.

## Where the behavior lives (ADR 27)

**The harness is the single source of behavior; framework bindings are
thin projections of its protocol.** The React surface wraps
`TimelineHarnessProtocol`; an Angular binding would wrap the same one —
parity comes from the protocol, not reimplementation. Litmus test for any
binding component: it contains no behavior unreachable through the
protocol without it.

Because the harness rides the substrate, every operation is reachable
from four altitudes: host code (`session.timeline.append(...)`),
tree-internal logic via the bridge, another process via inbox addressing
(cross-node under cluster), and the wire (a wire extension, ADR 46). What
differs across altitudes is not reachability but **what travels** — and
the rule is simple: **the wire carries verbs and data payloads; it never
carries configuration.**

- **Data-payload ops** (`append`, `queue`) — the payload *is* the
  operation's content, so it crosses every boundary.
- **Signal ops** (`compact`, and any "do the thing now" verb) — the signal
  crosses carrying the verb plus any **serializable advisory data**; the
  session applies its **construction-bound** strategy. The signal is
  "compact session X's timeline now, and here is an advisory hint for the
  strategy if it takes one: `instructions`" — never "compact like *this*".
  Instructions are advisory: the configured `run` decides whether to honor
  them (a truncation strategy ignores them; an LLM-summary strategy folds
  them into its prompt). `session.timeline.compact({ instructions })` at the
  wire; `session.timeline.compact(oneOffStrategy)` is an in-process escape
  hatch. A remote caller *triggers* a compaction and may *hint* it; it never
  *supplies* the strategy.
- **Configuration** (the strategy value itself, a function) is
  **server-resident** — bound where the session is constructed
  (`withTimeline({ compact: rollingSummary({...}) })`), never shipped over
  the wire. The line is **data vs. executable**: verbs + serializable data
  (payloads *and* advisory hints) cross; functions, policy, and secrets do
  not. Same boundary as `credentials-never-cross-wire`, and RCE-safe by
  construction — a client can never ship code that runs server-side.

Precedence, when both a host-injected strategy slot
(`withTimeline({ compact })`) and a call-site strategy exist: **inner scope
wins** — the more-specific mounting point overrides the outer default (the
ADR 50 §2 cascade rule). That override is an in-process affordance; the
wire altitude only carries the trigger. A future `<Timeline>` React
component is a thin projection taking strategy-value props; the same
`rollingSummary({...})` value works at the host and tree altitudes.

## The two-tier model

What this is, in CS terms: an **append-only event log paired with a
materialized projection** (the LSM/WAL + compaction shape; Kafka +
ksqlDB; git's object-db vs. working-tree). See ADR 49
§"Relationship to event sourcing" for the doctrine.

- **Persisted tier** (`_persisted`) — the durable, append-only log. Only
  `append` mutates it; once an entry lands it is never removed or
  modified. The source of truth for "what happened."
- **Projection tier** (`_projection`) — what `read()` / `subscribe()`
  expose. Normally a live mirror of the log; after `compact` or
  `replaceProjection` it diverges (the "compacted prefix + recent" shape).
  **Compaction operates on the projection only** — the durable log is
  never rewritten.

### State classes (ADR 49)

Every bundled harness declares its state classes; this one:

| State                | Class | Recovery story                                                                                                                                          |
| -------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Persisted tier**   | **A** | Authoritative. `TimelineStore` port; append-only; recovered by folding the log on hydrate.                                                              |
| **Projection tier**  | **B** | Re-derived from the persisted tier. Caveat: when compaction is LLM-backed, re-materializing is a **cost event** (a model call), not free — durable memoization of a compaction is an adopter recipe, never a framework concept. |
| **Pending queue**    | **C** | Ephemeral. Input staged by `queue()` but not yet `drain()`-ed is memory-only — a crash in that window loses it (small in practice: `send` triggers `drain` in the same execution, but it is a real window, stated not discovered). |

## Durability — "stores, not snapshots" (ADR 49)

The persisted tier is backed by a **`TimelineStore`** — an append-only
event log keyed by `sessionId`. Recovery is a *fold* over that log
(`store.load(sessionId)` → the persisted tier), not a snapshot restore.
This is the store-port pattern generalized from `CredentialsStore`.

**Memory is authoritative** while a process holds the session; the store
trails via a **write-behind pump**, drained at a **`flush()` barrier**.
The invariant: *any process that loads the store sees every completed
execution.* A crash mid-execution loses at most the in-flight turn.

```ts
import { TimelineHarness, MemoryTimelineStore } from "@agentick/timeline-next";

// Default: bundled in-memory store, write-behind.
const timeline = new TimelineHarness(sessionId, journal, bus, inbox);

// Durable: inject an adapter + choose a write policy.
const durable = new TimelineHarness(sessionId, journal, bus, inbox, {
  store: myTimelineStore,      // fs / sqlite / postgres / custom
  writePolicy: "behind",       // or "through" for zero-loss appends
});

await durable.append(entry);   // memory updated synchronously
await durable.flush();          // entry is now durable in the store

// Resume: load the durable log into memory (open-or-rehydrate).
await durable.hydrate();
```

- **`writePolicy: "behind"`** (default) — appends never wait on the
  store; the pump drains asynchronously and `flush()` (awaited by the
  loop executor at execution end and by `session.close()`) guarantees
  durability. A buffered write failure is surfaced by `flush()`.
- **`writePolicy: "through"`** — every append awaits the store, for
  products that demand zero loss at the cost of per-append latency. A
  store failure fails the append operation.

There is deliberately **no `replace`** on the store: rewriting the log
would make the event-sourcing claim false. The one destructive op,
`prune`, is for retention / GDPR erasure and is never called by
compaction.

## API

### `TimelineHarness`

Construction: `new TimelineHarness(scopeId, journal, bus, inbox, options?)`.
`options` (`TimelineHarnessOptions`): `store?`, `writePolicy?`, plus the
`BaseHarnessOptions` (`principal`, `parent`, …).

- `read()` / `subscribe()` — the projection view (sync, `useSyncExternalStore`-safe).
- `readPersisted()` — the durable log (tooling / custom compactors).
- `append(...entries)` — append to log + projection; durably backed per policy.
- `flush()` — await the write-behind barrier (ADR 49).
- `hydrate()` — load the store's log into memory (resume path).
- `queue(...)` / `drain()` — pending-input staging.
- `compact(strategy)` / `replaceProjection(...)` / `resetProjection()` — projection ops.
- `exportSnapshot()` / `importSnapshot(...)` — space-transfer read projection (spawn seeding, cluster hand-off), **not** the durability path.
- `backend` — the store's backend label (`"memory"`, …).

### `TimelineStore`

The durable persisted-tier port. Implement it for a custom backend;
`load` / `append` / `sessions` / `delete`, optional `prune`, `backend`.

### `MemoryTimelineStore`

The bundled zero-dep default (`Map<sessionId, TimelineEntry[]>`).

### `runTimelineStoreConformance({ label, factory, capabilities? })`

The conformance suite every adapter must pass.

### `runTimelineHarnessConformance(deps)`, `withTimeline(options)`

The harness conformance suite and the session-extension factory
(`withTimeline` installs the harness under the `timeline` bridge slot).

### Compaction strategies — `@agentick/timeline-next/strategies`

Strategy-value factories live at the `/strategies` subpath (parallel to
`@agentick/skills-next/loaders`) — they return `CompactStrategy` **values**,
not `withX` extensions. `fromHandler({ handler })` is the raw escape hatch;
named policies (`rollingSummary`, `slidingWindow`) land there as built.
Pass the value to `harness.compact(...)` or (once A2.2 threads it) the
`withTimeline({ compact })` slot.

```ts
import { fromHandler } from "@agentick/timeline-next/strategies";
await timeline.compact(fromHandler({ handler: async ({ entries }) => entries.slice(-20) }));
```

## Verified by

- `src/__tests__/store.spec.ts` — `MemoryTimelineStore` passes the full
  `TimelineStore` conformance suite (append-only ordering, per-session
  isolation, `load` fold, defensive copy, enumeration, idempotent
  delete, `prune`).
- `src/__tests__/harness-store.spec.ts` — the harness × store wiring:
  write-behind drains at the `flush()` barrier in order; write-through
  persists synchronously; `hydrate()` loads the durable log; `close()`
  flushes; **compaction never touches the store** (persisted tier stays
  append-only); a store-write failure surfaces (flush rejects /
  write-through append throws); default bundled store; `flush()` no-op
  when nothing is buffered.
- `src/__tests__/*` — the pre-existing harness conformance
  (`runTimelineHarnessConformance`), queue/drain, compaction, and
  snapshot/restore suites.

## Roadmap & known gaps

- **Hydration is a seam, full-load is its default (A2.2)**: `hydrate()`
  today is the default implementation — load the whole log. A2.2 makes
  `app.createSession({ sessionId })` open-or-rehydrate through that seam,
  which will take an **executable strategy value** (loaders idiom, e.g.
  `hydration: checkpointTimeline({...})`), and whose result may seed both
  tiers (`{ persisted, projection? }` — a checkpoint recipe seeds the
  summary projection alongside the persisted tail). **The framework never
  defines a "checkpoint" concept** — checkpoint-plus-tail is an adopter
  recipe closing over their own summary storage. Full-load stays the
  default, not a limitation.
- **Barrier wiring (A2.2)**: the loop executor does not yet await
  `flush()` at execution end, and `createSession` does not yet thread the
  store down. Today the harness exposes `hydrate()` / `flush()` for direct
  use (`TODO(A2.2)` markers at the call sites).
- **Errored-status transition + retry on write failure**: `flush()`
  surfaces a buffered write failure (typed `TimelineWriteFailed`) and
  leaves the error latched, but the session→errored transition
  (`catchTag`) and adapter retry policy belong at the session/loop-executor
  barrier (ADR 49) and are not implemented here.
- **`seq` is implicit, must become first-class before any DB adapter**:
  `prune` takes `{ seq }` but entries don't carry it and the memory store
  treats it positionally (renumbers on prune). ADR 49's frozen-schema rule
  requires `seq` be a **stable, monotonic, append-assigned** ordering key
  (survives prune, never reused) so all adapters agree and a cursor stays
  valid — schema-on-read protects opaque payloads, not a missing ordering
  column. Pinning this is the first item of A2.2; cursored `load` options /
  `history()` paging stay additive after.
- **`readPersisted()` is synchronous + full-in-memory** — the one baked
  opinion that caps session length in RAM. Deliberately deferred; the
  future fix pages by `seq` (another reason to pin it). Keep new code off
  new synchronous full-read dependencies so that change stays non-breaking.
- **Reference adapters**: `@agentick/timeline-fs-next` (JSONL, local
  pole), `@agentick/timeline-sqlite-next` (recommended first durable;
  native dep, never bundled), `@agentick/timeline-postgres-next` (cloud
  pole) are separate follow-on packages. The port is locked, so they're
  additive.
