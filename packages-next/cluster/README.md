# @agentick/cluster-next

Cluster **protocol** for Agentick v2. Ships the typed seams, factory
shapes, and `defineCluster*` adapter-authoring helpers — but NO
transport implementations. Adapter packages
(`@agentick/cluster-ipc-next`, `@agentick/cluster-redis-next`, etc.)
provide the actual wire.

**Status:** Phase 1 (protocol scaffold). Types and helper signatures
land in this slice; the `defineCluster*` impls + JSON codec +
`LocalClusterTransport` fixture + conformance suite ship in Phase 2.

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
| 2 | `defineCluster*` impls + JSON codec + `LocalClusterTransport` fixture + conformance suite | pending |
| 3 | `ClusterEventBus` / `ClusterInbox` wrapper impls + diagnostic event emission | pending |
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

Phase 1 (this slice): nothing yet — type-only scaffold. Phase 2 +
later adapter packages get the conformance suite once it's
implemented.

## Roadmap & known gaps

- **`defineClusterX(impl)` helpers throw "not yet implemented"** at
  runtime — Phase 1 ships signatures only. Phase 2 lands the
  Promise/callback → Effect-Layer bridge that makes them work.
- **`LocalClusterTransport` fixture not yet shipped.** The
  `/testing` subpath is currently empty; Phase 2 lands the
  in-memory multi-node simulator.
- **No conformance suite body.** `runClusterTransportConformance`
  is a thrown stub. Phase 2 lands the suite.
- **Cluster substrate seam not yet wired into `createGateway` /
  `createApp`.** ADR 35 §1 describes the integration; Phase 5
  implements it.
- **No real adapter packages.** `@agentick/cluster-ipc-next` is
  the first; Phase 4.
- **Rung (d) durability is documented but not implementable** until
  the framework's continuation primitives ship (v2.x). The
  `DurableJournal` seam exists so adapters can build incrementally.
