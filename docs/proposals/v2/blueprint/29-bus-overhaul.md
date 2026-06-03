# ADR 29 — Bus overhaul: log primitive, batching, cursors, distributed-ready

**Status:** Proposed · 2026-06-02
**Builds on:** ADR 26 (Harness as the single shape), ADR 27 (Modular built-ins)
**Touches:** `@agentick/spec` (`EventBus`, `OperationJournal`, `JournalingPolicy`, new `EventLog`/`Cursor`/`CompiledMatcher` exports), `@agentick/runtime` (`LocalEventBus`, `MemoryJournal`, `BaseHarness.emit*` plumbing), future `@agentick/cluster` package.

## TL;DR

The current `EventBus` is shaped for **single-process, single-tenant, one-Queue-per-subscriber, push fan-out**. That shape works for a CLI demo. It does not work for the world we are actually building toward: **multi-tenant cloud deployments with loads of events flowing through a cluster-aware bus**.

Three things need to land, in this order:

1. **Pre-compiled query matchers.** Cheap, additive, ~2× speedup on the per-event filter cost. Shipped already (this commit).
2. **Per-surface batching policy and cursor-based subscriptions.** Turns the per-event hot path from "fan-out per delta" into "batch-append + cursor pull." Subscribers can hibernate / resume / replay within a retention window — for free, because cursors are intrinsic to the log shape.
3. **Unified `EventLog` primitive.** Both `EventBus` and `OperationJournal` become specialisations of the same append-only-log protocol. Local in-memory ring buffer is the default; durable backends (SQLite, Postgres, Kafka) and the cluster backend (`@effect/cluster`) are adapter swaps. **Multi-tenancy is structural at the log level, not bolted on**.

Lazy publish stays — it's a 50 ns cost on the cluster path and free insurance on the local path. The squeeze worth attacking is the **per-event `Effect.runPromise` + `Queue.offer` fan-out**, not the lazy probe.

## What's wrong with the current bus

The Phase 2 in-memory substrate landed `LocalEventBus` with this shape:

```ts
class LocalEventBus {
  subscribers: Map<number, Subscriber>;
  publish(event) {
    if (!hasSub(event.surface)) return Effect.void;
    return Effect.all(
      [...subs].filter(matches).map(sub => Queue.offer(sub.queue, event))
    );
  }
  subscribe(query) {
    const queue = Queue.sliding(256);
    subs.set(id, { query, queue });
    return Stream.fromQueue(queue);
  }
}
```

This is fine as a reference impl. It does not survive contact with:

### 1. Per-event Effect runtime entrance

Adapters today fire `void Effect.runPromise(emitDeltaLazy(...))` per delta. Streaming 1000 tokens means **1000 Effect runtime entrances** per stream. Each entrance is ~5 μs of overhead — runtime setup, scope creation, FiberRef threading. **5 ms wasted per stream on Effect bookkeeping.**

### 2. Per-subscriber Queue.offer + fiber scheduling

`bus.publish` walks every subscriber, filters via `matchesQuery`, and calls `Queue.offer` on each match. Effect's `Queue` is fiber-aware: each offer schedules onto the subscriber's pulling fiber. **~6 μs per delta per subscriber** of fan-out cost in the current impl. Bench numbers (`docs/proposals/v2/REFACTOR-SCRATCHPAD.md` §2026-06-02): attaching ONE subscriber adds ~20 μs per delta of total cost. In a multi-tenant cloud with a tenant-fanout subscriber, an OTel exporter, and a devtools tunnel attached — that's 60+ μs per delta. **At 100 tokens/sec that's 6 ms/sec of CPU on the substrate doing nothing but fan-out.**

### 3. Query walked per event

`matchesQuery(event, sub.query)` walks the EventQuery union on every published event for every subscriber. Polymorphic dispatch through a discriminated union per-event per-sub. Modern V8 inlines a lot of this — bench showed only ~2× win from pre-compilation, not the ~10× I initially estimated — but the win is still real, additive, and the right architectural shape.

### 4. No cursor protocol

Subscribers are push-based via Queue. If a subscriber disconnects (websocket drop, page reload, fiber interrupt), there's no resume — the queue is per-fiber and gone. Multi-tenant cloud absolutely needs **cursor-based resume**: a subscriber comes back, hands the bus its last-seen cursor, and the bus rewinds to that point in retained history.

### 5. Tenancy is bolted on

A bus instance has no concept of tenant. We rely on scope-keyed event metadata + subscriber-side filtering. That's fine when the bus is single-tenant per process, but cross-tenant isolation in a shared deployment means: per-tenant bus instance, per-tenant subscriber index, per-tenant retention. The bus protocol has nothing today that helps you partition.

### 6. No cluster awareness

`hasSubscriber(key)` reads a local map. In a distributed deployment, subscribers can live on other nodes — the local map doesn't see them. The lazy short-circuit would silently drop events some remote subscriber wanted. Fixable, but requires a gossip-replicated subscriber index, which the current shape doesn't anticipate.

## The shape we want

**One primitive: the scoped append-only log.** Producers append (one event or a batch). Subscribers read by cursor. Retention is bounded (in-memory) or unbounded (durable). The shape is identical whether the backing store is an in-process ring buffer, a SQLite table, a Kafka topic, or an `@effect/cluster` sharded log. Local-only deployments use the ring buffer; cloud deployments swap in the cluster backend without changing adopter code.

```ts
// @agentick/spec  (new — generic across event types)
export interface EventLog<E> {
  append(event: E): Effect<void, never, never>;
  appendBatch(events: ReadonlyArray<E>): Effect<void, never, never>;
  read(cursor: Cursor, matcher: CompiledMatcher<E>): Stream<E, never, Scope>;
  hasSubscriberFor(key: EventKey): boolean;
  metrics(): LogMetrics;
}

export interface Cursor {
  readonly value: number; // monotonic position within the log scope
}

export interface LogMetrics {
  readonly eventsPerSecond: number;
  readonly subscriberCount: number;
  readonly cursorLagP99: number; // ms
  readonly dropRate: number; // 0..1
  readonly retentionEvents: number;
}
```

`EventBus extends EventLog<ProtocolEvent>` (with `publish` / `publishLazy` / `subscribe(query)` as bus-specific sugar). `OperationJournal extends EventLog<ProtocolEvent>` (with `lookupTerminal` / `findOrphaned` for journaling-specific reads). Both pluggable. Both share the cursor protocol so durable journals and ephemeral buses can interoperate where useful.

## Per-surface policy

Today's `JournalingPolicy` decides drop / bus-only / always-journal per phase. We extend it:

```ts
// @agentick/spec  (additive — no breaking change)
export interface SurfaceBatchPolicy {
  /** Flush after this many ms elapse since the first queued event. */
  readonly flushAfterMs?: number;
  /** Flush when N events accumulate (whichever fires first). */
  readonly flushAfterCount?: number;
}

export interface SurfaceRetentionPolicy {
  readonly maxEvents?: number;
  readonly maxAge?: number; // ms
}

export interface JournalingPolicy {
  // existing
  readonly alwaysJournal: ReadonlyArray<EventPhase>;
  readonly busOnly: ReadonlyArray<EventPhase>;
  readonly override?: Readonly<Record<string, /* ... */>>;
  // NEW (optional)
  readonly batch?: Readonly<Record<string, SurfaceBatchPolicy>>;
  readonly retention?: Readonly<Record<string, SurfaceRetentionPolicy>>;
}
```

Per-name-prefix policy, longest-prefix match (same shape as the existing `override` table).

### Sensible defaults

| Surface : phase pattern | Batch policy | Retention | Notes |
| --- | --- | --- | --- |
| `executor:*:delta` | flushAfterMs: 8, count: 4 | 1000 events | Imperceptible window for UI streaming (≤8ms latency); halves bus traffic |
| `tool:*:terminal` | (none — flush immediately) | 100 events | Low volume, high importance |
| `session:*:metric` | flushAfterMs: 500 | 10K events | Analytics, no rush |
| `journal:*` | (none) | unbounded (durable) | Durable journal path |

Adopters override via `JournalingPolicy.batch` at harness construction.

## Cursor-based subscriptions

```ts
const sub = bus.subscribe(
  { surface: "executor", phase: "delta" },
  { fromCursor: lastSeenCursor }, // resume from here
);
for await (const event of sub) {
  storeCursor(event.cursor);
  process(event);
}
```

Default `fromCursor` is "now" (no replay). Opt-in cursor lets adopters resume after disconnect / replay for debugging.

**Resume past retention:** if `lastSeenCursor` is older than the retention window, the stream fails with `{ _tag: "CursorExpired" }`. Adopters who want best-effort wrap with their own logic (probably "start from oldest available + emit a typed `missed-events` warning").

## Pre-compiled query matchers

**Shipped.** `compileQuery(query: EventQuery): CompiledMatcher` in `@agentick/runtime`, used at subscribe time in `LocalEventBus` and `MemoryJournal`. Specialises on the common shapes (single surface, single phase, name exact/prefix/segments/wildcard, scope entries pre-snapshotted) and falls back to a generic AND-loop for exotic queries. Per-event filter cost drops ~2× across realistic shapes. Bench numbers in `packages/runtime/src/__bench__/substrate.bench.ts`.

The compiled-matcher type is exported from `@agentick/spec/protocol` so future backends (cluster, durable) consume it directly.

## Multi-tenancy is structural

Each tenant has its own `EventLog` instance. Cross-tenant fan-out is impossible by default; a tenant's subscribers only see the tenant's events because they're reading a tenant-scoped log. The `AppHarness` constructs one log per tenant at session-create time.

```ts
// Local development — single tenant, ring buffer
const app = createApp(MyAgent, { executor: openai("gpt-4o") });

// Multi-tenant cloud — tenant-isolated cluster bus
const app = createApp(MyAgent, {
  executor: openai("gpt-4o"),
  bus: ClusterEventBus.forTenant("tenant-xyz", clusterConfig),
});
```

This is **already pluggable in v2** via the `AppHarnessOptions.bus` slot. ADR 29 doesn't add pluggability — it expands the protocol so pluggable backends can actually be good.

## Distributed `hasSubscriber` via gossip

Cluster-wide subscribers register with the broker; the broker maintains the authoritative subscriber index. Each node caches a replica via gossip, bounded-staleness within ~ms. `hasSubscriber(key)` reads the local replica — still a 50 ns map lookup, just on a different data source.

False positives (occasional publish to a surface that just lost its last sub): wasted envelope, no correctness issue. False negatives (lazy-skip a surface that just got its first sub): bounded by gossip propagation; recoverable for surfaces with `journaling: "always"` policy via cursor replay.

Lives in the future `@agentick/cluster` package. Out of scope for the initial bus overhaul.

## What this fixes vs leaves alone

**Producer hot path becomes:**

```
harness.emit(envelope)
  → bus.append(envelope)            // ring write, ~200 ns
    → per-surface accumulator push  // array.push, ~50 ns
    → if size or fuse: drain()      // batched fan-out, amortized
```

vs. today:

```
harness.emit(envelope)
  → Effect.runPromise(emit pipeline)        // ~5 μs runtime entrance
  → bus.publish(event)
    → Effect.suspend(() => for each sub …)  // ~1 μs
    → Queue.offer per matching sub          // ~1 μs per sub
    → Effect.all                            // ~2 μs fiber scheduling
```

**Per-delta cost target after rollout:** ~500 ns no-sub (today: ~1.7 μs), ~2 μs with one sub (today: ~20 μs). **~10× win in the always-subscribed cloud case** where the entire `Effect.runPromise` + per-sub `Queue.offer` cost amortizes across batches.

**What stays the same:**

- `BaseHarness.emit` / `emitDeltaLazy` / `emitChannel` signatures.
- `app.events(query)` / `session.events(query)` adopter-facing APIs.
- The Stream-based consumer pattern for subscriptions.
- `EventBus` interface remains; we extend it with optional methods.
- `OperationJournal` interface remains; cursor / appendBatch are already on it in spirit.

**Adopters who pass `{ bus: customBus }` today:** their `customBus` keeps satisfying the existing `EventBus` interface. New methods are optional — older buses degrade gracefully (no batching, no cursor resume — just the old per-event push path).

## Lazy publish — keep it

The "is lazy worth the squeeze in multi-tenant cloud" question came up; worth pinning the answer. Lazy is **~50 ns of overhead when a subscriber is present** (map lookup) and **~1 μs of savings when no subscriber is present** (envelope construction skipped). In a cloud setting where someone's always subscribed, lazy's overhead is negligible — keeping it is free insurance and avoids re-adding it for the journal path where construction is genuinely expensive (serialisation, durable IO).

The squeeze worth attacking is **per-event `Effect.runPromise` + per-sub `Queue.offer` fan-out**, not lazy. Batching is the right knife.

## Phased rollout

Each phase is independently shippable. No phase breaks adopter code.

### Phase A — Easy wins (1-2 days, IN PROGRESS)

- ✅ Pre-compiled queries (`compileQuery` in runtime, wired into `LocalEventBus` + `MemoryJournal`). **DONE.**
- Add `appendBatch?` to `EventBus` interface as an optional method (default impl: loop over `append`).
- Add `SurfaceBatchPolicy` + `SurfaceRetentionPolicy` types to `@agentick/spec/data/journaling-policy.ts`. No consumer yet — just the type surface.

### Phase B — Batched LocalEventBus (3-5 days)

- Implement per-surface accumulator in `LocalEventBus`. Fuse via `setTimeout` (or Effect `Schedule`). Drain to current `publish` path in batches.
- Apply default batch policy: `executor:*:delta` 8ms/4, `session:*:metric` 500ms.
- Re-run streaming benches; target ~10× per-delta win with one subscriber.
- Adopter override via `bus = new LocalEventBus({ policy: ... })`.

### Phase C — Cursor protocol + ring buffer (1-2 weeks)

- Define `Cursor`, `CompiledMatcher`, `EventLog<E>` in spec.
- Refactor `LocalEventBus` internals: replace per-subscriber Effect Queue with a shared ring buffer + per-subscriber cursor. Subscribers pull instead of being pushed to.
- Add `subscribe(query, { fromCursor })` option. Default: "now" — no replay.
- Add `metrics()` exposing event rate, subscriber count, p99 cursor lag.
- Migrate `MemoryJournal` to expose the same cursor protocol (it's already log-shaped — mostly renames).
- Old per-subscriber Queue path removed (single code path).

### Phase D — Cluster backend (Phase 5 of v2, 2-4 weeks)

- New `@agentick/cluster` package — `ClusterEventBus` / `ClusterEventLog` over `@effect/cluster`.
- Gossip-based cluster-wide subscriber index. `hasSubscriberFor` reads the local replica.
- Tenant scope partitioning at the log level (one log instance per tenant; shard key includes tenantId).
- `HybridEventBus` composition: same-process subscribers via `LocalEventBus`, remote via `ClusterEventBus`, fanout to both.
- Durable journal backends (SQLite, Postgres) ship as separate adapter packages satisfying `OperationJournal`.

## Open design decisions

These need a call before Phase B lands.

### Where the batch accumulator state lives

**Option (a):** On the `LocalEventBus` instance. One accumulator per bus, partitioned internally by surface. Simpler.

**Option (b):** On `BaseHarness`. Per-harness accumulator, drained via the harness's runtime fiber. Cleaner separation between substrate and policy, but requires plumbing through every harness.

**Recommendation:** **(a)**. Lets multi-tenant cluster bus do the same partitioning without leaking harness internals.

### Cursor semantics on resubscribe past retention

**Option (a):** Typed error (`{ _tag: "CursorExpired" }`). Cleanest contract.

**Option (b):** Start from the earliest available cursor (best-effort). Friendlier, but silently hides data loss.

**Option (c):** Emit a typed `missed-events` envelope before the live stream resumes. Most explicit; most complex.

**Recommendation:** **(a)**. Adopters who want (b) or (c) wrap with their own logic. The substrate contract should be precise.

### EventBus / OperationJournal unification

**Now or later?** They're shaped similarly. Unifying under `EventLog<ProtocolEvent>` makes the cluster work cleaner (one shape for both ephemeral and durable). But it couples the rollout of the bus changes with journal changes.

**Recommendation:** **Later, Phase C+**. Ship the bus refactor first; let the cluster work force the unification when it lands.

### Per-surface vs per-subscriber batching

Current proposal: batches accumulate per-surface (events for `executor:delta` batch together regardless of which subscriber wants them). Alternative: per-subscriber batching (each subscriber gets its own batch fuse).

Per-surface is the right answer: it amortises better (one fan-out per batch vs. one per subscriber per batch) and matches the way distributed log backends work natively. Per-subscriber batching is an adopter concern — they can buffer on their consumer side.

## Why this is the right time

We've shipped four production adapters (OpenAI, Anthropic, Google, AI SDK). The bus surface is now exercised by real-shaped workloads (1000-token streams with subscriber attached). The benchmarks (REFACTOR-SCRATCHPAD §2026-06-02) tell us exactly where the cost lives. Adopter code is small enough that breaking changes are still cheap; large enough that we have to be careful.

The pluggability slot is already there. The protocol is the thing that needs to grow.

## References

- `docs/proposals/v2/REFACTOR-SCRATCHPAD.md` §2026-06-02 — Streaming adapter benchmarks (the numbers driving this)
- `docs/proposals/v2/blueprint/17-open-questions.md` §Substrate scalability + observability (L5-L8 — this ADR closes L8)
- `docs/proposals/v2/blueprint/19-foundation.md` §The PubSub bus (current contract)
- `docs/proposals/v2/blueprint/26-harness-api-shape.md` (the slot pattern this builds on)
- `docs/proposals/v2/blueprint/27-modular-built-ins.md` (the augmentation pattern for new backends)
