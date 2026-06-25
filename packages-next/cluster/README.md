# @agentick/cluster-next

Cluster **protocol** for Agentick v2. Ships the typed seams, factory
shapes, and `defineCluster*` adapter-authoring helpers — but NO
transport implementations. Adapter packages
(`@agentick/cluster-ipc-next`, `@agentick/cluster-redis-next`, etc.)
provide the actual wire.

**Status:** Phase 3.1 — wrappers + cross-node ask + diagnostics
landed. `ClusterEventBus` / `ClusterInbox` wrap the parent's local
substrate and route across the cluster transport. Remote `ask` works
end-to-end via a cluster-internal `@cluster/ask` / `@cluster/ask-response`
wire framing with correlationId-keyed pending-deferred registry; typed
`MessageHandlerError` survives the round-trip. `defineCluster`
subscribes `membership.onChange` and emits `cluster:membership:*`
diagnostics on every topology transition. Transport failures
(`broadcast`, `send`) emit `cluster:transport:*:failed` diagnostics
instead of vanishing. Inbound routes to unregistered addresses emit
`cluster:routing:address-not-found` instead of silent drop. Phase 4
(`@agentick/cluster-ipc-next`, first real adapter) and Phase 5
(createGateway / createApp substrate-seam integration) are next.

**Design:** [ADR 35 — cluster protocol](../../docs/proposals/v2/blueprint/35-cluster-protocol.md) ·
[ADR 11 — cluster vision](../../docs/proposals/v2/blueprint/11-cluster.md)

## What this package is

Cluster mode in Agentick is a **substrate wrapper** — when configured
on `createGateway` (canonical) or `createApp` (fallback), the
gateway's local `bus / inbox / journal` are wrapped with cluster-aware
variants that add cross-node transport while preserving local fan-out
for node-local subscribers. Children of the cluster-defining harness
inherit the wrapped substrate via the factory-pattern parent-chain;
they're blind to whether substrate is local or clustered.

This package defines the protocol — five typed seams adapters
implement — plus the `defineCluster` factory that composes them.
Adapter implementations ship separately so adopters install only
what they need (Redis pub/sub vs NATS JetStream vs IPC vs custom).

## Quick start (Phase 2+)

```typescript
import { createGateway } from "@agentick/gateway-next";
import { defineCluster } from "@agentick/cluster-next";
import { ipcTransport, ipcMembership } from "@agentick/cluster-ipc-next";

const gateway = await createGateway({
  cluster: defineCluster({
    nodeId: () => process.env.NODE_ID ?? `auto-${process.pid}`,
    transport: ipcTransport({
      // Auto-elect: first to bind becomes broker; rest connect.
      socketPath: "/tmp/agentick.sock",
    }),
    membership: ipcMembership(),
  }),
  // ... rest of gateway options
});
```

Without `cluster` configured, the gateway behaves identically to
today — pure local substrate, zero overhead.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Protocol scaffold — types, factory shapes, helper signatures | **shipped** |
| 2 | `defineCluster*` impls + JSON codec + `LocalClusterTransport` fixture + conformance suite | **shipped** |
| 3 | `ClusterEventBus` / `ClusterInbox` wrapper impls + diagnostic event emission | **shipped** |
| 3.1 | Cross-node `ask` + membership reactivity + transport diagnostics + loud routing | **shipped** |
| 4 | `@agentick/cluster-ipc-next` — cross-runtime broker (first real adapter) | pending |
| 5 | Gateway/App substrate-seam integration + Otto cluster demo | pending |
| 6 | `@agentick/cluster-redis-next` — cross-machine via Redis | pending |
| 7+ | NATS, MessagePack/protobuf codecs, durability (rung d) | pending |

## API surface (Phase 1)

### Protocol seams (interfaces)

| Seam | Role |
|---|---|
| `ClusterTransport` | Cross-node wire — sends messages point-to-point, broadcasts events |
| `ClusterMembership` | Tracks live cluster members + emits join/lost transitions |
| `ClusterPartitioning` | Maps address → owning node (default: consistent-hash; override for multi-tenant) |
| `ClusterCodec` | Wire serialization (default: JSON; swap for MessagePack / protobuf / custom) |
| `DurableJournal` | Optional rung (d) — durable journal with replay |

### `Cluster` value

The factory's return — what the framework reads from at the
substrate seam.

```typescript
interface Cluster {
  readonly bus: EventBus;          // wrapped local bus + cross-node fan-out
  readonly inbox: MessageInbox;    // wrapped local inbox + cross-node routing
  readonly journal: OperationJournal;
  readonly currentNode: NodeId;
  nodes(): Promise<readonly NodeId[]>;
  ownerOf(address: string): Promise<NodeId>;
  close(): Promise<void>;
}
```

### Adapter authoring (Phase 2)

Adapter packages implement seams and wrap them in
`defineClusterX(impl)` helpers — Promise-flavored boring code, no
Effect knowledge needed. Power users who want Effect/Layer
composition for their adapter drop into a `/effect` subpath export
(future slice).

### Conformance

`@agentick/cluster-next/conformance` exposes
`runClusterTransportConformance(config)` — adapter test suites pass
their transport factory to verify ordering, delivery, lifecycle,
filter semantics, and resource cleanup against the protocol's
contract.

## Observability

Cluster is **not** a harness. It emits diagnostic events on the bus
it wraps with `surface: "cluster"`:

- `cluster:node:joined` / `cluster:node:lost`
- `cluster:partition:detected` / `cluster:partition:healed`
- `cluster:routing:dropped`
- `cluster:transport:reconnecting` / `cluster:transport:reconnected`
- `cluster:journal:backpressure` (rung d)

Any bus subscriber (devtools, management dashboards, OTel exporters,
adopter monitoring) sees them through the standard subscription path.

## Verified by

- `src/__tests__/json-codec.spec.ts` — JSON codec round-trips
  `MessageEnvelope` / `EventEnvelope` through encode → decode.
- `src/__tests__/consistent-hash-partitioning.spec.ts` — default
  partitioning is deterministic, balanced, FNV-1a-hashed.
- `src/__tests__/define.spec.ts` — `defineCluster` composes seams,
  resolves lazy `nodeId`, wraps bus/inbox, registers all close
  handlers with the parent.
- `src/__tests__/conformance-against-local.spec.ts` — the conformance
  suite passes against `LocalClusterTransport`.
- `src/__tests__/cluster-wrappers.spec.ts` — `ClusterEventBus` honors
  `cluster-wide-default` (remote events visible) and
  `node-local-default` (remote events dropped); emits
  `cluster:wrap:installed` diagnostic. `ClusterInbox` routes local
  `send` to the local inbox and remote `send` over the transport;
  `ask` is local-only (Phase 3) — remote ask fails with a clear
  Phase 3b pointer.

## Roadmap & known gaps

- **`subscribe` always returns the LOCAL bus stream.** In
  `node-local-default` mode this is correct — only local events are
  visible. In `cluster-wide-default` it works because remote events
  are re-appended into the local bus. A future "cluster-wide
  subscriber opt-in" path (per-subscription cross-cluster flag)
  would let a single bus serve both audiences without flipping the
  global default. Phase 5+.
- **`publishLazy` over-builds in `cluster-wide-default` mode.** The
  wrapper can't probe remote nodes' subscriber indexes from here, so
  it always builds when fan-out crosses the wire. Adopters with hot
  publishers can keep `fanoutMode: "node-local-default"` to retain
  the short-circuit.
- **Codec is constructed but not yet routed through** — the local
  fixture transport stays in-process and doesn't serialize. Adapter
  packages (cluster-ipc-next, cluster-redis-next) consume the codec
  for their wire serialization in Phase 4+.
- **Cluster substrate seam not yet wired into `createGateway` /
  `createApp`.** ADR 35 §1 describes the integration; Phase 5
  implements it. Until then, adopters must construct the cluster
  manually against a parent shell.
- **No real adapter packages.** `@agentick/cluster-ipc-next` is the
  first; Phase 4.
- **Rung (d) durability is documented but not implementable** until
  the framework's continuation primitives ship (v2.x). The
  `DurableJournal` seam exists so adapters can build incrementally.

### IPC broker leader re-election (Phase 4 concern)

The `@agentick/cluster-ipc-next` adapter (Phase 4) elects ONE process
as the broker; other processes connect as clients. If the broker dies,
clients lose their wire — the cluster's transport effectively
partitions until a new broker exists.

Two recovery paths the adapter supports, ranked by what Phase 4 ships:

1. **External supervisor restarts the broker** (PM2, Kubernetes,
   systemd, Docker restart policy). Clients detect disconnect, retry
   with exponential backoff, reconnect once the broker is back up.
   The adapter does nothing special — the orchestrator handles
   restart. **This is the Phase 4 default.**
2. **Internal re-election** — file-lock on the socket path (Unix) or
   bind-on-port race (TCP); first-to-acquire becomes the new broker;
   others connect to the new winner. More complex; lands if real
   demand surfaces for self-contained clustering without external
   supervisor.

Either way, the protocol layer doesn't care — `ClusterMembership`
just emits `lost` for the old broker + `joined` for the new one;
framework reacts naturally via the membership stream.
