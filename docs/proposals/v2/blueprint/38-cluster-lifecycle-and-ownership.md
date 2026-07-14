# 38 — Cluster lifecycle + ownership rules

**Status:** DECIDED (Phase 5 implementation landed)

The cluster protocol (ADR 35) defines the _seams_. This ADR pins
_who calls them, when, and who owns the cleanup_. It is the manual
adopters need to wire cluster into their app correctly without
double-wrapping, lifecycle leaks, or routing corruption.

## Two wiring patterns

There are exactly TWO ways an adopter consumes cluster code.
They have **different lifecycle ownership**. Pick one per process.

### Pattern A — substrate-fusion (the normal app)

The cluster wraps the framework's local substrate
(`bus`/`inbox`/`journal`). All app code that publishes events,
sends inbox messages, or appends to the journal goes through the
cluster transparently — adopters don't see cluster code in their
app body.

```ts
// One app per process:
const app = await createApp(<Agent />, {
  executor: ...,
  cluster: defineUnixCluster({ socketPath: "/tmp/cluster.sock" }),
});
await app.send(...);
await app.closeApp(); // closes the cluster too

// Multi-app per process — gateway owns the cluster:
const gateway = await createGateway({
  cluster: defineUnixCluster({ socketPath: "/tmp/cluster.sock" }),
});
await gateway.listen(); // REQUIRED before createApp (ADR 84 §1)
const app1 = await gateway.createApp({ rootElement: ..., options: ... });
const app2 = await gateway.createApp({ rootElement: ..., options: ... });
await gateway.close(); // closes apps, then cluster
```

**Lifecycle ownership: the framework owns the cluster.**

`createApp({cluster})` and `createGateway({cluster})` invoke the
factory at construction against a synthesized `ClusterParent`. The
factory registers cleanup via `parent.onClose(...)`. When
`app.closeApp()` / `gateway.close()` fires, the framework
runs the cluster's onClose chain. Adopter writes ZERO lifecycle
code.

### Pattern B — side-channel cluster (advanced)

The adopter wants raw `bus.broadcast` / `bus.subscribe` /
`membership.waitForPeers` directly, without the framework
substrate wrapping. Use cases: coordination between worker
processes that aren't agent loops; framework-internal tooling;
proof-points like `example/v2-otto-cluster`.

```ts
await using node = await joinUnixCluster({
  socketPath: "/tmp/cluster.sock",
  nodeId: "node-A",
});
node.bus.subscribe("hello", (env) => console.log(env.scope.nodeId));
await node.membership.waitForPeers(2);
await node.bus.broadcast("hello");
// node disposes automatically at scope exit.
```

**Lifecycle ownership: the caller owns the cluster.**

`joinXCluster(...)` returns a `ClusterNode` with explicit `close()`
and `Symbol.asyncDispose`. The framework knows nothing about it.
Use `await using` or explicit `await node.close()`.

## Hard rules

### Rule 1 — One cluster per process

Multiple `createApp({cluster})` calls with the SAME `ClusterFactory`
produce INDEPENDENT clusters. Factories aren't memoized;
each invocation runs the body and stands up a fresh
transport/membership pair.

Symptoms of violating this rule:

- Double broker connections (or double Redis pub/sub clients)
- Every local emission fans out twice across the wire
- Same nodeId → broker rejects the second client
- Different nodeIds → cluster thinks one process is two members,
  partitioning routes accordingly

**The fix is structural.** Use a gateway for multi-app deployments:

```ts
// WRONG — two clusters in one process
const f = defineUnixCluster({ socketPath: "..." });
const a1 = await createApp(..., { cluster: f });
const a2 = await createApp(..., { cluster: f });

// RIGHT — one cluster, two apps
const gw = await createGateway({ cluster: defineUnixCluster({...}) });
const a1 = await gw.createApp({...});
const a2 = await gw.createApp({...});
```

### Rule 2 — Cluster requires substrate instances, not factories

`createApp({cluster, bus: LocalEventBus.factory()})` throws.

The cluster needs concrete bus/inbox/journal instances to wrap.
Adopter-supplied substrate factories can't be resolved without the
parent shell that IS the substrate we're trying to build —
circular.

Adopters who want cluster + custom substrate factories must
resolve the factories themselves and pass instances:

```ts
const bus = LocalEventBus.factory()(parentShell);
const app = await createApp(..., { cluster, bus });
```

### Rule 3 — Adopter-supplied nodeId always wins

`defineXCluster({nodeId, ...})`: explicit nodeId used as-is.

`defineXCluster({...})` without nodeId: defaults to
`${hostname}:${pid}`. Emits a `cluster:nodeId:auto-defaulted`
diagnostic at construction. If hostname is empty or "localhost"
(typical of containers without HOSTNAME set), emits
`cluster:nodeId:suspicious` instead — production should treat
that diagnostic as a configuration error.

`joinXCluster(...)` follows the same rule, except brokerless
wires (Redis) tag the diagnostic with `layer: "client"`.

### Rule 4 — Gateway-owned wins; app-level cluster opt is honored when no gateway

When app construction sees `cluster: ...`, it always invokes the
factory and wraps. The "precedence" question (gateway vs app
cluster opt) doesn't arise structurally — `gateway.createApp(...)`
does NOT accept a `cluster` field. The gateway-owned cluster is
THE cluster for every app it spawns. The substrate-default chain
(`bus = input.bus ?? this.bus`) means apps inherit
the cluster-wrapped substrate without any explicit "precedence"
code.

Standalone `createApp({cluster})` is independent — used WITHOUT a
gateway, it's the one-app-per-process pattern (Rule 1).

## What `{kind: ...}` config was, and why it's not here

An early Phase 5 sketch considered:

```ts
// REJECTED design
createApp(..., { cluster: { kind: "unix", socketPath: "..." } });
```

Two problems killed it:

1. **Missing-package crashes at runtime.** `{kind: "redis"}` with no
   `cluster-redis-next` installed would dynamic-import-fail at
   createApp call time. Type system can't help. Bundlers can't
   tree-shake.
2. **Dynamic loading is a code smell.** Service-locator-style
   string-keyed registries that load packages on demand confuse
   IDE auto-imports, dep-graph tooling, and bundlers.

The factory form is the only form. Each wire package exports its
own `defineXCluster(...)`; adopters import what they install. The
config form was misdirection — Phase 5's real wins were the
nodeId default, the createApp/createGateway lifecycle integration,
and the documentation of all of the above.

## Defaults inventory

Every required arg has a default, EXCEPT wire-specific addressing.
Minimum-viable adopter call by tier:

| Wire  | Minimum call                                                                                 |
| ----- | -------------------------------------------------------------------------------------------- |
| Unix  | `defineUnixCluster({ socketPath: "..." })`                                                   |
| TCP   | `defineTcpCluster({ port: 9876 })` _(host defaults to `"127.0.0.1"`)_                        |
| WS    | `defineWsCluster({ url: "ws://127.0.0.1:9876/cluster" })`                                    |
| Redis | `defineRedisCluster({ pubClient: ..., subClient: ... })`                                     |
| Local | `defineLocalCluster({ nodeId: "test-node" })` _(testing — `@agentick/cluster-next/testing`)_ |

`partitioning`, `codec`, `fanoutMode`, `journal`, `nodeId` all
default. Adopters override only when they have a reason.

## The fifth wire: defineLocalCluster

`@agentick/cluster-next/testing` ships `defineLocalCluster(opts)`
— the in-memory ClusterFactory. Use it in tests that need cluster
substrate without standing up sockets.

```ts
// Single-node test — implicit registry
const cluster = defineLocalCluster({ nodeId: "test" });

// Multi-node test — explicit shared registry
const registry = createLocalClusterRegistry();
const a = defineLocalCluster({ nodeId: "a", registry });
const b = defineLocalCluster({ nodeId: "b", registry });
```

Same factory shape as the wire-specific defines. Same lifecycle
ownership rules. The only difference is that the wire is an
in-memory map instead of a socket/pub-sub.

## What this ADR does NOT pin

These are deliberately out of scope for Phase 5; they're real
limitations adopters need to know about:

1. **Double-wrap detection.** If an adopter passes the same shared
   substrate instance to multiple `createApp({cluster})` calls
   AND each cluster wraps it, the local bus receives two
   subscriptions for every cluster event → double-deliver. We
   document Rule 1 to steer adopters away; we don't detect-and-
   throw. Future: brand cluster-wrapped substrates so a second
   wrap can refuse.

2. **Per-app clusters under a gateway.** Currently gateway-owned
   is THE cluster for all spawned apps. An adopter who wants
   "this app talks to cluster X, that app talks to cluster Y" has
   to drop down to `joinXCluster` outside the framework lifecycle.
   No structural support for hybrid topologies.

3. **Cluster swap mid-flight.** No way to replace a running
   cluster without closing the app/gateway. Out of scope; would
   need a substrate-rewrap primitive.

4. **Conformance suite coverage of createApp+cluster across all
   four wires.** Today we have:
   - Per-wire seam conformance (transport behavior)
   - One integration spec for `createApp + defineLocalCluster`
   - One integration spec for `createGateway + defineLocalCluster`

   We do NOT parameterize the integration over all four wires.
   Defensible because the seam conformance + the one integration
   path catches regressions in both layers; not parameterizing
   saves real-wire test latency. Future: a conformance suite for
   the integration path if cluster-specific integration bugs slip
   through.

## Where the code lives

```
@agentick/cluster-next                 — protocol seams + makeClusterNode + defaultNodeId/resolveNodeId
  ├── /testing                          — local-cluster doubles + defineLocalCluster
  └── /effect                           — Effect-Tag interfaces (escape hatch)

@agentick/cluster-broker-next          — broker pattern base (BaseBroker, BaseClusterClient, wire-helpers)

@agentick/cluster-net-next             — TCP + Unix wires
  └── defineUnixCluster, defineTcpCluster, joinUnixCluster, joinTcpCluster, ...

@agentick/cluster-ws-next              — WebSocket wire
  └── defineWsCluster, joinWsCluster, ...

@agentick/cluster-redis-next           — Redis pub/sub wire (brokerless)
  └── defineRedisCluster, joinRedisCluster, ...

@agentick/app-next                     — createApp({cluster}) wires substrate fusion
@agentick/gateway-next                 — createGateway({cluster}) wires substrate fusion
```

## Related ADRs

- **35 — Cluster protocol.** The seams, deployment tiers, fanout
  semantics. Foundational; this ADR builds on it.
- **27 — Modular built-ins.** Cluster packages follow the
  bundled-built-in pattern; cluster-next is the protocol home,
  wire packages are peers.
- **31 — Harness hierarchy.** Lifecycle integration
  (`parent.onClose`, BaseHarness slot resolution) is the
  substrate-side mechanism the cluster wraps.
