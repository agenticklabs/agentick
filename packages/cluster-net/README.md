# @agentick/cluster-net

TCP and Unix-socket cluster wires for Agentick, built on
[@agentick/cluster-broker](../cluster-broker) and Node's `net` module. Both
wires are the same code with a different bind address: TCP crosses hosts, Unix
sockets are the zero-infrastructure single-host option.

Reach for Unix sockets when you're running several workers on one box (a PM2
fork pool, Node's cluster module) — the first process to bind the socket becomes
the broker, the rest connect, and if the broker dies a survivor can be promoted
without a supervisor. Reach for TCP when nodes span hosts and you want to run
your own broker rather than depend on Redis. For multi-host production with real
HA, [@agentick/cluster-redis](../cluster-redis) is usually the better answer.

## Install

```bash
npm install @agentick/cluster-net @agentick/cluster
```

## Quick start

Pass a `defineXCluster` factory to `createGateway` (or `createApp`). The
framework owns the cluster lifecycle — closing the gateway closes the cluster.

```typescript
import { createGateway } from "@agentick/gateway";
import { defineUnixCluster } from "@agentick/cluster-net";

// Every worker runs this. First to bind the socket becomes the broker.
const gateway = await createGateway({
  cluster: defineUnixCluster({ socketPath: "/tmp/agentick.sock" }),
});

await gateway.close();
```

TCP is the same shape with a port:

```typescript
import { defineTcpCluster } from "@agentick/cluster-net";

const cluster = defineTcpCluster({ port: 9876 }); // host defaults to "127.0.0.1"
```

`nodeId` defaults to `${hostname}:${pid}` on both, and `partitioning`, `codec`,
`journal`, and `fanoutMode` all fall through to
[@agentick/cluster](../cluster)'s defaults.

## Side-channel clusters

Substrate fusion is right when cluster traffic _is_ agent traffic. When you want
cross-process coordination alongside the agent loop — a work-stealing queue, a
leader-only cron, replica-to-replica notifications — `joinXCluster` hands you a
`ClusterNode` directly, with no substrate wrapping and no gateway involved.

```typescript
import { joinUnixCluster } from "@agentick/cluster-net";

await using node = await joinUnixCluster({ socketPath: "/tmp/agentick.sock" });

node.bus.subscribe("hello", (env) => console.log("from", env.scope.nodeId));
await node.membership.waitForPeers(2);
await node.bus.broadcast("hello", { greeting: "hi" });
// Disposed at scope exit — subscriptions dropped, client closed, any
// locally-elected broker shut down.
```

`joinUnixCluster` runs the bind race itself and installs the re-election
watcher. The TCP equivalent takes an explicit role:

```typescript
import { joinTcpCluster } from "@agentick/cluster-net";

const node = await joinTcpCluster({ port: 9876, mode: "broker" }); // or "client" | "auto"
```

`mode` defaults to `"client"` for TCP: cross-host adopters should say which
process is the broker rather than race for it.

## Broker election

`tryBindOrConnect` (TCP) and `tryBindOrConnectUnix` (Unix) are the election
primitive. Binding an address is already an atomic OS-level race — exactly one
process succeeds and everyone else gets `EADDRINUSE` — so no consensus protocol
is needed for a single host.

| `mode`             | Behavior                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `"auto"` (default) | Race. Winner returns `role: "broker"` with the bound `Server`; losers get `role: "client"`. |
| `"broker"`         | Bind or throw. `EADDRINUSE` is a loud failure, not a fallback.                              |
| `"client"`         | Never binds. Returns `role: "client-explicit"` immediately.                                 |

The winner's `Server` comes back on the result so a listener can adopt it
instead of re-binding:

```typescript
import { tryBindOrConnect, createTcpListener, tcpClusterNode } from "@agentick/cluster-net";
import { startBroker } from "@agentick/cluster-broker";

const elected = await tryBindOrConnect({ host: "127.0.0.1", port: 9876 });
if (elected.role === "broker" && elected.server) {
  const listener = createTcpListener({ adoptServer: elected.server });
  await startBroker({ listener });
}

// Either way, join the cluster as a node.
const node = tcpClusterNode({ nodeId: "node-a", host: "127.0.0.1", port: 9876 });
```

`tryBindOrConnectUnix` additionally unlinks a **stale** socket file before
binding — a crash-left-over socket is the common case on Unix — while refusing
to take over a socket that something is still listening on. `unixBroker` does
the same; pass `cleanupStaleSocket: false` when a supervisor promises to clean
up and you'd rather fail loudly.

### Recovering from a dead broker

Two paths, and the first is the default:

1. **External supervisor restart.** systemd, PM2, Kubernetes, or a Docker
   restart policy brings a process back; it re-binds and becomes the broker.
   Clients reconnect through `BaseClusterClient`'s backoff and their
   subscriptions are restored. Works on TCP, Unix, and WebSocket.
2. **Internal re-election (Unix only).** `electableUnixClusterNode` and
   `joinUnixCluster` count consecutive `cluster:broker:client:connect-failed`
   diagnostics; after the threshold (default 5) surviving workers race to bind
   the vacated socket and the winner spins up a local broker. No supervisor
   needed.

Pick the threshold high enough to ride out a supervisor restart and low enough
to fail over before adopter-visible work times out.

Multi-host re-election is deliberately absent: a cross-host bind race is
meaningless, and cross-host consensus is the wrong tool at this layer. For
multi-host HA use [@agentick/cluster-redis](../cluster-redis), where Redis
Sentinel or Cluster owns failover.

## Connection multiplexing

`tcpClusterNode` / `unixClusterNode` return **both** the transport and the
membership factory, backed by one `BaseClusterClient` and therefore one socket.
Membership reads the client's handshake-derived node list; the transport goes
through the `ClusterTransport` interface. The client is created lazily on first
factory invocation.

> [!WARNING]
> Calling `tcpTransport(opts)` and `tcpMembership(opts)` separately and passing
> them to `defineCluster` independently opens **two** connections per node.
> Use `tcpClusterNode` unless you specifically want that.

## Manual composition

When you need full control over the seams:

```typescript
import { defineCluster } from "@agentick/cluster";
import { tcpClusterNode } from "@agentick/cluster-net";

const { transport, membership } = tcpClusterNode({
  nodeId: "node-a", // required here — the define/join facades are what default it
  host: "127.0.0.1",
  port: 9876,
});

const cluster = defineCluster({ nodeId: "node-a", transport, membership });
```

## Unix socket permissions

A Unix socket is a filesystem object, so it obeys filesystem permissions —
which is the whole security model for a single-host cluster. `mode` is applied
via `chmod` after bind, and a chmod failure is loud: `listener.start()` throws
rather than leaving a world-writable socket in place.

```typescript
import { unixBroker } from "@agentick/cluster-net";

const running = await unixBroker({
  socketPath: "/run/agentick/cluster.sock",
  mode: 0o600, // owner-only
});
await running.close();
```

## API reference

### High level

| Export                             | Returns                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| `defineTcpCluster(opts)`           | `ClusterFactory` for `createGateway` / `createApp`                              |
| `defineUnixCluster(opts)`          | Same, Unix addressing                                                           |
| `joinTcpCluster(opts)`             | `Promise<ClusterNode>` — side-channel, explicit `mode`                          |
| `joinUnixCluster(opts)`            | `Promise<ClusterNode>` — bind race + re-election watcher built in               |
| `tcpClusterNode(opts)`             | `{ transport, membership }` over one multiplexed connection                     |
| `unixClusterNode(opts)`            | Unix variant                                                                    |
| `electableUnixClusterNode(opts)`   | `unixClusterNode` + re-election, plus `getLocalBroker()` / `closeLocalBroker()` |
| `tcpBroker(opts)`                  | `Promise<RunningTcpBroker>` — started broker on a TCP listener                  |
| `unixBroker(opts)`                 | Unix variant with stale-socket cleanup                                          |
| `tcpTransport` / `tcpMembership`   | Standalone single-seam factories (each opens its own connection)                |
| `unixTransport` / `unixMembership` | Unix variants                                                                   |
| `tryBindOrConnect(opts)`           | TCP election                                                                    |
| `tryBindOrConnectUnix(opts)`       | Unix election, with stale-socket handling                                       |

### Low level

| Export                              | Role                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `createTcpListener(opts)`           | `net.Server` (bound or adopted) as a `Listener`            |
| `createUnixListener(opts)`          | Unix variant, with `mode` and `cleanupStaleSocket`         |
| `createTcpConnector(opts)`          | `net.Socket` connect as a `Connector`                      |
| `createUnixConnector(opts)`         | Unix variant                                               |
| `socketToConnection(socket, opts?)` | Wrap a raw `net.Socket` as a message-oriented `Connection` |

`BusFacade`, `ClusterNode`, and `MembershipFacade` are re-exported from
[@agentick/cluster](../cluster) so typing a returned node doesn't require a
second import.

### Client knobs

`TcpClusterNodeOptions` (and its Unix twin, with `socketPath` in place of
`host` / `port`) carries the endpoint plus the base client's knobs:

```typescript
interface TcpClusterNodeOptions {
  nodeId: NodeId; // required
  port: number; // required
  host?: string; // default "127.0.0.1"
  maxFrameBytes?: number;
  codec?: ClusterCodec; // default: bundled JSON
  heartbeatMs?: number; // default 30_000
  missedPongLimit?: number; // default 3
  reconnect?: { initialMs?: number; maxMs?: number; maxAttempts?: number };
  connectTimeoutMs?: number;
  onDiagnostic?: (name: string, payload?: unknown) => void;
}
```

`defineTcpCluster` / `joinTcpCluster` take the same shape with `nodeId`
optional, plus `partitioning`, `journal`, and `fanoutMode`. The `join*`
variants take one `onDiagnostic` that receives events from the listener,
broker, and client layers with a `layer` tag, so you don't plumb three
callbacks.

## Diagnostics

Net-layer events, in addition to the `cluster:broker:server:*` and
`cluster:broker:client:*` families from
[@agentick/cluster-broker](../cluster-broker):

`cluster:broker:net:` + `listener-bound` · `listener-adopted` ·
`listener-closed` · `listener-error` · `accept-handler-threw` ·
`stale-socket-unlinked` · `chmod-failed` · `connected` · `connect-failed` ·
`connect-timeout` · `socket-error` · `close-handler-threw` ·
`message-handler-threw` · `decoder-poisoned`.

Re-election adds `cluster:broker:re-election:` + `attempt` · `promoted` ·
`lost-race` · `failed`.

## Verified by

- `src/__tests__/conformance-against-tcp.spec.ts` and
  `conformance-against-unix.spec.ts` — `runClusterTransportConformance` from
  [@agentick/cluster](../cluster) against both wires. The same suite that
  validates the in-memory reference transport.
- `src/__tests__/verification.spec.ts` — election across all three modes
  (clean bind, `EADDRINUSE` fallback, explicit-broker throw, explicit-client
  no-bind); `tcpClusterNode` opens exactly one connection for both seams;
  `connectTimeoutMs` rejects on an unreachable target and emits
  `connect-timeout`; the listener / connected / connect-failed diagnostic set;
  `flush()` during close resolves instead of hanging, and snapshots its pending
  set so subscriptions added mid-flush don't extend the wait.
- `src/__tests__/unix-stale-cleanup.spec.ts` — `unixBroker` unlinks a stale
  socket, refuses to bind over one when `cleanupStaleSocket: false`, takes over
  a stale file but not a live socket via `tryBindOrConnectUnix`; `mode: 0o600`
  applies owner-only permissions and a chmod failure throws from
  `listener.start()`; `createUnixListener` can adopt a pre-bound server.
- `src/__tests__/broker-restart.spec.ts` — a client reconnects across broker
  close and rebind with subscriptions restored, and gives up after
  `maxAttempts` when the broker never returns.
- `src/__tests__/unix-re-election.spec.ts` — a surviving worker wins the bind
  race after the broker dies and becomes the new broker; a worker that loses
  the race stays a client and emits the lost-race diagnostic.
- `src/__tests__/join-unix-cluster.spec.ts` — first joiner wins the race and
  becomes broker while the second joins as client; `waitForPeers` resolves at
  the threshold and rejects on timeout; name-based `bus.subscribe` fires only
  for matching events and `broadcast` auto-stamps the envelope; `close()` is
  idempotent, `Symbol.asyncDispose` mirrors it, `await using` disposes at scope
  exit; the diagnostic sink is layer-tagged from both layers.
- `src/__tests__/join-tcp-cluster.spec.ts` — `mode: "broker"` starts the broker
  and joins as a client, `mode: "client"` joins an existing one, `mode: "auto"`
  races and the loser joins as client; layer-tagged diagnostics.

## Roadmap & known gaps

- **No TLS shorthand.** `tcpBroker` / `tcpClusterNode` speak plaintext. For
  untrusted networks, wrap with `tls.createServer` / `tls.connect` yourself, or
  use [@agentick/cluster-ws](../cluster-ws) behind HTTPS or
  [@agentick/cluster-redis](../cluster-redis) with `rediss://`.
- **No Windows named-pipe wire.** Windows has no Unix domain sockets in the
  form this wire needs; named pipes differ enough to warrant their own
  implementation. Use the TCP factories on Windows.
- **Per-connection write backpressure is only at the broker.** The broker's
  fan-out is bounded per connection, but `socket.write`'s return value isn't
  checked in `socket-connection.ts`, so a slow reader can still buffer in the
  kernel and in Node's internal queue.
- **`Connection.id` has no cross-wire convention** — inherited from
  [@agentick/cluster-broker](../cluster-broker); two listeners in one process
  could in principle mint colliding ids.
- **No multi-process integration suite.** Every test here runs in-process.
  Cross-process behavior — a `child_process.fork` harness, SIGTERM-driven
  `lost` membership, cross-process remote ask — is exercised only manually.
- **The codec is honored at this wire but not composed through
  `defineCluster`.** Passing `codec` to `defineTcpCluster` reaches the client;
  passing it to `defineCluster` directly does not change serialization. See the
  gaps in [@agentick/cluster](../cluster).
