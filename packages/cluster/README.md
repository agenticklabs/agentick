# @agentick/cluster

Cluster protocol for Agentick — the typed seams a wire adapter implements, plus
the `defineCluster` factory that composes them into a substrate wrapper.

Cluster mode is a **substrate wrapper**. When you pass a `ClusterFactory` to
`createGateway` (or `createApp`), the local event bus and message inbox are
replaced with cluster-aware variants: node-local subscribers keep working
unchanged, and cross-node traffic rides the configured wire. Everything below
the wrap — sessions, harnesses, tools — is blind to whether the substrate is
local or clustered.

This package ships **no wire**. Adapters install separately:
[@agentick/cluster-net](../cluster-net) (TCP / Unix socket),
[@agentick/cluster-ws](../cluster-ws) (WebSocket),
[@agentick/cluster-redis](../cluster-redis) (Redis pub/sub). All three share
the broker plumbing in [@agentick/cluster-broker](../cluster-broker) except
Redis, which is brokerless.

## Install

```bash
npm install @agentick/cluster
# plus one wire adapter:
npm install @agentick/cluster-net
```

## Quick start

Pass a wire adapter's `defineXCluster(...)` factory as the `cluster` slot. The
gateway owns the lifecycle — closing it closes the cluster.

```typescript
import { createGateway } from "@agentick/gateway";
import { defineUnixCluster } from "@agentick/cluster-net";

const gateway = await createGateway({
  cluster: defineUnixCluster({
    socketPath: "/tmp/agentick.sock",
    // nodeId defaults to `${hostname}:${pid}`; a thunk defers env reads.
    nodeId: () => process.env.NODE_ID ?? `worker-${process.pid}`,
  }),
});

// Every app spawned via gateway.createApp(...) inherits the
// cluster-wrapped substrate.

await gateway.close(); // closes apps, then the cluster
```

Omit `cluster` and the gateway is pure local substrate with zero overhead.
There is no "cluster mode" flag to flip elsewhere.

## Testing without infrastructure

`@agentick/cluster/testing` ships `defineLocalCluster` — an in-memory fifth
wire with the same factory shape as the real ones. Two factories sharing one
registry simulate a two-node cluster with no sockets and no I/O.

```typescript
import { createLocalClusterRegistry, defineLocalCluster } from "@agentick/cluster/testing";

// Single node — the registry is created internally.
const solo = defineLocalCluster({ nodeId: "test" });

// Two nodes — pass an EXPLICIT shared registry so they see each other.
const registry = createLocalClusterRegistry();
const a = defineLocalCluster({ nodeId: "a", registry });
const b = defineLocalCluster({ nodeId: "b", registry });
```

Delivery is microtask-scheduled, so ordering is deterministic across runs.

## The five seams

An adapter implements between two and five interfaces. Only transport and
membership are required; the rest have bundled defaults.

| Seam                  | Required | Role                                                                        |
| --------------------- | -------- | --------------------------------------------------------------------------- |
| `ClusterTransport`    | yes      | Cross-node wire: point-to-point `send`, `broadcast`, subscriptions, `flush` |
| `ClusterMembership`   | yes      | Who is live; emits `joined` / `lost` / `snapshot` deltas                    |
| `ClusterPartitioning` | no       | address → owning node. Default: consistent hash on membership               |
| `ClusterCodec`        | no       | Wire serialization. Default: JSON                                           |
| `DurableJournal`      | no       | Durable append + replay (see gaps below)                                    |

Each `defineClusterX(impl)` helper wraps a plain Promise-flavored
implementation into the factory shape the framework consumes and registers its
`close()` on the parent's teardown chain. No Effect knowledge is needed to
write an adapter.

```typescript
import { defineCluster, defineClusterTransport, defineClusterMembership } from "@agentick/cluster";

const transport = defineClusterTransport({
  async send(toNode, env) {
    /* ... */
  },
  async broadcast(env) {
    /* ... */
  },
  subscribeInbox(filter, onMessage) {
    return async () => {};
  },
  subscribeBus(filter, onEvent) {
    return async () => {};
  },
  async flush() {},
  async close() {},
});

const membership = defineClusterMembership({
  currentNode: "node-a",
  async nodes() {
    return ["node-a"];
  },
  onChange(handler) {
    handler({ kind: "snapshot", nodes: ["node-a"], at: new Date().toISOString() });
    return async () => {};
  },
  async close() {},
});

const cluster = defineCluster({ nodeId: "node-a", transport, membership });
```

`ClusterTransport` carries ordering and delivery obligations the conformance
suite pins: per-(source, destination) FIFO for `send`, per-source FIFO for
`broadcast`, at-least-once delivery to a live recipient, and best-effort
fan-out to _current_ subscribers only. The cluster bus is not an event log —
late subscribers see nothing historical.

## Conformance

`runClusterTransportConformance` is the acceptance bar for a wire. Call it at
the top level of a spec file with a `setup` that returns two ready transport
factories sharing one wire.

```typescript
import { runClusterTransportConformance } from "@agentick/cluster/testing";

runClusterTransportConformance({
  async setup() {
    // ... stand up your wire ...
    return {
      factoryA,
      factoryB,
      nodeAId: "node-a",
      nodeBId: "node-b",
      async teardown() {
        /* ... */
      },
    };
  },
});
```

The factories must return transports that are **already handshake-complete**.
Returning a mid-handshake client produces flaky tests: subscribes and sends
issued before the wire is ready can be dropped with no back-pressure signal.

> [!IMPORTANT]
> `subscribeInbox` / `subscribeBus` return synchronously, but the subscription
> record at the broker is established asynchronously. If you subscribe on one
> node and immediately send from another, `await transport.flush()` in between
> — otherwise the send can race past the subscribe and the broker drops it with
> `cluster:broker:server:no-matching-subscription`.

## Side-channel clusters — `makeClusterNode`

Not every use of a cluster wants substrate fusion. For cross-process
coordination _outside_ the agent loop, every wire package exposes a
`joinXCluster(...)` returning a `ClusterNode` — a direct handle with a
name-based bus, `membership.waitForPeers(n)`, and `await using` support. All of
them compose against the same wire-agnostic builder here:

```typescript
import { makeClusterNode } from "@agentick/cluster";

// Inside a wire package, after its wire-specific setup:
const node = await makeClusterNode({
  nodeId,
  role: "broker", // or "client"
  transportFactory,
  membershipFactory,
  cleanup: async () => {
    /* wire-specific teardown */
  },
  localBrokerRunning: () => brokerIsUp,
});
```

The facade adds name-based `bus.subscribe(name, handler)` and
`bus.broadcast(name, payload)` with auto-stamped envelopes (ULID id,
timestamp, `phase: "terminal"`, surface derived from the segment before the
first `:`, and `scope.nodeId`). It is additive, not restrictive —
`node.transport` still exposes the raw seam for full `EventFilter` shapes.

## Node identity

`nodeId` is optional on every `defineXCluster` / `joinXCluster`. When omitted
it resolves to `${hostname}:${pid}`, which is unique across processes on a host
and across hosts with distinct hostnames.

```typescript
import { defaultNodeId, resolveNodeId } from "@agentick/cluster";

defaultNodeId(); // { nodeId: "web-3:4821", suspicious: false, reason: "..." }
resolveNodeId(() => process.env.NODE_ID ?? "worker-1"); // literal or sync thunk
```

Two replicas sharing a hostname _and_ colliding pids would silently merge in
the routing layer, so an empty or `"localhost"` hostname is flagged
`suspicious: true` and reported as `cluster:nodeId:suspicious`. Treat that
diagnostic as a configuration error in production. A clean auto-default reports
`cluster:nodeId:auto-defaulted`.

`NodeIdInput` is `NodeId | (() => NodeId)` — the thunk form defers resolution
to factory-invocation time, which is what you want when the value comes from an
env var set after module load.

## Partitioning

The default is consistent hashing over live membership. `shardKeyFor` extracts
the scope id after the first colon (`"tasks:session-abc"` → `"session-abc"`)
and `nodeFor` maps it onto a FNV-1a ring rebuilt from `membership.nodes()`.
Override to shard by tenant, user, or any key derivable from an address:

```typescript
import { defineClusterPartitioning } from "@agentick/cluster";

const byTenant = defineClusterPartitioning({
  shardKeyFor: (address) => address.split(":")[1]?.split("-")[0] ?? address,
  async nodeFor(shardKey) {
    return tenantToNode.get(shardKey) ?? "node-default";
  },
});
```

`nodeFor` may resolve the same key to different nodes as membership changes;
the routing layer re-resolves on every `send` rather than caching. If your
implementation caches membership, read it live — there is no rebalance callback
yet (see gaps).

## API reference

### Composition

| Export                            | Returns                      |
| --------------------------------- | ---------------------------- |
| `defineCluster(config)`           | `ClusterFactory`             |
| `defineClusterTransport(impl)`    | `ClusterTransportFactory`    |
| `defineClusterMembership(impl)`   | `ClusterMembershipFactory`   |
| `defineClusterPartitioning(impl)` | `ClusterPartitioningFactory` |
| `defineClusterCodec(impl)`        | `ClusterCodecFactory`        |
| `defineClusterJournal(impl)`      | `DurableJournalFactory`      |
| `makeClusterNode(opts)`           | `Promise<ClusterNode>`       |

`DefineClusterConfig`: `nodeId` (literal, sync thunk, or async thunk),
`transport`, `membership`, `partitioning?`, `journal?`, `codec?`,
`fanoutMode?`.

### Bundled adapters and helpers

| Export                                        | Role                                                            |
| --------------------------------------------- | --------------------------------------------------------------- |
| `jsonCodec()` / `createJsonCodec()`           | Default codec — `TextEncoder` + `JSON.stringify` both ways      |
| `consistentHashPartitioning(membership)`      | Default partitioning factory                                    |
| `defaultNodeId(opts?)`                        | `${hostname}:${pid}` + suspicious flag                          |
| `resolveNodeId(explicit, onDiagnostic?)`      | Explicit-wins nodeId resolution                                 |
| `matchesAddressFilter` / `matchesEventFilter` | Filter predicates, re-exported from [@agentick/utils](../utils) |

### The `Cluster` value

`defineCluster`'s factory returns this. The framework reads the substrate trio;
the query surface is for operators and devtools.

```typescript
interface Cluster {
  readonly bus: EventBus; // local bus + cross-node fan-out
  readonly inbox: MessageInbox; // local inbox + cross-node routing
  readonly journal: OperationJournal;
  readonly currentNode: NodeId;
  nodes(): Promise<readonly NodeId[]>;
  ownerOf(address: string): Promise<NodeId>;
  close(): Promise<void>;
}
```

There are intentionally no mutators. Cluster state changes inside the adapters
— transport reconnects, membership transitions, partitioning rebalances — not
through external method calls.

### Types

`NodeId`, `MembershipChange`, `AddressFilter`, `EventFilter`, `JournalOffset`,
`JournalEntry`, `Cluster`, `ClusterFactory`, `ClusterParent`, `ClusterNode`,
`BusFacade`, `MembershipFacade`, `MakeClusterNodeOptions`,
`DefaultNodeIdResult`, `NodeIdInput`, `DefineClusterConfig`, and the five
`*Factory` aliases.

### `/testing`

| Export                                   | Role                                           |
| ---------------------------------------- | ---------------------------------------------- |
| `defineLocalCluster(opts)`               | In-memory `ClusterFactory`                     |
| `createLocalClusterRegistry()`           | Shared routing state for multi-node simulation |
| `localClusterTransport(opts)`            | Fake `ClusterTransport` over the registry      |
| `localClusterMembership(opts)`           | Fake `ClusterMembership` over the registry     |
| `runClusterTransportConformance(config)` | The adapter acceptance suite (imports vitest)  |

## Observability

Cluster is not a harness; it emits diagnostics onto the **local** bus with
`surface: "cluster"`, so any existing subscriber — devtools, dashboards, OTLP
exporter — sees them through the standard subscription path. Emitting on the
wrapped bus would re-broadcast every diagnostic and feed back on itself.

| Event                                                                  | When                                          |
| ---------------------------------------------------------------------- | --------------------------------------------- |
| `cluster:wrap:installed` / `cluster:wrap:disposed`                     | Bus wrapper construction / teardown           |
| `cluster:membership:joined` / `:lost` / `:snapshot`                    | Every topology transition                     |
| `cluster:transport:send:failed` / `cluster:transport:broadcast:failed` | Transport rejected an outbound                |
| `cluster:routing:address-not-found`                                    | Inbound message for an unregistered address   |
| `cluster:event:malformed`                                              | Inbound event failed shape validation         |
| `cluster:ask:dispatched` / `:resolved` / `:timeout`                    | Remote-ask lifecycle                          |
| `cluster:ask:interrupted` / `:response-orphaned` / `:invalid-payload`  | Remote-ask failure modes                      |
| `cluster:nodeId:auto-defaulted` / `cluster:nodeId:suspicious`          | Reported to the factory's `onDiagnostic` sink |

Wire adapters add their own `cluster:broker:*` families — see
[@agentick/cluster-broker](../cluster-broker).

## Cross-node ask

`inbox.ask(address, message)` works across the wire. The request is routed to
the partition owner over a cluster-internal `@cluster/ask` framing with a
correlation-id-keyed pending registry, and the response comes back the same
way. Typed failures round-trip structurally: both `MessageHandlerError` (the
handler threw) and `InboxError` (routing failed, e.g. `AddressNotFound`)
arrive on the caller with their original tag, so `catchTag` narrowing works
unchanged across a node boundary.

Interrupting the caller cancels the pending entry and its timeout rather than
leaking it, and inbound payloads are shape-validated at the boundary —
malformed envelopes emit `cluster:ask:invalid-payload` and drop instead of
crashing the receiver.

> [!NOTE]
> The `@cluster/` prefix is reserved. Registering, sending, or asking on a
> `@cluster/`-prefixed address or message type fails with `RoutingFailed` and a
> pointer to the reason — otherwise adopter traffic could spoof ask responses.

## Fan-out modes

`fanoutMode` sets the default visibility for bus subscriptions.

- `"node-local-default"` (default) — subscribers see only events published on
  their own node. Remote events are dropped at the wrapper.
- `"cluster-wide-default"` — remote events are re-appended into the local bus,
  so every subscriber sees the whole cluster.

Most deployments want node-local; management dashboards are the case for
cluster-wide.

## Verified by

- `src/__tests__/define.spec.ts` — `defineCluster` composes seams, resolves
  literal / sync-thunk / async-thunk `nodeId`, defaults partitioning, wraps
  bus and inbox while passing the journal through, and registers both
  `transport.close()` and `membership.close()` on the parent.
- `src/__tests__/cluster-wrappers.spec.ts` — the wrapper contract end to end:
  both fan-out modes, local vs remote `send` routing, local and remote `ask`,
  `MessageHandlerError` and `InboxError` round-trip with original tags,
  caller-interrupt cleanup, wire-payload validation, inbound event shape
  validation, reserved-namespace rejection at `register` / `send` / `ask`, the
  full ask-lifecycle diagnostic set, and membership deltas reaching
  partitioning after construction.
- `src/__tests__/conformance-against-local.spec.ts` — the conformance suite
  passes against `LocalClusterTransport`.
- `src/__tests__/consistent-hash-partitioning.spec.ts` — shard-key extraction
  across address shapes; `nodeFor` is deterministic, balanced, rebalances on
  membership change, and throws on an empty cluster.
- `src/__tests__/json-codec.spec.ts` — `MessageEnvelope` and `EventEnvelope`
  round-trip; malformed input throws; each factory call is independent.
- `src/__tests__/default-node-id.spec.ts` — `${hostname}:${pid}` shape,
  suspicious-hostname detection for empty and `"localhost"`, survival of a
  throwing `hostname()`, explicit-wins resolution, and both diagnostics.
- `src/__tests__/define-local-cluster.spec.ts` — implicit vs shared registry,
  mutual visibility in membership, deregistration on close.
- `src/__tests__/composition-across-replicas.spec.ts` — a session child bus
  fans in to another replica while a sibling session stays isolated.

## Roadmap & known gaps

- **`codec` is observable-at-construction only in this package.** `defineCluster`
  builds the configured codec but does not route frames through it; the wire
  adapters consume `codec` directly at their own boundary. Configuring
  MessagePack here yields no serialization change on its own.
- **`subscribe` always returns the local bus stream.** Correct under
  `node-local-default`, and workable under `cluster-wide-default` because
  remote events are re-appended locally. A per-subscription cross-cluster
  opt-in — one bus serving both audiences without flipping the global default —
  is not built.
- **`publishLazy` over-builds under `cluster-wide-default`.** The wrapper can't
  probe remote subscriber indexes, so it always builds when fan-out crosses the
  wire. Hot publishers should stay on `node-local-default` to keep the
  short-circuit.
- **No partitioning rebalance signal.** Consistent-hash partitioning reads
  `membership.nodes()` on every `nodeFor()` call, so it is live — but a
  mid-flight ask can resolve a different owner than it started with, and a
  caching partitioning implementation has no callback to invalidate on.
- **`DurableJournal` is a seam with no consumer.** Rung-(d) durability needs
  continuation primitives (idempotency keys on tool dispatch, replay-safe
  side-effect markers) that don't exist yet. The interface ships so adapters
  can be built incrementally; the framework does not read the slot.
- **The in-memory fixture transport doesn't serialize**, so the codec is a
  no-op against it. Codec behavior on a real wire is only exercised by the
  wire adapters' own suites.
- **Effect-returning seam factories throw.** `defineCluster` accepts sync and
  Promise factories; an Effect-shaped return is rejected at construction. An
  `/effect` subpath for adapter authors who want Layer composition is not
  built.
- **Broker re-election is a wire concern, not a protocol one.** Broker-pattern
  wires elect one process; if it dies, clients lose the wire until a new broker
  exists. The default recovery is an external supervisor (systemd, PM2,
  Kubernetes) restarting it while clients retry with backoff.
  [@agentick/cluster-net](../cluster-net) additionally ships internal
  re-election for Unix sockets. Either way the protocol layer is unaffected —
  membership emits `lost` for the old broker and `joined` for the new one.
