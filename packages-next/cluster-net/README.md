# @agentick/cluster-net-next

**TCP + Unix-socket cluster transport** for Agentick v2. Concrete
wire impl built on
[`@agentick/cluster-broker-next`](../cluster-broker) + Node's `net`
module.

Phase 4b ships the TCP factories (`tcpTransport`, `tcpMembership`,
`tcpBroker`, `defineTcpCluster`). Phase 4d will add Unix-socket
factories alongside the same package (same Node `net` module,
different bind address).

**External-broker adapters** (`@agentick/cluster-redis-next`,
`@agentick/cluster-nats-next`) are peers of this package, not
children — they talk a different broker's protocol and don't use
the `cluster-broker-next` plumbing.

**Status:** Phase 4d (TCP + Unix socket shipped).
`runClusterTransportConformance` passes 10/10 against TCP AND 10/10
against Unix sockets. Multiplexed transport+membership over ONE
connection per node; auto-elect first-to-bind (with stale-socket
cleanup for Unix); length-prefix framing.

**Design:** [ADR 35 — cluster protocol](../../docs/proposals/v2/blueprint/35-cluster-protocol.md) ·
[`@agentick/cluster-broker-next`](../cluster-broker/README.md)

## Quick start

### Convenience: `defineTcpCluster` (zero-boilerplate)

```typescript
import { defineTcpCluster } from "@agentick/cluster-net-next";
import { createGateway } from "@agentick/gateway-next"; // Phase 5

const cluster = defineTcpCluster({
  nodeId: () => process.env.NODE_ID ?? `auto-${process.pid}`,
  host: "127.0.0.1",
  port: 9876,
  // optional: partitioning, codec, journal, fanoutMode pass through
});

const gateway = await createGateway({ cluster, /* ... */ });
```

### Manual composition (full control)

```typescript
import { defineCluster } from "@agentick/cluster-next";
import { tcpClusterNode } from "@agentick/cluster-net-next";

// One client, one TCP connection — transport + membership multiplex.
const { transport, membership } = tcpClusterNode({
  nodeId: () => process.env.NODE_ID,
  host: "127.0.0.1",
  port: 9876,
});

const cluster = defineCluster({
  nodeId: () => process.env.NODE_ID,
  transport,
  membership,
  partitioning: myCustomPartitioning, // optional
  codec: msgpackCodec(), // optional — when wire codec routing lands
});
```

### Running a broker

```typescript
import { tcpBroker } from "@agentick/cluster-net-next";

const running = await tcpBroker({
  host: "127.0.0.1",
  port: 9876,
});

// ... cluster members connect ...

// On shutdown:
await running.close();
```

### Auto-elect first-to-bind

```typescript
import { tryBindOrConnect, createTcpListener, tcpClusterNode } from "@agentick/cluster-net-next";
import { BaseBroker } from "@agentick/cluster-broker-next";

const elected = await tryBindOrConnect({ host: "127.0.0.1", port: 9876 });
if (elected.role === "broker") {
  // This process won the race — adopt the server into a listener
  // and run the broker.
  const listener = createTcpListener({ adoptServer: elected.server! });
  const broker = new BaseBroker({ listener, codec });
  await broker.start();
}
// Either way, also spin up the local node so we can talk to the cluster:
const node = tcpClusterNode({ nodeId, host: "127.0.0.1", port: 9876 });
```

## API

### High-level

| Export | Role |
|---|---|
| `defineTcpCluster(opts)` | Returns a `ClusterFactory` — convenience for the common case |
| `tcpClusterNode(opts)` | Returns `{ transport, membership }` over one multiplexed connection |
| `tcpBroker(opts)` | Spins up + starts a `BaseBroker` on a TCP listener |
| `tcpTransport(opts)` | Standalone `ClusterTransportFactory` (opens its own connection) |
| `tcpMembership(opts)` | Standalone `ClusterMembershipFactory` (opens its own connection) |
| `tryBindOrConnect(opts)` | First-to-bind broker-election helper |

### Low-level

| Export | Role |
|---|---|
| `createTcpListener(opts)` | Wraps `net.Server` as a `Listener` for `BaseBroker` |
| `createTcpConnector(opts)` | Wraps `net.Socket` connect as a `Connector` for `BaseClusterClient` |
| `socketToConnection(socket)` | Wraps a raw `net.Socket` in the message-oriented `Connection` interface |

## Connection multiplexing

`tcpClusterNode` returns BOTH a transport factory AND a membership
factory, both backed by ONE underlying `BaseClusterClient` (= one TCP
connection). The membership consumer reads `BaseClusterClient.nodes()`
and `onMembershipChange()` directly; the transport consumer goes
through the `ClusterTransport` interface.

If you call `tcpTransport(opts)` and `tcpMembership(opts)`
SEPARATELY (passing them to `defineCluster` independently), you get
TWO connections per node. Use `tcpClusterNode` to share.

## Auto-elect mechanics

`tryBindOrConnect` tries to bind `host:port`. The OS lets exactly
one process succeed; everyone else gets `EADDRINUSE`. Three modes:

- `mode: "auto"` (default) — race; winner becomes broker, losers
  fall back to client.
- `mode: "broker"` — explicit; fails loudly if the port is in use.
- `mode: "client"` — never tries to bind; assumes the broker
  already exists.

Phase 4 default broker recovery is **external supervisor restart**
(PM2 / systemd / k8s). If the broker dies, the supervisor brings a
new process up, which retries the bind, becomes the new broker.
Clients reconnect via `BaseClusterClient`'s built-in backoff. Internal
re-election (clients race to bind after detecting broker loss) is
deferred — tracked as Phase 4+ optional.

## Verified by

- `src/__tests__/conformance-against-tcp.spec.ts` —
  `runClusterTransportConformance` against the TCP wire. 10 tests
  (send/inbox × 4, broadcast/bus × 3, subscription lifecycle × 2,
  close × 1).
- Same conformance suite that passes against
  `LocalClusterTransport` — proving the TCP wire honors the same
  protocol contract.

## TCP-specific knobs

`TcpClusterNodeOptions` extends the base client knobs:

```typescript
interface TcpClusterNodeOptions {
  nodeId: NodeId;
  host?: string;        // default: "127.0.0.1"
  port: number;
  maxFrameBytes?: number;
  heartbeatMs?: number;
  missedPongLimit?: number;
  reconnect?: { initialMs, maxMs, maxAttempts };
  connectTimeoutMs?: number;  // default: 5000
  codec?: ClusterCodec;       // default: bundled JSON
  onDiagnostic?: (name, payload) => void;
}
```

## Diagnostics emitted (`surface: "cluster"`)

Net-layer specifics (in addition to the
[`cluster-broker-next`](../cluster-broker/README.md) diagnostics):

- `cluster:broker:net:listener-bound` / `listener-adopted` / `listener-closed`
- `cluster:broker:net:listener-error`
- `cluster:broker:net:accept-handler-threw`
- `cluster:broker:net:connect-failed` / `connect-timeout`
- `cluster:broker:net:connected`
- `cluster:broker:net:socket-error`
- `cluster:broker:net:close-handler-threw`
- `cluster:broker:net:message-handler-threw`
- `cluster:broker:net:decoder-poisoned`

## Roadmap & known gaps

- **Phase 4d** — Unix-socket factories (`unixTransport`,
  `unixMembership`, `defineUnixCluster`) ship in the same package.
  ~99% shared with TCP code; just a different bind address shape.
- **Phase 4c** — multi-process integration tests (child_process.fork
  harness; cross-process remote ask; SIGTERM-driven `lost` membership).
- **Per-connection backpressure** — see TODO(phase-4b) in
  `socket-connection.ts`. `socket.write` return value isn't checked;
  slow clients can stall the broker under broadcast storms.
- **TLS support** — TCP only for now. Wrap with `tls.createServer` /
  `tls.connect` for production deployments crossing untrusted
  networks (typically you'd reach for `cluster-redis-next` or
  `cluster-ws-next` over HTTPS instead).
- **No TODO(phase-4b) compileQuery dependency** — see TODOs in
  `cluster-broker-next` + `cluster-next` for the deferred work that
  cluster-net-next inherits.
