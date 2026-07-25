# @agentick/cluster-ws

**WebSocket cluster transport** for Agentick v2. Concrete wire impl
built on [`@agentick/cluster-broker`](../cluster-broker) + the
`ws` library. Mounts on an adopter's existing `http.Server`
(gateway-level deployment) or owns its own port (app-level
fallback).

**Status:** Phase 4e (WebSocket shipped).
`runClusterTransportConformance` passes 10/10 against WS. Subprotocol-
negotiated handshake (`agentick-cluster-v1`); native WebSocket
message boundaries (no length-prefix framing needed); origin policy.

**Design:** [ADR 35 — cluster protocol](../../docs/proposals/v2/blueprint/35-cluster-protocol.md) ·
[`@agentick/cluster-broker`](../cluster-broker/README.md)

## Quick start

### Mount on adopter's existing http.Server (gateway-level)

```typescript
import { createServer } from "node:http";
import { defineWsCluster, wsBroker } from "@agentick/cluster-ws";

const httpServer = createServer(/* your normal HTTP routes */);
httpServer.listen(8080);

// The broker process — runs ONCE per cluster, mounted on the
// gateway's existing HTTP server.
await wsBroker({ httpServer, path: "/cluster" });

// On every cluster member (including the broker process if it's
// also a node):
const cluster = defineWsCluster({
  // nodeId defaults to `${hostname}:${pid}` — set explicitly for tests
  url: "ws://broker-host:8080/cluster",
});
```

### Standalone (app-level)

```typescript
import { wsBroker, defineWsCluster } from "@agentick/cluster-ws";

// Broker owns its own port.
await wsBroker({ host: "127.0.0.1", port: 9876 });

const cluster = defineWsCluster({
  // nodeId defaults to `${hostname}:${pid}`
  url: "ws://127.0.0.1:9876/cluster",
});
```

### Side-channel cluster (`joinWsCluster`)

For cross-process coordination outside the agent loop. Returns a
`ClusterNode` with name-based `bus.subscribe` / `bus.broadcast` /
`membership.waitForPeers` plus `await using` lifecycle.

```typescript
import { joinWsCluster } from "@agentick/cluster-ws";

await using node = await joinWsCluster({
  url: "ws://127.0.0.1:9876/cluster",
  mode: "client", // or "broker" — broker spins up its own ws.Server
});

node.bus.subscribe("hello", (env) => console.log(env.scope.nodeId));
await node.membership.waitForPeers(2);
await node.bus.broadcast("hello");
```

See [ADR 38 — Cluster lifecycle + ownership](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md)
for the substrate-fusion vs side-channel split.

## API

| Export                         | Role                                                   |
| ------------------------------ | ------------------------------------------------------ |
| `defineWsCluster(opts)`        | Returns a `ClusterFactory` for createApp/createGateway |
| `joinWsCluster(opts)`          | Returns a `ClusterNode` for side-channel use           |
| `wsClusterNode(opts)`          | `{transport, membership}` over one connection          |
| `wsBroker(opts)`               | Spins up + starts a `BaseBroker` on a WS listener      |
| `wsTransport(opts)`            | Standalone transport factory                           |
| `wsMembership(opts)`           | Standalone membership factory                          |
| `createWsListener(opts)`       | Low-level — `WebSocketServer` as `Listener`            |
| `createWsConnector(opts)`      | Low-level — `WebSocket(url)` as `Connector`            |
| `wsToConnection(ws, opts)`     | Wrap a raw `ws.WebSocket` as `Connection`              |
| `AGENTICK_CLUSTER_SUBPROTOCOL` | The negotiated subprotocol name                        |

## How it differs from TCP/Unix

- **No length-prefix framing.** WebSocket preserves message
  boundaries natively. Each `ws.send(bytes)` ships one frame; each
  inbound `'message'` event is one frame. The `Connection` wrapper
  passes binary frames straight through.
- **HTTP upgrade handshake.** Adopters mount on an existing
  `http.Server` so cluster traffic shares a port with their HTTP
  API / static assets / other WebSocket endpoints. Path-prefix
  routing (`/cluster` by default) keeps cluster upgrades from
  conflicting with other handlers.
- **Subprotocol negotiation.** Clients send
  `Sec-WebSocket-Protocol: agentick-cluster-v1` on connect; the
  broker rejects mismatches. Forward-compatible — when the wire
  protocol evolves incompatibly, the suffix moves to `v2` and old
  clients get a clean rejection.
- **Origin policy.** `allowedOrigins: ["https://my-app.com"]`
  rejects browser-origin upgrades from disallowed hosts (HTTP 403).
  Default: no origin check (loopback/server-to-server is the
  expected deployment).

## Verified by

- `src/__tests__/conformance-against-ws.spec.ts` —
  `runClusterTransportConformance` passes 10/10 (send / broadcast
  / subscription lifecycle / close). Same suite that validates
  `LocalClusterTransport`, TCP, and Unix.
- `src/__tests__/verification.spec.ts` — 6 WS-specific tests:
  - Subprotocol rejection of mismatched clients (×1) + acceptance of
    canonical subprotocol (×1)
  - Mount-on-httpServer coexists with other route handlers (×1)
  - Upgrade requests on a different path pass through to other
    handlers (×1)
  - `allowedOrigins` rejects disallowed Origin headers (×1)
  - `connectTimeoutMs` fires on unreachable URL (×1)

## Diagnostics emitted (`surface: "cluster"`)

WS-layer specifics (alongside the
[`cluster-broker-next`](../cluster-broker) diagnostics):

- `cluster:broker:ws:listener-mounted` (mount mode start) /
  `listener-bound` (standalone) / `listener-closed`
- `cluster:broker:ws:origin-rejected` — Origin not in `allowedOrigins`
- `cluster:broker:ws:connect-timeout`
- `cluster:broker:ws:connect-failed`
- `cluster:broker:ws:connected`
- `cluster:broker:ws:subprotocol-mismatch` (client side)
- `cluster:broker:ws:socket-error`
- `cluster:broker:ws:text-frame-rejected` — non-binary frame received
- `cluster:broker:ws:unrecognized-payload` — binary frame in unknown shape
- `cluster:broker:ws:close-handler-threw`
- `cluster:broker:ws:message-handler-threw`
- `cluster:broker:ws:accept-handler-threw`

## Roadmap & known gaps

- **TLS / `wss://`** — supported by `ws` library natively. Adopters
  using `wsBroker({ httpServer })` where `httpServer` is HTTPS get
  `wss://` automatically; the cluster wire is encrypted by the
  underlying TLS context. Direct `wsBroker({ port, tls: { ... } })`
  shorthand is not yet wired — adopters wanting TLS use the mounted
  pattern with their own HTTPS server.
- **`Sec-WebSocket-Key` validation** — Phase 4f hardening if real
  adopter feedback surfaces a need for stricter rejection of
  malformed upgrade requests.
- **Compression** (`permessage-deflate`) — `ws` supports this natively
  but it's off by default. Worth enabling for verbose adopter
  payloads; tracked as a future tuning option.
- **Cross-package wire consolidation** — the listener/connector/cluster
  modules in this package + cluster-net follow nearly the same shape.
  After Phase 4e ships, a shared `cluster-wire-base-next` package
  could host the patterns. Tracked via TODO at the top of
  `ws-listener.ts`. Don't refactor pre-Otto-demo (Phase 4f) — real
  adopter signal first.

## Adopter platform notes

- **Browser clients**: `new WebSocket("ws://broker/cluster", "agentick-cluster-v1")`
  speaks the same protocol as Node clients. The browser's
  `WebSocket` constructor is the canonical client; bundle bytes
  via a binary-safe codec (msgpack/CBOR), and broker traffic
  flows through any HTTP-aware proxy/ingress that normally
  forwards WS upgrades.
- **Cross-origin browser clients** need `allowedOrigins` on the
  broker to include their origin.
