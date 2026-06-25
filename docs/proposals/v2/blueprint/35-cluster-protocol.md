# ADR 35 — Cluster protocol + adapter-authoring convention

**Status:** Active · 2026-06-25
**Builds on:** ADR 11 (Cluster — high-level vision), ADR 26 (Harness as the single shape), ADR 29 (Bus overhaul — `ClusterEventBus`/`ClusterJournal`/`ClusterInbox` as substrate-slot fillers), ADR 31 (Harness hierarchy — `Factory<R, P>`, "Cluster mode is a substrate swap"), ADR 36 (define vs create convention).
**Touches:** new `@agentick/cluster-next` protocol package, adapter packages (`@agentick/cluster-ipc-next`, `@agentick/cluster-redis-next`, `@agentick/cluster-nats-next`, future `@agentick/cluster-effect-next`), `@agentick/app-next` (one new substrate-seam hook in `createApp`).

## TL;DR

Cluster mode is a **substrate wrapper** sitting at one well-defined seam: the moment `createApp` finishes building its local `bus / inbox / journal` and is about to expose them to the AppHarness, the cluster (if configured) wraps them with cluster-aware variants that add cross-node transport while preserving local fan-out for node-local subscribers. Everything else in the harness tree is unchanged.

The cluster protocol ships as four typed seams (`ClusterTransport`, `ClusterMembership`, `ClusterPartitioning`, optional `DurableJournal`), each authored via a `defineCluster*` helper that takes a Promise-flavored implementation and produces a `Factory<X, P>`. Adapter authors write boring `async` methods + callback-based subscriptions; the helper bridges to the framework's Effect-typed internal Tag service. Power users who want Effect/Layer composition for their adapter drop into a `/effect` subpath export.

Four-rung ladder for what cluster mode buys, opt-in per deployment:

- **(a)** Single-host multi-process (IPC adapter) — cheapest distribution; share substrate across cores.
- **(b)** Multi-node ephemeral (Redis / NATS adapters) — horizontal scale; sessions die with their node.
- **(c)** Multi-tenant isolation — same transports as (b), partitioning callback shards by tenant.
- **(d)** Durable execution — durable journal + replay primitives. Deferred to v2.x; the protocol seam for it (`DurableJournal` factory slot) lands now so adapters can build toward it.

## What this commits

### 1. The substrate seam

`createApp({ cluster })` adds one optional slot on `AppHarnessOptions`:

```typescript
export interface AppHarnessOptions<P = unknown> {
  // ... existing fields ...
  readonly journal?: OperationJournal | OperationJournalFactory<HarnessShell>;
  readonly bus?: EventBus | EventBusFactory<HarnessShell>;
  readonly inbox?: MessageInbox | MessageInboxFactory<HarnessShell>;
  /**
   * Cluster wrapper (ADR 35). When set, the local bus/inbox/journal
   * (built from the slots above OR defaulted) are wrapped with the
   * cluster's transport so cross-node events / messages route via the
   * configured wire. Absent → local-only behavior; no wrapping; no
   * cluster overhead.
   */
  readonly cluster?: ClusterFactory;
}
```

Construction sequence inside `createApp`:

1. Build local substrate (defaults or adopter-supplied via `bus / inbox / journal` slots) — unchanged.
2. If `cluster` is set, run `cluster(appShell)`. The factory receives the partially-constructed app shell INCLUDING the local substrate. It wraps and returns a `Cluster` object whose `.bus / .inbox / .journal` are cluster-aware versions of the locals.
3. The AppHarness's effective substrate becomes the cluster-wrapped versions.
4. Sessions, harnesses, MCP clients, devtools, the reconciler — everything downstream — construct as today, blind to whether substrate is local or cluster-wrapped.
5. On `app.closeApp()`, the cluster's close is invoked (LIFO, per `parent.onClose(...)`).

The cluster boundary is **entirely at this seam**. No harness below the AppHarness layer has any cluster-awareness in its code.

**Without `cluster` set**, steps 2–3 are skipped. Substrate behaves exactly as it does today. Local single-node deployments pay zero cluster cost.

### 2. The protocol package surface

`@agentick/cluster-next` exports four typed seam interfaces and four corresponding `defineCluster*` authoring helpers.

```typescript
// Seam: cross-node wire transport.
export interface ClusterTransport {
  send(toNode: NodeId, env: MessageEnvelope): Promise<void>;
  broadcast(env: EventEnvelope): Promise<void>;
  subscribeInbox(
    filter: AddressFilter,
    onMessage: (env: MessageEnvelope) => void,
  ): () => void;
  subscribeBus(
    filter: EventFilter,
    onEvent: (env: EventEnvelope) => void,
  ): () => void;
  close(): Promise<void>;
}

// Seam: who's in the cluster.
export interface ClusterMembership {
  readonly currentNode: NodeId;
  nodes(): Promise<readonly NodeId[]>;
  onChange(handler: (change: MembershipChange) => void): () => void;
  close(): Promise<void>;
}

// Seam: who owns what (default = consistent hash on sessionId).
export interface ClusterPartitioning {
  shardKeyFor(address: string): string;
  nodeFor(shardKey: string): Promise<NodeId>;
}

// Seam: durable journal — rung (d). Optional.
export interface DurableJournal extends OperationJournal {
  replay(from: JournalOffset): AsyncIterable<JournalEntry>;
}

// Authoring helpers — one per seam. Each takes a Promise-flavored
// implementation and returns the factory the framework consumes.
export function defineClusterTransport(impl: ClusterTransport): ClusterTransportFactory;
export function defineClusterMembership(impl: ClusterMembership): ClusterMembershipFactory;
export function defineClusterPartitioning(impl: ClusterPartitioning): ClusterPartitioningFactory;
export function defineClusterJournal(impl: DurableJournal): DurableJournalFactory;

// Top-level: bundles the four seams + nodeId into a single cluster factory.
export function defineCluster(spec: DefineClusterConfig): ClusterFactory;
```

Per ADR 36, every `defineX` here returns a `Factory<X, P> = (parent: P) => X | Promise<X> | Effect<X, never, never>`. The framework calls each factory with the appropriate parent at construction time.

### 3. The cluster authoring config

```typescript
export interface DefineClusterConfig {
  /**
   * Node identity. Static or lazy.
   * Lazy thunk runs at construction; resolves env-based node assignment
   * without rebuilding the cluster recipe per environment.
   */
  readonly nodeId: NodeId | (() => NodeId | Promise<NodeId>);
  readonly transport: ClusterTransportFactory;
  readonly membership: ClusterMembershipFactory;
  readonly partitioning?: ClusterPartitioningFactory;  // default: consistent-hash on sessionId
  readonly journal?: DurableJournalFactory;             // rung (d); optional
  /**
   * Default delivery mode for bus subscriptions. Adopters can override
   * per-subscription.
   *   - "node-local-default" (default): subscribers see only events
   *     published on the current node. Cluster-wide opt-in per call.
   *   - "cluster-wide-default": subscribers see all events from all
   *     nodes. Node-local opt-in per call.
   * Most adopters want node-local; management dashboards subscribe
   * cluster-wide explicitly.
   */
  readonly fanoutMode?: "node-local-default" | "cluster-wide-default";
}
```

### 4. Adapter authoring (boring path, the default)

Adapter author writes Promise-flavored impls; helper produces the factory; adopter passes it to `defineCluster`. Zero Effect knowledge required.

```typescript
// @agentick/cluster-redis-next
import Redis from "ioredis";
import {
  defineClusterTransport,
  defineClusterMembership,
} from "@agentick/cluster-next";

export interface RedisTransportOptions {
  readonly url: string | (() => string | Promise<string>);  // lazy-resolvable
  readonly currentNode: NodeId | (() => NodeId);
}

export function redisTransport(opts: RedisTransportOptions): ClusterTransportFactory {
  // The factory's body resolves lazy values, allocates connections,
  // and returns the boring impl. The defineClusterTransport bridge
  // wraps it as a Layer-backed factory internally.
  return defineClusterTransport({
    async send(toNode, env) { /* await pub.publish(...) */ },
    async broadcast(env) { /* await pub.publish(...) */ },
    subscribeInbox(filter, onMessage) { /* subscribe; return unsubscribe */ return () => {}; },
    subscribeBus(filter, onEvent) { /* subscribe; return unsubscribe */ return () => {}; },
    async close() { /* await pub.quit(); await sub.quit(); */ },
  });
}
```

Adopter wiring:

```typescript
import { defineCluster } from "@agentick/cluster-next";
import { redisTransport, redisMembership } from "@agentick/cluster-redis-next";

const cluster = defineCluster({
  nodeId: () => process.env.NODE_ID ?? "node-1",
  transport: redisTransport({ url: () => process.env.REDIS_URL ?? "redis://localhost" }),
  membership: redisMembership({ url: () => process.env.REDIS_URL ?? "redis://localhost" }),
});

const app = await createApp(MyAgent, { cluster });
```

`cluster` here is a `ClusterFactory`; `createApp` calls it at the substrate-seam moment. Adopter code never touches Effect, Layer, or Context.Tag.

### 5. Adapter authoring (power path)

A power-user adapter that wants Effect/Layer composition for its internal DI uses the Effect-flavored Tag service via `/effect` subpath. Adopter passes the resolved Layer to the same `defineCluster` config slot (the framework accepts both shapes for each seam, with `Factory<X, P>`'s Effect return covering Layer composition).

```typescript
// @agentick/cluster-redis-next/effect (subpath)
import { Effect, Layer } from "effect";
import { ClusterTransport } from "@agentick/cluster-next/effect";

export const RedisTransportLayer = Layer.effect(
  ClusterTransport,
  Effect.gen(function* () {
    const redis = yield* RedisService;  // Effect-typed dep
    return {
      send: (to, env) => Effect.tryPromise({ try: () => redis.publish(/* ... */), catch: (cause) => new TransportError({ cause }) }),
      // ... Effect-typed methods
    };
  }),
);
```

The Effect-flavored interface lives at the Tag's service type slot. Boring adapters' Promise methods are wrapped at the helper boundary (`defineClusterTransport`) into the Effect-flavored shape; the framework's runtime sees only the Effect-flavored shape. This two-interface arrangement is local to cluster-next and invisible to anyone not authoring an Effect-flavored adapter.

### 6. The substrate-wrapping mechanics

The cluster's factory body, conceptually:

```typescript
// Inside the ClusterFactory returned by defineCluster:
const factory: ClusterFactory = (appShell) => {
  // appShell.bus / .inbox / .journal are the LOCAL substrate already constructed.
  const nodeId = await resolveLazy(config.nodeId);
  const transport = await runFactory(config.transport, clusterShell);
  const membership = await runFactory(config.membership, clusterShell);
  const partitioning =
    config.partitioning ? await runFactory(config.partitioning, clusterShell) : defaultConsistentHash();
  const journal = config.journal ? await runFactory(config.journal, clusterShell) : undefined;

  const wrappedBus = new ClusterEventBus({
    local: appShell.bus,
    transport,
    membership,
    partitioning,
    fanoutMode: config.fanoutMode ?? "node-local-default",
  });
  const wrappedInbox = new ClusterInbox({
    local: appShell.inbox,
    transport,
    membership,
    partitioning,
  });

  // The cluster carries the wrapped substrate forward; createApp uses
  // these as the AppHarness's effective bus/inbox/journal.
  return {
    bus: wrappedBus,
    inbox: wrappedInbox,
    journal: journal ?? appShell.journal,
    close: async () => {
      await wrappedInbox.close();
      await wrappedBus.close();
      await membership.close();
      await transport.close();
      await journal?.close();
    },
  };
};
```

`ClusterEventBus` and `ClusterInbox` are implementation classes inside `@agentick/cluster-next` that compose the inner local impl with the outer transport. Local subscribers go through the inner bus (cheap, in-process); remote subscribers go through the transport. Inbound remote events are republished into the inner bus so all local subscribers see them uniformly.

### 7. Partitioning + multi-tenant isolation (rung c)

`ClusterPartitioning.shardKeyFor(address)` is a pure function. Default impl extracts the scopeId from the address (e.g., `tasks:session-abc-123` → `session-abc-123`). Adopters override to shard by tenant:

```typescript
const tenantPartitioning = defineClusterPartitioning({
  shardKeyFor: (address) => extractTenantId(address) ?? "default",
  nodeFor: (shardKey) => /* hash ring or table lookup */,
});

const cluster = defineCluster({
  nodeId: () => process.env.NODE_ID,
  transport: redisTransport({ url: "..." }),
  membership: redisMembership({ url: "..." }),
  partitioning: tenantPartitioning,
});
```

All of a tenant's sessions co-locate on the same node (or set of nodes). Cross-tenant routing is impossible by construction — the shard key never crosses tenants. This is the multi-tenant story without inventing a separate "tenant cluster" package.

User-level isolation works the same way — `shardKeyFor: (a) => extractUserId(a)`.

### 8. The adapter ladder

Each rung is opt-in via the choice of transport / membership / journal adapters. The protocol package is the same across all rungs.

| Rung | Use case | Adapter packages |
|---|---|---|
| (a) | Single-host multi-process | `@agentick/cluster-ipc-next` — Node.js IPC + worker_threads / cluster module |
| (b) | Multi-node ephemeral | `@agentick/cluster-redis-next`, `@agentick/cluster-nats-next` |
| (c) | Multi-tenant isolation | Same transports as (b); adopter writes custom `defineClusterPartitioning` |
| (d) | Durable execution | `@agentick/cluster-effect-next` (wraps `@effect/cluster`), or a custom `DurableJournal` adapter |

Rung (d) requires reconciler-level work (continuation primitives, idempotency keys on tool dispatches, replay-safe side-effect markers) that isn't shipped in v2.0. The seam (`DurableJournal` factory slot) ships now so adapters can be built and tested incrementally; the framework consumes the slot once continuation primitives land.

### 9. In-process testing

`@agentick/cluster-next/testing` ships `defineLocalClusterTransport` + `defineLocalClusterMembership` — in-memory impls that route between simulated nodes via shared `LocalEventBus` instances. Adopters and the cluster conformance suite use these to spin up multi-node tests without infrastructure. Same protocol as the real adapters; same code paths; no Docker.

## What this does NOT commit

- **No `Resolvable<T>` exported type.** Lazy config resolution is per-field inline (`T | (() => T | Promise<T>)`); resolution is a one-line helper. Per ADR 36.
- **No new harness type.** Cluster wraps substrate; it doesn't add a new harness level. ADR 11's "App Supervisor as singleton entity" is the cross-node coordination story when needed and lives at the application level using cluster primitives, not as a new framework concept.
- **No automatic session migration on failure.** v2.0: sessions vanish when their owning node dies; clients see disconnect + retry. Recovery via journal replay is rung (d) / v2.x.
- **No automatic schema versioning of cluster envelopes.** Cluster wire payloads ARE the framework's existing `MessageEnvelope` and `EventEnvelope` shapes — they're already JSON-serializable, already versioned via spec evolution. Adapters serialize/deserialize the same way.
- **No `@effect/cluster` coupling in the protocol.** It becomes ONE adapter for rung (d), not the foundation. Adopters who don't want it never see it.

## Conformance

`@agentick/cluster-next/conformance` ships `runClusterTransportConformance(transportFactory)` — a vitest suite covering:

- Ordering guarantees (per-node FIFO for `send`; per-channel ordering for `broadcast`).
- At-least-once vs at-most-once delivery (declared, then verified against the declaration).
- Subscriber lifecycle (unsubscribe MUST drop in-flight deliveries cleanly).
- Resource cleanup on close (no leaked connections / fibers).
- Filter semantics (an `AddressFilter` matches only what it declares).
- Membership change propagation (an event after `onChange` registration is delivered).

Every adapter package's tests invoke the conformance suite against its transport factory + a local LocalCluster pair for cross-node assertions.

## Migration / back-propagation

None for existing v2 code. This is greenfield. The single substrate-seam hook in `createApp` is additive (new optional slot; existing call sites compile unchanged).

## Open questions

These don't block the protocol shape but should be settled before adapter packages ship:

1. **Wire envelope format** — JSON + base64 (cheap, debuggable) vs MessagePack (faster, opaque). Probably JSON for v1; revisit if perf shows up as a problem.
2. **Failure semantics for `broadcast`** — partial node failure: do we report which nodes received, or just resolve when ack-or-timeout passes? Probably the latter; transports that need stronger guarantees can add their own RPC.
3. **Cluster bus replay** — `LocalEventBus`'s `replay` option (#176) doesn't extend to remote subscribers naturally. Adapters that support replay (e.g., Redis Streams) expose it; others don't. Document per adapter.

## References

- ADR 11 — Cluster (high-level vision; this ADR is the concrete protocol).
- ADR 26 — Harness as the single shape.
- ADR 29 — Bus overhaul (introduced cluster-aware substrate seam concept).
- ADR 31 — Harness hierarchy (`Factory<R, P>`, "Cluster mode is a substrate swap").
- ADR 36 — define vs create convention.
