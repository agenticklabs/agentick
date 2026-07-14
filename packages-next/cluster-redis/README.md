# @agentick/cluster-redis-next

**Redis cluster transport** for Agentick v2 — the production multi-host
story. Adopters reach for Redis (or Valkey / KeyDB / Dragonfly — same
RESP protocol, same client) for clustering instead of deploying our
own broker process.

**Status:** Phase 4g closed. Transport / membership / cluster factories
shipped (4g.1–4g.3), `joinRedisCluster` facade shipped (4f.7c), 5
integration tests pass against an in-memory fake-Redis hub. Conformance
against a real Redis (via docker-compose) is deferred to a Phase 6+
infra task.

**Design:** [ADR 35 — cluster protocol §10](../../docs/proposals/v2/blueprint/35-cluster-protocol.md) ·
[ADR 38 — cluster lifecycle + ownership](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md) ·
[`@agentick/cluster-next`](../cluster/README.md)

## Why Redis

For multi-host production, Redis is the right answer **because adopters
already have it**. Every shop running a Node.js production stack at
non-trivial scale either has Redis or can stand it up in 5 minutes:

- **HA is solved.** Sentinel = active-standby with auto-failover.
  Redis Cluster = sharded multi-master. We don't write any of this.
- **Ops know it.** Every observability vendor has Redis dashboards.
  Every cloud has a managed Redis offering (Elasticache, MemoryStore,
  Azure Cache). Every adopter's SRE has a runbook.
- **Failures are debuggable.** `redis-cli MONITOR` shows exactly what's
  on the wire. No proprietary protocol.
- **It scales.** Pub/sub handles tens of thousands of messages per
  second on a single node; clusters scale to millions.

Our own TCP / Unix / WS broker (in [`@agentick/cluster-net-next`](../cluster-net) /
[`@agentick/cluster-ws-next`](../cluster-ws)) is appropriate for:

- **Single-host multi-worker** scenarios (PM2 fork, Node cluster module).
  Unix socket auto-elect; zero infra.
- **Edge / Redis-allergic** scenarios where adding a dependency isn't
  acceptable.

For **multi-host production**, use this package.

## Compatible servers

The `ioredis` client speaks RESP, which means:

| Server                                | Status                      |
| ------------------------------------- | --------------------------- |
| **Redis** ≥ 6.0                       | Primary target              |
| **Valkey** (BSD-licensed Redis fork)  | Identical protocol; drop-in |
| **KeyDB**                             | RESP-compatible; drop-in    |
| **Dragonfly**                         | RESP-compatible; drop-in    |
| **AWS ElastiCache** (Redis or Valkey) | Drop-in                     |
| **GCP MemoryStore**                   | Drop-in                     |
| **Azure Cache for Redis**             | Drop-in                     |

Pick whichever your ops team prefers. The cluster wire doesn't care.

## Quick start

```typescript
import Redis from "ioredis";
import { defineRedisCluster } from "@agentick/cluster-redis-next";
import { createGateway } from "@agentick/gateway-next";

// Adopter owns the ioredis clients. We need two: one for pub/regular
// commands, one for subscribe-mode (Redis pub/sub requires this).
const url = "redis://redis.svc.cluster.local:6379";
const pubClient = new Redis(url);
const subClient = new Redis(url);

const gateway = await createGateway({
  cluster: defineRedisCluster({
    pubClient,
    subClient,
    // nodeId defaults to `${hostname}:${pid}`; thunk form supported
    keyPrefix: "agentick:prod:", // optional — share one Redis across envs
  }),
});

// ... use the gateway ...

await gateway.close();
// Adopter still calls pubClient.quit() / subClient.quit() —
// the cluster doesn't own them.
```

### Side-channel — `joinRedisCluster`

```typescript
import { joinRedisCluster } from "@agentick/cluster-redis-next";

await using node = await joinRedisCluster({ pubClient, subClient });
node.bus.subscribe("hello", (env) => console.log(env.scope.nodeId));
await node.membership.waitForPeers(2);
await node.bus.broadcast("hello");
```

See [ADR 38 — Cluster lifecycle + ownership](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md)
for the substrate-fusion vs side-channel split.

## API

| Export                     | Role                                                       |
| -------------------------- | ---------------------------------------------------------- |
| `defineRedisCluster(opts)` | Returns a `ClusterFactory` for createApp/createGateway     |
| `joinRedisCluster(opts)`   | Returns a `ClusterNode` for side-channel use (Phase 4f.7c) |
| `redisClusterNode(opts)`   | `{transport, membership}` over shared ioredis sockets      |
| `redisTransport(opts)`     | Standalone transport factory                               |
| `redisMembership(opts)`    | Standalone membership factory                              |

## How it differs from broker-based wires

- **No broker to deploy.** Redis IS the broker. Every node connects
  directly to Redis. There's no `wsBroker(...)` equivalent — every
  call site is symmetric.
- **Two ioredis sockets per node.** Standard Redis pub/sub pattern:
  one connection for SUBSCRIBE (subscriber mode), one for PUBLISH +
  regular commands. Cheap; ~2KB per connection.
- **Subscription filters are client-side.** We PSUBSCRIBE to broad
  channels (`agentick:bus`, `agentick:inbox:<node>`) and filter via
  the same `matchesEventFilter` / `matchesAddressFilter` utils as
  cluster-broker. Server-side topic-based subscriptions weren't worth
  the complexity gain.
- **Membership = soft state in a Redis SET + TTL keys.** Heartbeats
  refresh TTL; dead nodes age out automatically. Failure detection
  latency tunable via heartbeat / TTL ratio.

## Adopter platform notes

- **Requires `ioredis` as a peer dep.** Adopters install it
  themselves: `pnpm add ioredis`. We don't bundle it.
- **TLS / `rediss://`** — `ioredis` supports it natively. Pass a
  `rediss://` URL and the wire is encrypted.
- **Sentinel** — pass `{ sentinels, name }` instead of `url`;
  `ioredis` handles failover.
- **Redis Cluster mode** — pass `{ cluster: true, nodes: [...] }`;
  the adapter uses `Redis.Cluster` under the hood. Note: pub/sub in
  Redis Cluster requires `CLUSTER_NODES_PUBSUB_SHARDED` for predictable
  routing — sharded pub/sub since Redis 7.0.

## Verified by

_Phase 4f.5 — pending. Will run `runClusterTransportConformance`
against an ephemeral Redis (docker-compose in CI, `REDIS_URL` env
for local dev). Same 10/10 bar as TCP/Unix/WS. Plus Redis-specific
verification (reconnect, graceful close cleanup, TTL expiry,
keyPrefix isolation)._

## Roadmap & known gaps

- **Phase 4f.2** — `ClusterTransport` (publish + subscribe + filter matching)
- **Phase 4f.3** — `ClusterMembership` (SET + TTL heartbeats + onChange polling)
- **Phase 4f.4** — `defineRedisCluster` / `redisClusterNode` factories
- **Phase 4f.5** — Conformance + verification tests
- **Phase 4f.6** — Otto demo (3-replica gateway + Redis end-to-end)
- **Phase 7+** — `DurableJournal` adapter via Redis Streams (separate package?
  probably `@agentick/journal-redis-next`)
