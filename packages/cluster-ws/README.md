# @agentick/cluster-ws

WebSocket cluster wire for Agentick, built on
[@agentick/cluster-broker](../cluster-broker) and the `ws` library.

Its distinguishing feature is that it can share a port. Mount the broker on an
`http.Server` you already run — the one serving your HTTP API — and cluster
traffic travels over the same port, through the same ingress, terminated by the
same TLS. That makes it the wire to pick when your deployment target only
forwards HTTP: managed platforms, reverse proxies, anything where opening a
second raw TCP port is a fight. If you control the network,
[@agentick/cluster-net](../cluster-net) is a shorter path; for multi-host HA,
[@agentick/cluster-redis](../cluster-redis) is.

## Install

```bash
npm install @agentick/cluster-ws @agentick/cluster
```

`ws` is a direct dependency — nothing extra to install.

## Quick start

One process runs the broker. Every process — including that one — joins as a
node.

```typescript
import { createServer } from "node:http";
import { createGateway } from "@agentick/gateway";
import { defineWsCluster, wsBroker } from "@agentick/cluster-ws";

// On the broker process only: mount on the HTTP server you already have.
const httpServer = createServer(/* your normal routes */);
httpServer.listen(8080);
await wsBroker({ httpServer, path: "/cluster" });

// On every process, including the broker's:
const gateway = await createGateway({
  cluster: defineWsCluster({ url: "ws://broker-host:8080/cluster" }),
});

await gateway.close();
```

`path` defaults to `/cluster`. Upgrade requests on any other path are left
alone, so your other WebSocket endpoints keep working.

If you'd rather the broker own a port:

```typescript
await wsBroker({ host: "127.0.0.1", port: 9876 });
const cluster = defineWsCluster({ url: "ws://127.0.0.1:9876/cluster" });
```

`nodeId` defaults to `${hostname}:${pid}`; `partitioning`, `codec`, `journal`,
and `fanoutMode` fall through to [@agentick/cluster](../cluster)'s defaults.

## Side-channel clusters

For cross-process coordination alongside the agent loop rather than inside it,
`joinWsCluster` returns a `ClusterNode` — a direct handle with a name-based bus,
`waitForPeers`, and `await using` lifecycle. In `mode: "broker"` it starts the
broker itself and joins as a client in one call.

```typescript
import { joinWsCluster } from "@agentick/cluster-ws";

await using node = await joinWsCluster({
  url: "ws://127.0.0.1:9876/cluster",
  mode: "broker", // default is "client"
});

node.bus.subscribe("hello", (env) => console.log(env.scope.nodeId));
await node.membership.waitForPeers(2);
await node.bus.broadcast("hello");
```

Its single `onDiagnostic` receives listener, broker, and client events with a
`layer` tag, so there are no separate callbacks to plumb.

## How it differs from the byte-stream wires

**No length-prefix framing.** WebSocket preserves message boundaries natively,
so one `ws.send(bytes)` is one frame and one `'message'` event is one frame. The
`Connection` wrapper passes binary frames straight through. Text frames are
rejected outright (`cluster:broker:ws:text-frame-rejected`) — the protocol is
binary.

**Subprotocol negotiation.** Clients send
`Sec-WebSocket-Protocol: agentick-cluster-v1` (exported as
`AGENTICK_CLUSTER_SUBPROTOCOL`) and the broker rejects mismatches at the
handshake. That's the forward-compatibility hinge: when the wire protocol
changes incompatibly, the suffix moves and old clients get a clean rejection
instead of a confusing decode error.

**Origin policy.** Because the upgrade rides HTTP, browsers attach an `Origin`
header. `allowedOrigins` rejects upgrades from anything not listed with HTTP
403:

```typescript
await wsBroker({
  httpServer,
  allowedOrigins: ["https://my-app.example"],
});
```

The default is no origin check, since the expected deployment is
server-to-server on a private network.

## API reference

| Export                                     | Role                                                         |
| ------------------------------------------ | ------------------------------------------------------------ |
| `defineWsCluster(opts)`                    | `ClusterFactory` for `createGateway` / `createApp`           |
| `joinWsCluster(opts)`                      | `Promise<ClusterNode>` for side-channel use                  |
| `wsClusterNode(opts)`                      | `{ transport, membership }` over one multiplexed connection  |
| `wsBroker(opts)`                           | `Promise<RunningWsBroker>` — started broker on a WS listener |
| `wsTransport(opts)` / `wsMembership(opts)` | Standalone single-seam factories                             |
| `createWsListener(opts)`                   | `WebSocketServer` as a `Listener`                            |
| `createWsConnector(opts)`                  | `WebSocket(url)` as a `Connector`                            |
| `wsToConnection(ws, opts?)`                | Wrap a raw `ws.WebSocket` as a `Connection`                  |
| `AGENTICK_CLUSTER_SUBPROTOCOL`             | `"agentick-cluster-v1"`                                      |

`BusFacade`, `ClusterNode`, and `MembershipFacade` are re-exported from
[@agentick/cluster](../cluster) so typing a returned node needs one import.

### Options

`WsBrokerOptions` is a union: supply **either** `httpServer` **or** `port`
(with optional `host`), never both. Plus `path`, `allowedOrigins`, `codec`, and
`onDiagnostic`.

```typescript
interface WsClusterNodeOptions {
  nodeId: NodeId; // required
  url: string; // e.g. "ws://127.0.0.1:9876/cluster"
  codec?: ClusterCodec; // default: bundled JSON
  heartbeatMs?: number; // default 30_000
  missedPongLimit?: number; // default 3
  reconnect?: { initialMs?: number; maxMs?: number; maxAttempts?: number };
  connectTimeoutMs?: number;
  onDiagnostic?: (name: string, payload?: unknown) => void;
}
```

`DefineWsClusterOptions` is that shape with `nodeId` optional, plus
`partitioning`, `journal`, and `fanoutMode`. `JoinWsClusterOptions` adds
`mode: "broker" | "client"`, `httpServer`, `allowedOrigins`, and `brokerCodec`
for when the broker should use a different codec than the client.

## Diagnostics

WebSocket-layer events, alongside the `cluster:broker:server:*` and
`cluster:broker:client:*` families from
[@agentick/cluster-broker](../cluster-broker):

| Event                                                                                      | Meaning                                              |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `cluster:broker:ws:listener-mounted`                                                       | Attached to an existing `http.Server`                |
| `cluster:broker:ws:listener-bound`                                                         | Standalone server bound its own port                 |
| `cluster:broker:ws:listener-closed`                                                        | Listener shut down                                   |
| `cluster:broker:ws:origin-rejected`                                                        | `Origin` not in `allowedOrigins`                     |
| `cluster:broker:ws:subprotocol-mismatch`                                                   | Broker refused the offered subprotocol (client side) |
| `cluster:broker:ws:connected`                                                              | Client connected                                     |
| `cluster:broker:ws:connect-failed`                                                         | Connect attempt failed                               |
| `cluster:broker:ws:connect-timeout`                                                        | `connectTimeoutMs` elapsed                           |
| `cluster:broker:ws:socket-error`                                                           | Socket-level error                                   |
| `cluster:broker:ws:text-frame-rejected`                                                    | Non-binary frame received                            |
| `cluster:broker:ws:unrecognized-payload`                                                   | Binary frame in an unknown shape                     |
| `cluster:broker:ws:accept-handler-threw` / `close-handler-threw` / `message-handler-threw` | A handler threw; contained and reported              |

## Verified by

- `src/__tests__/conformance-against-ws.spec.ts` —
  `runClusterTransportConformance` from [@agentick/cluster](../cluster) against
  the WebSocket wire. The same suite that validates the in-memory reference
  transport, TCP, and Unix sockets.
- `src/__tests__/verification.spec.ts` — the broker rejects clients that don't
  request `agentick-cluster-v1` and accepts those that do; a mounted listener
  coexists with another route handler on the same server, and upgrade requests
  on a different path are passed through unclaimed; `allowedOrigins` rejects a
  disallowed `Origin`; `connectTimeoutMs` rejects when the broker never accepts.
- `src/__tests__/join-ws-cluster.spec.ts` — `mode: "broker"` starts the broker
  while `mode: "client"` joins an existing one, with `bus` round-trip and
  `waitForPeers` end to end; the diagnostic sink is layer-tagged across broker
  and client; `close()` is idempotent and `Symbol.asyncDispose` mirrors it.

## Roadmap & known gaps

- **No TLS shorthand.** `wsBroker({ httpServer })` inherits whatever the server
  is: pass an HTTPS server and the wire is `wss://` with no extra work. There is
  no `wsBroker({ port, tls })` form, so standalone TLS means constructing the
  HTTPS server yourself and mounting on it.
- **Browser clients are untested.** The protocol is plain binary WebSocket with
  a subprotocol, so a browser `WebSocket` should be able to speak it given a
  binary-safe codec and an `allowedOrigins` entry — but nothing here exercises
  a browser client, and the frame schema is not a published contract.
- **No compression.** `permessage-deflate` is available in `ws` but off; it is
  not wired to an option here. Verbose payloads pay full size on the wire.
- **`Sec-WebSocket-Key` validity isn't checked** beyond what `ws` does. A
  malformed upgrade is rejected by the library, not by an explicit policy here.
- **Broker re-election is not implemented for this wire.** If the broker
  process dies, clients reconnect with backoff but nothing promotes a survivor;
  recovery depends on a supervisor restarting the broker.
  [@agentick/cluster-net](../cluster-net) has internal re-election for Unix
  sockets only.
- **The listener / connector / cluster trio duplicates
  [@agentick/cluster-net](../cluster-net)'s** almost shape for shape. A shared
  layer between the two is plausible but unbuilt — two implementations is thin
  evidence for the right abstraction.
