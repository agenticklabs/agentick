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

## The two-tier model

What this is, in CS terms: an **append-only event log paired with a
materialized projection** (the LSM/WAL + compaction shape; Kafka +
ksqlDB; git's object-db vs. working-tree).

- **Persisted tier** (`_persisted`) — the durable, append-only log. Only
  `append` mutates it; once an entry lands it is never removed or
  modified. The source of truth for "what happened."
- **Projection tier** (`_projection`) — what `read()` / `subscribe()`
  expose. Normally a live mirror of the log; after `compact` or
  `replaceProjection` it diverges (the "compacted prefix + recent" shape).
  **Compaction operates on the projection only** — the durable log is
  never rewritten.

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

### `runTimelineHarnessConformance(deps)`, `withTimeline(options)`, `withHandler(options)`

Harness conformance suite, the session-extension factory, and the
compaction-strategy helper.

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

- **Session hydration wiring (A2.2)**: `app.createSession({ sessionId })`
  does not yet thread the store down and call `hydrate()` at session
  init, and the loop executor does not yet await `flush()` at execution
  end. Today the harness exposes `hydrate()` / `flush()` for direct use;
  the cross-package `session-next` / loop-executor barrier wiring is the
  next slice (`TODO(A2.2)` markers at the call sites).
- **Errored-status transition + retry on write failure**: `flush()`
  surfaces a buffered write failure and leaves the error latched, but the
  session→errored transition and adapter retry policy belong at the
  session/loop-executor barrier (ADR 49) and are not implemented here.
- **Reference adapters**: `@agentick/timeline-fs-next` (JSONL, local
  pole), `@agentick/timeline-sqlite-next` (recommended first durable;
  native dep, never bundled), `@agentick/timeline-postgres-next` (cloud
  pole) are separate follow-on packages. The port is locked, so they're
  additive.
