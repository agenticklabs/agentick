# @agentick/cluster-redis

Redis cluster wire for Agentick — the multi-host option.

Unlike the broker-pattern wires, this one is brokerless and fully symmetric.
Redis _is_ the broker: there's no bind race, no role election, no broker process
to keep alive, and no deploy unit to add. Every node runs identical code.

That matters mostly because it moves the hard part onto software that already
solved it. Redis Sentinel gives you active-standby with automatic failover;
Redis Cluster gives you sharded multi-master. Every cloud has a managed
offering, every observability vendor ships a Redis dashboard, and
`redis-cli MONITOR` shows you exactly what's on the wire when something is
wrong. None of that is true of a broker we wrote.

Use [@agentick/cluster-net](../cluster-net) instead when you're on a single host
with several workers (Unix socket, zero infrastructure), or when adding a Redis
dependency isn't acceptable.

## Install

```bash
npm install @agentick/cluster-redis @agentick/cluster ioredis
```

`ioredis` is a peer dependency — you construct and own the clients.

## Compatible servers

`ioredis` speaks RESP, so any RESP-compatible server works: **Redis** ≥ 6.0,
**Valkey**, **KeyDB**, **Dragonfly**, and the managed offerings (**AWS
ElastiCache**, **GCP MemoryStore**, **Azure Cache for Redis**). Nothing in this
package is Redis-specific beyond the command set — `PUBLISH`, `SUBSCRIBE`,
`SADD` / `SREM` / `SMEMBERS`, `SET … EX`, `EXPIRE`, `DEL`, `EXISTS`.

In fact the clients are typed structurally against `RedisLikeClient`, not
against `ioredis`, so any object with those methods works — which is how the
tests run against an in-memory fake.

## Quick start

Redis pub/sub requires a dedicated connection for subscriber mode, so pass two
clients: one for `PUBLISH` and regular commands, one held in `SUBSCRIBE` mode.

```typescript
import { Redis } from "ioredis";
import { createGateway } from "@agentick/gateway";
import { defineRedisCluster } from "@agentick/cluster-redis";

const url = "redis://redis.internal:6379";
const pubClient = new Redis(url);
const subClient = new Redis(url);

const gateway = await createGateway({
  cluster: defineRedisCluster({
    pubClient,
    subClient,
    // nodeId defaults to `${hostname}:${pid}`; a thunk defers env reads.
    keyPrefix: "agentick:prod:", // isolate envs sharing one Redis
  }),
});

await gateway.close(); // also quits both clients — see below
```

Every replica runs exactly that. There is no broker branch.

> [!WARNING]
> Under TypeScript, that snippet does not currently typecheck: an `ioredis`
> `Redis` instance is not structurally assignable to the client shape these
> options declare, because `subscribe` and `unsubscribe` are typed here as
> returning `Promise<number>` while `ioredis` types them as overload sets
> returning `Promise<unknown>`. It is correct at runtime — those return values
> are never read. Until the shape is widened, cast at the boundary:
>
> ```typescript
> type RedisClient = Parameters<typeof defineRedisCluster>[0]["pubClient"];
> const pubClient = new Redis(url) as unknown as RedisClient;
> ```
>
> Both this and the missing export of the client-shape type are tracked in the
> gaps below.

## Client ownership

> [!WARNING]
> Closing the cluster **quits both clients**. The transport's `close()` calls
> `pubClient.quit()` and `subClient.quit()`, and that close is registered on the
> gateway's teardown chain. If you share `pubClient` with your application's
> cache or rate limiter, `gateway.close()` will take that down too — give the
> cluster its own pair.

Two connections per node is the cost, and it's small: a few kilobytes of client
state each.

## Side-channel clusters

For cross-process coordination alongside the agent loop rather than inside it,
`joinRedisCluster` returns a `ClusterNode` with a name-based bus,
`waitForPeers`, and `await using` lifecycle. Every node reports
`role: "client"` and `localBrokerRunning()` is always `false` — there is no
broker to be.

```typescript
import { Redis } from "ioredis";
import { joinRedisCluster } from "@agentick/cluster-redis";

type RedisClient = Parameters<typeof joinRedisCluster>[0]["pubClient"];
const pubClient = new Redis(url) as unknown as RedisClient;
const subClient = new Redis(url) as unknown as RedisClient;

await using node = await joinRedisCluster({ pubClient, subClient });

node.bus.subscribe("hello", (env) => console.log(env.scope.nodeId));
await node.membership.waitForPeers(2);
await node.bus.broadcast("hello", { greeting: "hi" });
// Scope exit closes the node — which quits both clients.
```

Its single `onDiagnostic` receives every transport and membership event, always
tagged `layer: "client"`.

## How it works

**Channels.** One shared broadcast channel `{prefix}bus` that every node
subscribes to, plus a per-node inbox channel `{prefix}inbox:<nodeId>` for
point-to-point delivery. Routing is by channel name on receipt.

**Subscription filters are client-side.** Nodes subscribe to those broad
channels and apply `matchesEventFilter` / `matchesAddressFilter` locally — the
same predicates the broker-pattern wires use. Server-side topic subscriptions
would mean a Redis channel per filter, which buys little and costs a lot of
subscription churn.

**Membership is soft state.** Each node adds itself to a `{prefix}members` set
and writes a `{prefix}member:<nodeId>:alive` key with a TTL, refreshed on a
heartbeat. Live membership is the set members whose alive key still exists, so
a node that dies without a graceful leave simply ages out. Changes are detected
by polling.

The three tunables trade failure-detection latency against Redis load:

| Option                | Default  | Effect                                                                 |
| --------------------- | -------- | ---------------------------------------------------------------------- |
| `heartbeatTtlSec`     | `30`     | How long after its last heartbeat a dead node lingers                  |
| `heartbeatIntervalMs` | `10_000` | Renewal cadence. Must stay well under the TTL or nodes drop spuriously |
| `pollIntervalMs`      | `5_000`  | Membership-change detection interval                                   |

`keyPrefix` defaults to `"agentick:"` and covers both keys and channels, so
several clusters can share one Redis instance without colliding.

## API reference

| Export                                           | Role                                                      |
| ------------------------------------------------ | --------------------------------------------------------- |
| `defineRedisCluster(opts)`                       | `ClusterFactory` for `createGateway` / `createApp`        |
| `joinRedisCluster(opts)`                         | `Promise<ClusterNode>` for side-channel use               |
| `redisClusterNode(opts)`                         | `{ transport, membership }` over the two shared clients   |
| `redisTransport(opts)` / `redisMembership(opts)` | Standalone single-seam factories                          |
| `createRedisTransport(opts)`                     | The raw `ClusterTransport` (requires an explicit `codec`) |
| `createRedisMembership(opts)`                    | The raw `ClusterMembership` (takes one `client`)          |

`BusFacade`, `ClusterNode`, and `MembershipFacade` are re-exported from
[@agentick/cluster](../cluster) so typing a returned node needs one import.

```typescript
interface RedisClusterNodeOptions {
  nodeId: NodeId; // required here; the define/join facades default it
  pubClient: RedisLikeClient; // structural: the ~13 commands this package calls
  subClient: RedisLikeClient; // held in SUBSCRIBE mode
  codec?: ClusterCodec; // default: bundled JSON
  keyPrefix?: string; // default "agentick:"
  heartbeatTtlSec?: number; // default 30
  heartbeatIntervalMs?: number; // default 10_000
  pollIntervalMs?: number; // default 5_000
  onDiagnostic?: (name: string, payload?: unknown) => void;
}
```

`DefineRedisClusterOptions` is that shape with `nodeId` optional, plus
`partitioning`, `journal`, and `fanoutMode`.

## Deployment notes

- **TLS** — pass a `rediss://` URL to `ioredis`. Encryption is entirely the
  client's concern; this package never sees the connection settings.
- **Sentinel and Redis Cluster** — configure them on the `ioredis` constructor
  (`new Redis({ sentinels, name })`, or `new Redis.Cluster(nodes)`) and hand the
  resulting clients over. This package accepts any `RedisLikeClient` and does
  not construct or inspect clients, so failover topology is transparent to it.
- **Sharded pub/sub** — in Redis Cluster mode, plain pub/sub is broadcast across
  all shards. Redis 7.0's sharded pub/sub (`SSUBSCRIBE`) is the predictable
  alternative, but this package issues `SUBSCRIBE`, not `SSUBSCRIBE`, so it uses
  the broadcast form.

## Diagnostics

Emitted with `surface: "cluster"` when bridged onto the bus, or straight to your
`onDiagnostic` callback.

| Event                                                     | Meaning                                |
| --------------------------------------------------------- | -------------------------------------- |
| `cluster:redis:publish-failed`                            | `PUBLISH` rejected                     |
| `cluster:redis:subscribe-failed`                          | `SUBSCRIBE` rejected                   |
| `cluster:redis:decode-failed`                             | Inbound payload didn't decode          |
| `cluster:redis:inbox-handler-threw` / `bus-handler-threw` | A subscriber callback threw; contained |
| `cluster:redis:pub-error` / `sub-error`                   | Client-level `error` event             |
| `cluster:redis:membership:join-failed`                    | Couldn't register in the member set    |
| `cluster:redis:membership:heartbeat-failed`               | TTL renewal failed                     |
| `cluster:redis:membership:poll-failed`                    | Membership poll failed                 |
| `cluster:redis:membership:leave-failed`                   | Graceful leave failed                  |
| `cluster:redis:membership:handler-threw`                  | A membership-change handler threw      |

## Verified by

- `src/__tests__/integration.spec.ts` — against an in-memory RESP-shaped fake:
  `send` from node A lands on B's inbox subscription; `broadcast` from A fans
  out to B's bus subscription without echoing to A; `subscribeInbox` filters
  narrow delivery; two nodes joining appear in each other's snapshot; a graceful
  close removes a node from the cluster's view.
- `src/__tests__/join-redis-cluster.spec.ts` — every node reports
  `role: "client"`; `bus.subscribe` / `bus.broadcast` round-trip through
  pub/sub; `waitForPeers` resolves when peers join; the diagnostic sink tags
  every event `layer: "client"`; `close()` is idempotent and
  `Symbol.asyncDispose` mirrors it.

## Roadmap & known gaps

- **A real `ioredis` client isn't assignable to the declared client shape.**
  `subscribe` / `unsubscribe` are declared as `Promise<number>` but `ioredis`
  types them as overload sets returning `Promise<unknown>`. The returns are
  never read, so widening them fixes the headline use case; until then adopters
  cast.
- **`RedisLikeClient` is not exported from the package barrel** even though it
  is the declared type of the required `pubClient` / `subClient` on every public
  factory. Reaching it means going through
  `Parameters<typeof defineRedisCluster>[0]["pubClient"]`.
- **The transport quits adopter-supplied clients on close**, which contradicts
  the ownership model the option names imply — you construct the clients, so you
  would expect to close them. Until that's settled, don't share a client between
  the cluster and anything else in your process.
- **No conformance run against a real Redis.** The tests use an in-memory fake
  that implements `RedisLikeClient`, so command shapes are exercised but real
  server semantics — reconnect behavior, TTL precision under load, `keyPrefix`
  isolation on a live instance, Cluster-mode routing — are not. The
  `runClusterTransportConformance` suite from [@agentick/cluster](../cluster)
  has not been run against this wire.
- **Membership polls rather than subscribes.** Detection latency is bounded by
  `pollIntervalMs`, and a shorter interval costs Redis round trips on every
  node. Keyspace notifications would make it event-driven; they aren't used.
- **Sharded pub/sub is not supported.** See the deployment notes above; on Redis
  Cluster, bus traffic is broadcast to all shards.
- **No durable journal.** Redis Streams would be a natural backing for the
  `DurableJournal` seam, but that seam has no framework consumer yet, so nothing
  here implements it.
