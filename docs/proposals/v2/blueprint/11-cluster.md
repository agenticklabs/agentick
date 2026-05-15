# 11 — Cluster (Optional Topology Wrapper)

**Status:** Synthesized
`[SOURCE: cluster.md, runtime.md, harness-principle.md]`

`@agentick/cluster` is the **optional** distributed deployment wrapper.
The core runtime is library-first and in-process by default; cluster
mode adds routing, activation, and cross-node fan-out **on top of the
same harness contracts**. It does NOT redefine session/app semantics.

```
                            ┌──────────────────────────────┐
                            │          Cluster             │
                            │                              │
   commands ──► (wrapped) ──┤  (routes session commands    │ ──► events (mirrored)
                            │   to the node hosting the    │
                            │   session entity)            │
   interceptors◄┤           │                              │ ──► outcomes
                            │  cluster bus · sharding ·    │
                            │  activation · migration       │
                            └──────────────────────────────┘
                                            │
                            ┌───────────────┴────────────────┐
                            ▼               ▼                ▼
                       Runtime         Runtime          Runtime
                       Node 1          Node 2           Node 3
                       (local app +    (local app +     (local app +
                        sessions)       sessions)        sessions)
```

`[V1-REPLACED]` — v1 had no cluster story. This is new in v2 but designed
to wrap rather than replace.

## Why an optional wrapper

The earlier v2 draft made distributed-by-default the baseline. Per
`[SOURCE: runtime.md §What Changed from Earlier Drafts]` that was reversed:
distribution is real but the runtime should be reasonable about without
it. The wrapper model achieves both:

- **Single-process apps** pay no cluster tax.
- **Multi-node apps** opt in via a Layer; user code unchanged.
- **Tests** run the runtime in-process with a `LocalCluster` impl that
  exercises cluster wiring without standing up infrastructure.

## What the wrapper adds

```
Distributed routing
  app.session(id) on any node → routes to whichever node hosts the entity

Remote lifecycle activation/deactivation
  Hibernated entities activate on demand on the appropriate node

Cross-node event fan-out
  Per-session PubSubs mirror to the cluster bus when remote subscribers exist

Cross-node inbox routing
  Messages sent to harness addresses route across nodes via the
  cluster framework. Same MessageHandler signatures local and remote.

Optional migration / failover
  Node leaves cluster → entities migrate to remaining nodes
```

The cluster wrapper is **the substrate that turns the inbox cross-process**.
In Tier 0/1, `MessageInbox.local()` Layer dispatches messages in-process.
In Tier 2, `MessageInbox.cluster(...)` Layer dispatches via
`@effect/cluster`'s typed messaging. Same protocol; same handlers; same
addresses.

What the wrapper does NOT add:

- New harness commands (the same commands route through cluster routing).
- New event names beyond `surface: "cluster"` (the wrapped session events
  keep their original names; cluster adds `scope.nodeId`).
- New compile-time concepts (the spec stays topology-agnostic).
- New authentication models (single-trust-domain assumption).

## Single-trust-domain stance

`[SOURCE: cluster.md §Design Principles]` and earlier drafts of
`runtime.md`:

> Cross-organization federation is explicitly out of scope for v2. The
> spec is evolvable so federation isn't precluded later, but no v2 design
> choices presume it.

This bounds:

- Authentication (one auth model, internal credentials between nodes).
- Versioning (operator-controlled; nodes coordinated).
- Network conditions (same VPC or controlled WAN).
- Persistence backend (shared, single-vendor).
- Trust (nodes trust each other by virtue of cluster membership).

## Effect Cluster as substrate `[PROPOSAL]`

The implementation substrate is `@effect/cluster` (Effect's actor
framework). Mapping:

| Agentick concept | Effect Cluster primitive |
| --- | --- |
| Session | Sharded entity (`RecipientType`) |
| Session ID | Entity ID |
| `session.send(msg)` | Typed message to entity |
| App Supervisor | Singleton entity (one per app per cluster) |
| Hibernation | Entity deactivation |
| Wake on event | Entity activation on message arrival |
| Snapshot / restore | Entity state persistence |
| Cross-session events | Cluster PubSub |
| Session migration | Entity migration (cluster handles) |
| Spawn child session | Spawn child entity (registered) |
| Multi-tenant | Multiple `RecipientType`s |

`[GAP]` `[SOURCE: cluster.md §Open Question 1]` — the substrate choice is
"open", but blueprint position is `@effect/cluster`. Sign-off needed.

## What cluster mode looks like to user code

```ts
// Library mode (default)
const app = createApp(<MyAgent />, {
  persistence: postgresPersistence({ ... }),
});
const session = await app.session("user-123");
await session.send({ messages });

// Cluster mode (opt-in)
const app = createApp(<MyAgent />, {
  persistence: postgresPersistence({ ... }),
  cluster: redisCluster({ ... }),
  streams: redisStreams({ ... }),
});
const session = await app.session("user-123");
await session.send({ messages });   // routes across cluster transparently
```

The session reference returned in cluster mode is a typed handle. Reading
`session.timeline()` becomes a typed cluster request (possibly crossing
nodes); it feels synchronous because Effect resolves it transparently,
but it's not free.

## Cluster topology

```
                     ┌──────────────┐
                     │   Gateway    │  ← clients connect here
                     │  (optional)  │
                     └──────┬───────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
         ┌────────┐    ┌────────┐    ┌────────┐
         │Runtime │    │Runtime │    │Runtime │
         │Node 1  │    │Node 2  │    │Node 3  │
         │        │    │        │    │        │
         │Sessions│    │Sessions│    │Sessions│
         │A,D,F   │    │B,E,G   │    │C,H     │
         └───┬────┘    └───┬────┘    └───┬────┘
             │             │             │
             └─────────────┼─────────────┘
                           │
                ┌──────────┴──────────┐
                ▼                     ▼
          ┌──────────┐          ┌──────────┐
          │Persistence│          │ Cluster │
          │ (Postgres)│          │ Bus     │
          └──────────┘          └──────────┘
```

Cluster components:

- **N runtime nodes** — peers; each hosts a shard of session entities.
- **Cluster bus** — durable streams backbone for cross-node events
  (Redis Streams, NATS JetStream).
- **Persistence** — shared (Postgres, Redis, etc.). Session record,
  timeline, blob storage.
- **Optional gateway fleet** — `12-gateway.md`.

## Routing and migration

```
session.send(msg) from any node
   │
   ▼
Cluster routing layer
   │
   ├── lookup which node currently hosts session id
   │   (consistent hash by default; sticky placement)
   │
   ├── if hosted: forward to that node's session entity
   ├── if hibernated nowhere: pick a node by sharding rule, activate
   │
   ▼
Session entity processes message
   │
   ▼
Response routed back across nodes
```

Migration:

- Graceful node departure → entities migrate to remaining nodes.
- State preserved via persistence (small session record + queryable
  timeline; no monolithic snapshot dump).
- In-flight messages re-routed.
- Migration overhead `[GAP]` — open question.

## Backbone resolution

`[SOURCE: runtime.md (earlier draft) §Backbone resolution]` —
"PubSub is the substrate" resolves to **two distinct backbones** with
different semantics:

| Operation | Pattern | Backbone (production default) |
| --- | --- | --- |
| Entity messaging (cluster routing) | Point-to-point RPC | Effect Cluster's native routing — handled by the cluster framework |
| Observable state (events, channels) | Durable streams, sequenced, replayable | **Redis Streams** or **NATS JetStream** — append-only log, consumer groups, replay from any offset |

**Streams everywhere for observable state.** Events, channels, and the
cross-session bus all share one primitive: a named, durable, sequenced
stream. This is event-sourcing-shaped at the messaging layer (state isn't
strictly derived from the log, but the log is durable, replayable,
auditable).

Redis Pub/Sub (fire-and-forget) is **not** used — every observable stream
needs replay/resume.

### Default backends

| Tier | Persistence | Cluster bus | Streams |
| --- | --- | --- | --- |
| Single-node / dev | Memory or SQLite | n/a (in-process) | In-memory PubSub |
| Production small/medium | Postgres or Redis | Redis cluster routing | Redis Streams |
| High-throughput | Postgres | NATS-backed routing | NATS JetStream |

All backends are pluggable Layers.

## App Supervisor as singleton entity

Every clustered app has one **supervisor** singleton entity that owns the
long-lived concerns no individual session should hold:

- External event subscriptions (webhooks, message queues, polling).
- Schedulers (cron fires that wake sessions).
- Cross-session pub/sub fan-out coordination.
- Session lifecycle policy (when to hibernate, when to migrate).
- Cluster-wide registries (active session list, tenant routing).

```
                        ┌─────────────────────┐
                        │   App Supervisor    │
                        │   (singleton entity)│
                        │                     │
                        │ ─ external subs     │
                        │ ─ schedulers        │
                        │ ─ session registry  │
                        │ ─ cross-session bus │
                        └──────────┬──────────┘
                                   │
                   routes events   │  spawns / wakes
                                   │
                ┌──────────────────┼──────────────────┐
                ▼                  ▼                  ▼
            Session A          Session B          Session C
            (active)         (hibernated)         (active)
```

The supervisor is the bridge between the outside world and individual
sessions. When a JSX tree mounts a `<Subscription>`, the session
registers an intent. The supervisor materializes the actual external
connection and routes events to the right session — waking hibernated
sessions as needed.

This is what makes aggressive hibernation viable. Sessions can release
all their resources because the supervisor owns the things that need to
stay alive.

`[V1-REPLACED]` — v1 had no supervisor. v2 supervisor is a cluster-mode
construct (in single-node deployments it degenerates to an in-process
service).

## Two-stage subscription registration

```
Stage 1 (render time):
  <Subscription source={...} handlerId="orders.handle" /> mounts
    ──► JSX render produces a SubscriptionIntent
    ──► intent recorded in session entity state (persists with snapshot)
    ──► supervisor receives "session ABC subscribes to source X"
    ──► supervisor materializes the external connection
    ──► supervisor records routing entry (X → session ABC)

Stage 2 (event arrival):
  event from source X
    ──► supervisor receives event
    ──► if session ABC is active: deliver to in-session handler
    ──► if session ABC is hibernated:
          activate entity, then deliver
    ──► if session ABC is gone:
          tear down routing entry per miss policy
```

`[V1-REPLACED]` — v1 didn't have this pattern; it relied on closures
captured in render. v2 makes handlers ID-addressable so they survive
hibernation.

## Session activation states (cluster-aware)

```
Active    — entity activated on a node, fiber running, scope open.
            Memory cost: timeline window + fiber tree + held resources.

Hibernated — entity deactivated, scope closed, in-memory resources released.
            Snapshot persisted. Subsequent message arrival activates.

Cold      — never resident in this cluster instance. State lives in
            persistence. Every interaction is a full activation.
```

`[V1-REPLACED]` — v1 had only `idle | running | closed`.

Most apps run with active-on-use, hibernate-after-idle. Hibernation is
invisible to the API: `session.send()` either runs against an active
session or transparently triggers reactivation.

## Wrapping model

```
Local App harness    ──► wrapped by cluster routing/activation layer
Local Session harness──► wrapped by cluster routing/activation layer
Local Loop, React,
Executor, Tool       ──► not wrapped (run inside the entity)
                        events fan-up through the wrapped session
```

Callers still use the same harness commands conceptually. Transport and
routing are wrapper concerns. Per-session interceptors keep working
exactly as in library mode (they run on the node hosting the session).

## App-level interceptors in cluster mode

App-level interceptors register with the supervisor singleton. Each node
sees them when it processes session-level events; the supervisor
replicates the registration so a session activated on a different node
gets the same interceptors.

`[GAP]` — exact replication mechanism. Sign-off needed.

## Events in cluster mode

Two changes to the envelope:

```
EventScope.nodeId           — populated with the node where the inner
                              command actually ran

events from cluster wrapper itself — surface: "cluster"
```

The cluster wrapper does NOT mutate event meaning from underlying
harnesses. It only adds `scope.nodeId` and emits its own routing /
activation / migration events.

```
cluster:routing:requested        cluster:routing:terminal
cluster:activation:terminal      (entity activated on this node)
cluster:deactivation:terminal    (entity deactivated)
cluster:migration:requested      cluster:migration:terminal
cluster:node:joined              cluster:node:left
```

## Cross-node event aggregation

```
Per-session PubSub<ProtocolEvent>      ← session subscribers (local node)
        │
        ▼ (mirrored on every publish, with sessionId tag)
App-wide PubSub<ProtocolEvent>          ← cross-session subscribers (local node)
        │
        ▼ (cluster-distributed via cluster's stream backbone)
Cluster bus                              ← cluster-wide subscribers (any node)
```

Conditional fan-up: per-session events mirror to the app bus only if app
subscribers exist; the app bus fans to the cluster only if cross-node
subscribers exist. Cost when no subscribers: zero.

## Failure and recovery

The cluster wrapper defines explicit policies:

- **Node unavailability**: routing layer retries with backoff; if the
  hosting node is unreachable, migration is initiated.
- **Command retry semantics**: idempotent commands (reads) auto-retry;
  non-idempotent commands (`send`, `dispatch`) require explicit
  retry policy from the caller (or a `dispatch` interceptor).
- **In-flight execution interruptions**: a node leaving mid-execution
  causes the execution to terminate with `LoopCanceledError` on the
  caller; state is preserved up to the last `loop:tick:terminal:succeeded`.
- **Activation race handling**: entity activation is single-active; the
  cluster framework guarantees no two nodes host the same entity at
  once.
- **Idempotency of lifecycle transitions**: `hibernate`, `restore`,
  `close` are idempotent (re-issuing returns the same outcome).

These behaviors are wrapper policy, not runtime core changes.

## Multi-tenant isolation

In cluster mode, tenants are typically distinguished via:

- `metadata.tenantId` on session creation.
- Sharding rules that co-locate a tenant's sessions (or distribute them).
- Per-tenant rate limiters backed by a shared store
  (`14-state-tiers.md`).
- Tenant-scoped subscribers (`app.events({ scope: { tenantId } })`).

`[GAP]` `[SOURCE: runtime.md (earlier) §Open Question 11]` — exact
mechanism for shared rate-limiter coordination. Lean: backend-managed
(Redis-based limiter token store).

## Testing

```
LocalCluster — runs Effect Cluster machinery in a single process.
  Useful for integration tests of routing, activation, hibernation
  without standing up real cluster infrastructure.

Layer.succeed(ClusterService, localCluster()) in test layers.
```

`[V1-REPLACED]` — v1 had no cluster to test. v2 cluster tests use
`LocalCluster` to exercise wiring.

## Composition with gateway

Gateway and cluster are independent wrappers. Common combinations:

| Deployment | Gateway | Cluster |
| --- | --- | --- |
| Embedded library | none | none |
| Single-server app | optional (HTTP/WS) | none |
| Production small | optional fleet | Redis cluster |
| Production large | dedicated fleet | NATS-backed |

Gateways are not cluster members; they are stateless front doors that
route into the cluster. See `12-gateway.md`.

## Decisions captured

- Cluster is an optional wrapper, not core identity.
- Harness contracts preserved across local and distributed modes.
- Compiled spec and authoring stay topology-agnostic.
- Effect Cluster as substrate (`[PROPOSAL]`).
- App Supervisor as singleton entity owns external connections and
  cross-session bus.
- Two-stage subscription registration (intent + materialization).
- Streams (durable) for observable state; cluster routing for entity
  messaging — two backbones, not one.
- Single-trust-domain stance.

## Open questions

- Routing substrate default (lean: Redis cluster routing for small/medium,
  NATS for high-throughput).
- Activation policy ownership (runtime interceptor vs cluster wrapper).
- Cross-node ordering guarantees (per-session strict; cross-session best
  effort).
- Migration overhead bounds.
- Supervisor failover semantics.
- App-level interceptor replication mechanism.
- Multi-tenant rate-limiter coordination (lean: backend-managed).
- Operational profile defaults for small vs large.
