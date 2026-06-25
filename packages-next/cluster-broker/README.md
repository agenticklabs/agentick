# @agentick/cluster-broker-next

**Broker-pattern base** for cluster transport adapters that run their
own broker process. Ships abstract `BaseBroker` + `BaseClusterClient`,
a wire-agnostic `Connection` interface, a length-prefix framing
helper, and the broker ↔ client wire frame schema.

Concrete wire packages subclass these to plug in their listener /
connector:

- [`@agentick/cluster-net-next`](../cluster-net) (Phase 4b/4d) — TCP +
  Unix socket
- [`@agentick/cluster-ws-next`](../cluster-ws) (Phase 4e) — WebSocket

**External-broker adapters** (`@agentick/cluster-redis-next`,
`@agentick/cluster-nats-next`) are **peers** of this package, not
children — Redis IS the broker, so it doesn't reuse this plumbing.

**Status:** Phase 4a (foundation). The abstract base classes, wire
frame schema, length-prefix framing helper, and in-memory test fixture
are shipped. First concrete wire impl (`cluster-net-next`, TCP) lands
in Phase 4b.

**Design:** [ADR 35 — cluster protocol](../../docs/proposals/v2/blueprint/35-cluster-protocol.md) ·
[ADR 11 — cluster vision](../../docs/proposals/v2/blueprint/11-cluster.md)

## Architecture

```
        @agentick/cluster-next  ← protocol + defineCluster
                  │
        ClusterTransport seam
                  │
   ┌──────────────┴────────────────┬──────────────────┐
   ▼                               ▼                  ▼
@agentick/cluster-broker-next   @agentick/         @agentick/
   (THIS PACKAGE)                cluster-redis-     cluster-gossip-
   BaseBroker + Client            next (Phase 6)     next (future)
   Frame schema                   Talks RESP to      P2P; no broker
   Length-prefix framing          Redis pub/sub
                  │
        Listener / Connector abstractions
                  │
   ┌──────────────┼──────────────┐
   ▼              ▼              ▼
cluster-net    cluster-net   cluster-ws
  -next         -next          -next
 (TCP)        (Unix sock)    (WebSocket)
```

## Wire protocol

Every frame between broker and client is serialized via the configured
`ClusterCodec` (default JSON; swap for MessagePack / protobuf via a
`cluster-codec-*-next` package).

Byte-stream wires (TCP, Unix socket) wrap codec bytes with a 4-byte
little-endian length prefix per frame, recovering message boundaries
from the stream. Message-oriented wires (WebSocket) use native message
boundaries directly.

### Frame types

| Direction | Frame | Purpose |
|---|---|---|
| Client → Broker | `cluster:hello` | Identify node on connect |
| Client → Broker | `cluster:send` | Point-to-point message to a specific node |
| Client → Broker | `cluster:broadcast` | Fan out an event to all other nodes |
| Client → Broker | `cluster:subscribe-inbox` | Register an inbox-filter subscription |
| Client → Broker | `cluster:subscribe-bus` | Register a bus-filter subscription |
| Client → Broker | `cluster:unsubscribe` | Cancel a subscription |
| Broker → Client | `cluster:welcome` | Handshake-complete ack + initial membership snapshot |
| Broker → Client | `cluster:inbox-deliver` | Deliver a routed inbox message |
| Broker → Client | `cluster:bus-deliver` | Deliver a fan-out bus event |
| Broker → Client | `cluster:membership` | Topology delta (join / lost / snapshot) |
| Bidirectional | `cluster:ping` / `cluster:pong` | Custom heartbeat (default 30s; miss-3 = dead) |
| Bidirectional | `cluster:error` | Report a non-fatal error |
| Bidirectional | `cluster:goodbye` | Cooperative disconnect |

All frame `type` values use the reserved `cluster:` namespace.
Adopter content (envelope `type` fields) cannot collide.

## API

### Wire-agnostic abstractions

```typescript
interface Connection {
  readonly id: string;
  readonly remote?: string;
  send(message: Uint8Array): Promise<void>;
  onMessage(handler: (message: Uint8Array) => void): () => void;
  onClose(handler: (reason: ConnectionCloseReason) => void): () => void;
  close(): Promise<void>;
}

interface Listener {
  start(): Promise<void>;
  onConnection(handler: (conn: Connection) => void): () => void;
  readonly bound?: string;
  close(): Promise<void>;
}

interface Connector {
  connect(): Promise<Connection>;
  readonly target?: string;
}
```

### `BaseBroker`

```typescript
const broker = new BaseBroker({
  listener: myWireListener,
  codec: jsonCodec(),
  onDiagnostic: (name, payload) => bus.append({ surface: "cluster", name, ... }),
});
await broker.start();
// ...
await broker.close();
```

### `BaseClusterClient` — implements `ClusterTransport`

```typescript
const client = new BaseClusterClient({
  nodeId: "node-A",
  connector: myWireConnector,
  codec: jsonCodec(),
  heartbeatMs: 30_000,
  missedPongLimit: 3,
  reconnect: { initialMs: 500, maxMs: 30_000 },
  onDiagnostic: (name, payload) => bus.append({ surface: "cluster", name, ... }),
});

// ClusterTransport contract — drop-in for `cluster-next`'s defineCluster:
await client.send("node-B", envelope);
await client.broadcast(eventEnvelope);
const unsub = client.subscribeInbox({ surface: "tasks" }, onMessage);
await client.close();
```

### Length-prefix framing helper

```typescript
import { encodeLengthPrefixed, createLengthPrefixedDecoder } from "@agentick/cluster-broker-next";

// Encode: prepend 4-byte LE length to a codec-encoded payload.
const wire = encodeLengthPrefixed(codec.encode(frame));

// Decode (streaming): feed inbound bytes; receive complete frames.
const decoder = createLengthPrefixedDecoder({ maxFrameBytes: 16 * 1024 * 1024 });
const { frames, error } = decoder.feed(inboundChunk);
if (error?._tag === "frame-too-large") {
  // Close connection — decoder is poisoned past this point.
}
for (const frameBytes of frames) {
  const frame = codec.decode(frameBytes);
  // ...
}
```

## Testing

`@agentick/cluster-broker-next/testing` ships:

- `createInMemoryConnectionPair()` — bidirectional `Connection` pair
  for low-level base-class tests.
- `createInMemoryClusterPair()` — `Listener` + `Connector` factory
  pair for full-stack `BaseBroker` + `BaseClusterClient` tests
  without any real wire.

```typescript
const pair = createInMemoryClusterPair();
const broker = new BaseBroker({ listener: pair.listener, codec });
await broker.start();
const clientA = new BaseClusterClient({
  nodeId: "node-A",
  connector: pair.createConnector(),
  codec,
});
const clientB = new BaseClusterClient({
  nodeId: "node-B",
  connector: pair.createConnector(),
  codec,
});
// Both clients now connected to the same broker.
```

## Verified by

- `src/__tests__/base-broker-and-client.spec.ts` — 16 tests:
  - Handshake (client → broker → welcome; duplicate-nodeId rejection)
  - Membership (welcome snapshot; disconnect drops routing)
  - Send + inbox subscription (filter narrows delivery;
    unknown-node-id routing-failed diagnostic)
  - Broadcast (fan-out; no self-echo; filter narrows)
  - Subscription lifecycle (unsubscribe drops in-flight)
  - Wire frame validation (`isFrameShape` accepts known, rejects garbage)
  - Length-prefix framing (single frame; split-chunk reassembly;
    multi-frame chunk; poison-on-oversize)

Real-wire conformance (`@agentick/cluster-next/conformance`) is
exercised by each wire package (`cluster-net-next`, `cluster-ws-next`)
in subsequent phases.

## Diagnostics emitted

All via the optional `onDiagnostic` callback passed at construction.
Wire impls bridge this into `cluster-next`'s `DiagnosticEmitter` over
the parent harness's local bus, so adopters subscribing to
`surface: "cluster"` see the full operational picture.

### Broker-side

- `cluster:broker:server:started` / `closed`
- `cluster:broker:server:client-connected` / `client-welcomed` / `client-disconnected` / `pre-handshake-disconnected`
- `cluster:broker:server:routing-failed` (unknown target node)
- `cluster:broker:server:routing-inconsistent` (defensive — should not occur)
- `cluster:broker:server:no-matching-subscription`
- `cluster:broker:server:frame-malformed` / `frame-decode-failed`
- `cluster:broker:server:unexpected-frame`
- `cluster:broker:server:client-error`
- `cluster:broker:server:membership-fanout-failed`

### Client-side

- `cluster:broker:client:connecting` / `connected` / `disconnected` / `closed`
- `cluster:broker:client:connect-failed` / `handshake-failed`
- `cluster:broker:client:reconnect-scheduled` / `reconnect-gave-up`
- `cluster:broker:client:heartbeat-missed`
- `cluster:broker:client:write-while-disconnected`
- `cluster:broker:client:frame-decode-failed` / `frame-malformed`
- `cluster:broker:client:unexpected-frame`
- `cluster:broker:client:broker-error`
- `cluster:broker:client:handler-threw`

## Roadmap & known gaps

- **No concrete wire impl yet.** Phase 4b lands `cluster-net-next`
  (TCP + Unix socket); Phase 4e lands `cluster-ws-next` (WebSocket).
- **Adopter-supplied backpressure not yet configurable.** Phase 4
  bounds per-connection buffer in the wire impl, not the base.
- **Auto-elect first-to-bind** is per-wire-impl logic (cluster-net's
  TCP bind race, cluster-ws's http.Server detection). Not part of
  the base.
- **UDP intentionally NOT supported.** Per-(source, destination) FIFO
  and per-source broadcast ordering are part of the `ClusterTransport`
  contract; UDP violates both. A reliable-UDP layer would re-invent
  TCP. UDP multicast for membership discovery is a different
  topology (gossip) and would ship as `@agentick/cluster-gossip-next`
  with its own ADR — not as a broker-pattern impl.
- **Cluster transport conformance** (`@agentick/cluster-next/conformance`)
  is exercised once a wire impl is paired with the base. Phase 4b
  is the first end-to-end conformance pass.
