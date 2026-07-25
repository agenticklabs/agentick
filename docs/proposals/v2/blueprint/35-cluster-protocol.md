# ADR 35 — Cluster protocol + adapter-authoring convention

**Status:** Active · 2026-06-25
**Builds on:** ADR 11 (Cluster — high-level vision), ADR 26 (Harness as the single shape), ADR 29 (Bus overhaul — `ClusterEventBus`/`ClusterJournal`/`ClusterInbox` as substrate-slot fillers), ADR 31 (Harness hierarchy — `Factory<R, P>`, "Cluster mode is a substrate swap"), ADR 36 (define vs create convention).
**Touches:** new `@agentick/cluster` protocol package, adapter packages (`@agentick/cluster-ipc`, `@agentick/cluster-redis`, `@agentick/cluster-nats`, future `@agentick/cluster-effect`), `@agentick/app` (one new substrate-seam hook in `createApp`).

## TL;DR

Cluster mode is a **substrate wrapper** sitting at one well-defined seam: the moment the gateway (canonical) or app (fallback) finishes building its local `bus / inbox / journal`, the cluster (if configured) wraps them with cluster-aware variants that add cross-node transport while preserving local fan-out for node-local subscribers. Children inherit the wrapped substrate via the factory-pattern parent-chain; everything else in the harness tree is unchanged.

Cluster is **not** a harness. It emits diagnostic events on the bus it wraps (`surface: "cluster"` — node membership, partition state, routing failures, transport reconnects), visible to any subscriber. State queries flow through a thin read-only `Cluster` value the adopter can access from the harness it's configured on.

The cluster protocol ships as five typed seams (`ClusterTransport`, `ClusterMembership`, `ClusterPartitioning`, `ClusterCodec`, optional `DurableJournal`), each authored via a `defineCluster*` helper that takes a Promise-flavored implementation and produces a `Factory<X, P>`. Adapter authors write boring `async` methods + callback-based subscriptions; the helper bridges to the framework's Effect-typed internal Tag service. Power users who want Effect/Layer composition for their adapter drop into a `/effect` subpath export.

Four-rung ladder for what cluster mode buys, opt-in per deployment:

- **(a)** Single-host multi-process (IPC adapter) — cheapest distribution; share substrate across cores.
- **(b)** Multi-node ephemeral (Redis / NATS adapters) — horizontal scale; sessions die with their node.
- **(c)** Multi-tenant isolation — same transports as (b), partitioning callback shards by tenant.
- **(d)** Durable execution — durable journal + replay primitives. Deferred to v2.x; the protocol seam for it (`DurableJournal` factory slot) lands now so adapters can build toward it.

## What this commits

### 1. The substrate seam

Per ADR 31 (Gateway is the runtime root that owns top-level substrate), the **canonical placement for the `cluster` slot is `GatewayHarnessOptions`**. Gateway wraps its own substrate with the cluster; AppHarness inherits that wrapped substrate via the factory-pattern parent-chain; sessions inherit from their app. One configuration point, propagates the whole way down.

The slot also lives on `AppHarnessOptions` for two cases: (a) test scaffolding that doesn't stand up a gateway, (b) the rare case of differently-clustered apps under one gateway. Same `ClusterFactory` shape at both sites; gateway is the production default.

```typescript
// Canonical placement (production):
export interface GatewayHarnessOptions {
  // ... existing fields ...
  readonly journal?: OperationJournal | OperationJournalFactory<HarnessShell>;
  readonly bus?: EventBus | EventBusFactory<HarnessShell>;
  readonly inbox?: MessageInbox | MessageInboxFactory<HarnessShell>;
  /**
   * Cluster wrapper (ADR 35). When set, the gateway's local
   * bus/inbox/journal (built from the slots above OR defaulted) are
   * wrapped with the cluster's transport so cross-node events / messages
   * route via the configured wire. Apps under this gateway inherit the
   * wrapped substrate via the factory-pattern parent-chain.
   * Absent → local-only behavior; zero cluster overhead.
   */
  readonly cluster?: ClusterFactory;
}

// Fallback placement (test / no-gateway / per-app override):
export interface AppHarnessOptions<P = unknown> {
  // ... existing fields ...
  readonly cluster?: ClusterFactory;
}
```

Construction sequence (wherever the slot is set):

1. Build local substrate (defaults or adopter-supplied via `bus / inbox / journal` slots) — unchanged.
2. If `cluster` is set, run `cluster(parentShell)`. The factory receives the partially-constructed shell INCLUDING the local substrate. It wraps and returns a `Cluster` object whose `.bus / .inbox / .journal` are cluster-aware versions of the locals.
3. The harness's effective substrate becomes the cluster-wrapped versions; children inherit via the factory pattern.
4. Sessions, harnesses, MCP clients, devtools, the reconciler — everything downstream — construct as today, blind to whether substrate is local or cluster-wrapped.
5. On harness close, the cluster's close is invoked (LIFO, per `parent.onClose(...)`).

The cluster boundary is **entirely at this seam**. No harness below the cluster-defining layer has any cluster-awareness in its code.

**Without `cluster` set**, steps 2–3 are skipped. Substrate behaves exactly as it does today. Local single-node deployments pay zero cluster cost.

### 1a. Observability surface — bus events, not a harness

Cluster is **not** a harness. A harness needs substrate to construct; cluster IS the substrate-wrapping layer. Making it a harness creates circularity (parent provides substrate; cluster wraps substrate; what's cluster's parent?).

But cluster is also **not fully invisible**. It emits diagnostic events on the bus it wraps, with `surface: "cluster"`:

- `cluster:node:joined` / `cluster:node:lost`
- `cluster:partition:detected` / `cluster:partition:healed`
- `cluster:routing:dropped` (message couldn't reach destination)
- `cluster:transport:reconnecting` / `cluster:transport:reconnected`
- `cluster:journal:backpressure` (durable journal write-back-pressure, rung d)

Anyone subscribed to the bus (devtools, management dashboard, OTel exporter, the adopter's own monitoring) sees these naturally. Telemetry flows through the same path as everything else — no new export surface, no new subscription model.

Adopters that need to query cluster state (not just observe events) read it from the materialized `Cluster` value — a thin read-only object exposing:

```typescript
export interface Cluster {
  readonly bus: EventBus;
  readonly inbox: MessageInbox;
  readonly journal: OperationJournal;
  readonly currentNode: NodeId;
  nodes(): Promise<readonly NodeId[]>;
  /** Maps an address → owning node, via the configured partitioning. */
  ownerOf(address: string): Promise<NodeId>;
  close(): Promise<void>;
}
```

Read-only. No methods that mutate cluster state — partitioning rebalances, transport reconnects, membership transitions all happen internally as the underlying adapters drive them.

### 2. The protocol package surface

`@agentick/cluster` exports five typed seam interfaces and five corresponding `defineCluster*` authoring helpers.

```typescript
// Seam: cross-node wire transport.
export interface ClusterTransport {
  send(toNode: NodeId, env: MessageEnvelope): Promise<void>;
  broadcast(env: EventEnvelope): Promise<void>;
  subscribeInbox(filter: AddressFilter, onMessage: (env: MessageEnvelope) => void): () => void;
  subscribeBus(filter: EventFilter, onEvent: (env: EventEnvelope) => void): () => void;
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

// Seam: wire serialization. Translates between the framework's typed
// envelope shapes and the bytes/string transports send on the wire.
// Sits at the edges of every transport call — transports never
// JSON.stringify or msgpack-encode directly. Swappable per cluster:
// JSON for debuggable default, MessagePack for performance, protobuf
// for strict schemas.
export interface ClusterCodec {
  encode(env: MessageEnvelope | EventEnvelope): Uint8Array | string;
  decode(raw: Uint8Array | string): MessageEnvelope | EventEnvelope;
}

// Authoring helpers — one per seam. Each takes a Promise-flavored
// implementation and returns the factory the framework consumes.
export function defineClusterTransport(impl: ClusterTransport): ClusterTransportFactory;
export function defineClusterMembership(impl: ClusterMembership): ClusterMembershipFactory;
export function defineClusterPartitioning(impl: ClusterPartitioning): ClusterPartitioningFactory;
export function defineClusterJournal(impl: DurableJournal): DurableJournalFactory;
export function defineClusterCodec(impl: ClusterCodec): ClusterCodecFactory;

// Top-level: bundles the seams + nodeId into a single cluster factory.
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
  readonly partitioning?: ClusterPartitioningFactory; // default: consistent-hash on sessionId
  readonly journal?: DurableJournalFactory; // rung (d); optional
  /**
   * Wire serialization codec. Default: JSON (universal, debuggable).
   * Swap for MessagePack (performance), protobuf (strict schemas), or
   * a custom codec for non-standard wires.
   */
  readonly codec?: ClusterCodecFactory;
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
// @agentick/cluster-redis
import Redis from "ioredis";
import { defineClusterTransport, defineClusterMembership } from "@agentick/cluster";

export interface RedisTransportOptions {
  readonly url: string | (() => string | Promise<string>); // lazy-resolvable
  readonly currentNode: NodeId | (() => NodeId);
}

export function redisTransport(opts: RedisTransportOptions): ClusterTransportFactory {
  // The factory's body resolves lazy values, allocates connections,
  // and returns the boring impl. The defineClusterTransport bridge
  // wraps it as a Layer-backed factory internally.
  return defineClusterTransport({
    async send(toNode, env) {
      /* await pub.publish(...) */
    },
    async broadcast(env) {
      /* await pub.publish(...) */
    },
    subscribeInbox(filter, onMessage) {
      /* subscribe; return unsubscribe */ return () => {};
    },
    subscribeBus(filter, onEvent) {
      /* subscribe; return unsubscribe */ return () => {};
    },
    async close() {
      /* await pub.quit(); await sub.quit(); */
    },
  });
}
```

Adopter wiring:

```typescript
import { defineCluster } from "@agentick/cluster";
import { redisTransport, redisMembership } from "@agentick/cluster-redis";

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
// @agentick/cluster-redis/effect (subpath)
import { Effect, Layer } from "effect";
import { ClusterTransport } from "@agentick/cluster/effect";

export const RedisTransportLayer = Layer.effect(
  ClusterTransport,
  Effect.gen(function* () {
    const redis = yield* RedisService; // Effect-typed dep
    return {
      send: (to, env) =>
        Effect.tryPromise({
          try: () => redis.publish(/* ... */),
          catch: (cause) => new TransportError({ cause }),
        }),
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
  const partitioning = config.partitioning
    ? await runFactory(config.partitioning, clusterShell)
    : defaultConsistentHash();
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

`ClusterEventBus` and `ClusterInbox` are implementation classes inside `@agentick/cluster` that compose the inner local impl with the outer transport. Local subscribers go through the inner bus (cheap, in-process); remote subscribers go through the transport. Inbound remote events are republished into the inner bus so all local subscribers see them uniformly.

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

| Rung | Use case                  | Adapter packages                                                                                |
| ---- | ------------------------- | ----------------------------------------------------------------------------------------------- |
| (a)  | Single-host multi-process | `@agentick/cluster-ipc` — Node.js IPC + worker_threads / cluster module                    |
| (b)  | Multi-node ephemeral      | `@agentick/cluster-redis`, `@agentick/cluster-nats`                                   |
| (c)  | Multi-tenant isolation    | Same transports as (b); adopter writes custom `defineClusterPartitioning`                       |
| (d)  | Durable execution         | `@agentick/cluster-effect` (wraps `@effect/cluster`), or a custom `DurableJournal` adapter |

**Wire codec adapter packages** (cross-cutting; any rung):

| Codec       | Use case                                                                   | Package                                                                  |
| ----------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| JSON        | Default — debuggable, universal                                            | bundled in `@agentick/cluster`                                      |
| MessagePack | Performance-sensitive deployments                                          | `@agentick/cluster-codec-msgpack`                                   |
| Protobuf    | Strict schema enforcement; multi-language clusters                         | `@agentick/cluster-codec-protobuf` (ships .proto schemas alongside) |
| Custom      | Adopter-defined wire (e.g., FlatBuffers, CBOR, encrypted-at-rest variants) | `defineClusterCodec` in adopter code                                     |

Rung (d) requires reconciler-level work (continuation primitives, idempotency keys on tool dispatches, replay-safe side-effect markers) that isn't shipped in v2.0. The seam (`DurableJournal` factory slot) ships now so adapters can be built and tested incrementally; the framework consumes the slot once continuation primitives land.

### 9. In-process testing

`@agentick/cluster/testing` ships `defineLocalClusterTransport` + `defineLocalClusterMembership` — in-memory impls that route between simulated nodes via shared `LocalEventBus` instances. Adopters and the cluster conformance suite use these to spin up multi-node tests without infrastructure. Same protocol as the real adapters; same code paths; no Docker.

### 10. Deployment tiers — picking a wire (Phase 4f / 4g)

Adopters pick a cluster wire by deployment tier, NOT by intrinsic feature preference. The honest tier matrix:

| Tier                                 | Wire             | Adopter config                                                                            | When                                                                                                                                                                                                                                            |
| ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dev / single-process**             | none             | `createApp(...)` (no `cluster:` option)                                                   | Local development, single-node tests. No clustering needed.                                                                                                                                                                                     |
| **Single-host multi-worker**         | Unix socket      | `defineUnixCluster({ socketPath })` + optional `electableUnixClusterNode` for re-election | PM2 fork-mode, Node cluster module, worker pools on one large box. Auto-elect via `tryBindOrConnectUnix`; first-to-bind becomes broker. Re-election on broker death (Phase 4f.3) keeps the cluster healing without external supervisor restart. |
| **Multi-host production**            | Redis            | `defineRedisCluster({ pubClient, subClient })`                                            | Multi-host, k8s, anywhere across machines. Redis (Sentinel / Cluster / Valkey / KeyDB / Dragonfly) is the broker. HA / failover / monitoring are Redis's responsibility — adopters use their existing ops infrastructure, not ours.             |
| **Edge / Redis-allergic multi-host** | TCP or WebSocket | `defineTcpCluster` / `defineWsCluster`                                                    | Specialized: embedded deployments, air-gapped systems, "we don't want another infra dep." External supervisor (PM2 / systemd / k8s) provides HA.                                                                                                |

**Mental model:** broker = "the thing that holds soft-state routing." For multi-host, Redis IS the broker. The TCP / Unix / WS broker we ship is the option for single-host (Unix) or specialized edge (TCP/WS) cases — not the recommended multi-host path. Multi-host production = Redis. Document that clearly to adopters so they don't reach for our broker when they want a production cluster.

**Why no built-in HA for our broker?** External supervisor (PM2 / systemd / k8s) restart is the documented Phase 4 HA story. Internal re-election (Phase 4f.3) handles single-host scenarios where bind-race makes sense. Cross-host HA requires consensus (Raft, etcd-style) — the wrong-shape problem for v2.0 when Redis Sentinel solves it for free. We don't reinvent the HA wheel; we delegate to infrastructure adopters already operate.

**Phase 4 hardening additions for the broker tiers:**

- **4f.4 backpressure** — bounded per-connection write queue; one slow client can't stall fan-out (`BoundedWriteQueue` in `@agentick/cluster-broker`).
- **4f.5 BrokerCodec adapter** — broker-frame schema separated from envelope schema; one cast lives in the adapter, not scattered across call sites.
- **4f.6 graceful shutdown** — `broker.close()` flushes pending Goodbye frames before tearing down the listener; adopters wire `process.on("SIGTERM")` for k8s rolling deploys.

**Phase 5 candidates** (NOT committed in Phase 4):

- DurableJournal adapter for Redis Streams (rung d).
- `createGateway({ cluster })` fusion — adopter doesn't manage cluster manually; the gateway handles it.
- Real-Redis conformance suite via docker-compose (Phase 4g.4 lands fake-Redis integration; real-Redis is its own infra task).
- 3-replica Otto demo (proof-point of the deploy story end-to-end).

## What this does NOT commit

- **No `Resolvable<T>` exported type.** Lazy config resolution is per-field inline (`T | (() => T | Promise<T>)`); resolution is a one-line helper. Per ADR 36.
- **No new harness type.** Cluster wraps substrate; it doesn't add a new harness level. ADR 11's "App Supervisor as singleton entity" is the cross-node coordination story when needed and lives at the application level using cluster primitives, not as a new framework concept.
- **No automatic session migration on failure.** v2.0: sessions vanish when their owning node dies; clients see disconnect + retry. Recovery via journal replay is rung (d) / v2.x.
- **No automatic schema versioning of cluster envelopes.** Cluster wire payloads ARE the framework's existing `MessageEnvelope` and `EventEnvelope` shapes — already versioned via spec evolution. The wire SERIALIZATION (JSON / MessagePack / protobuf) is swappable per `ClusterCodec`; schema-versioned codecs (protobuf) can enforce strict versioning where adopters need it.
- **No `@effect/cluster` coupling in the protocol.** It becomes ONE adapter for rung (d), not the foundation. Adopters who don't want it never see it.

## Conformance

`@agentick/cluster/conformance` ships `runClusterTransportConformance(transportFactory)` — a vitest suite covering:

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

1. **~~Wire envelope format~~** — resolved via `ClusterCodec` seam. JSON is the bundled default; MessagePack / protobuf / custom codecs swap in via the codec slot.
2. **Failure semantics for `broadcast`** — partial node failure: do we report which nodes received, or just resolve when ack-or-timeout passes? Probably the latter; transports that need stronger guarantees can add their own RPC.
3. **Cluster bus replay** — `LocalEventBus`'s `replay` option (#176) doesn't extend to remote subscribers naturally. Adapters that support replay (e.g., Redis Streams) expose it; others don't. Document per adapter.

## References

- ADR 11 — Cluster (high-level vision; this ADR is the concrete protocol).
- ADR 26 — Harness as the single shape.
- ADR 29 — Bus overhaul (introduced cluster-aware substrate seam concept).
- ADR 31 — Harness hierarchy (`Factory<R, P>`, "Cluster mode is a substrate swap").
- ADR 36 — define vs create convention.
