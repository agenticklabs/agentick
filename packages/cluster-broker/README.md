# @agentick/cluster-broker

Broker-pattern base for cluster wires that run their own broker process. If
you're writing a wire adapter, this is the package that saves you from
reimplementing handshake, heartbeat, reconnect, subscription restore, routing,
and backpressure.

It ships two concrete classes — `BaseBroker` (server side) and
`BaseClusterClient` (client side, which _is_ a `ClusterTransport`) — plus the
frame schema they speak, a wire-agnostic `Connection` / `Listener` /
`Connector` triple, and a length-prefix framing helper for byte-stream wires.
Your job as a wire author is to supply a `Listener` and a `Connector`.

Two wires are built on it:
[@agentick/cluster-net](../cluster-net) (TCP and Unix socket) and
[@agentick/cluster-ws](../cluster-ws) (WebSocket).
[@agentick/cluster-redis](../cluster-redis) is a **peer**, not a child — Redis
is already the broker, so none of this plumbing applies.

## Install

```bash
npm install @agentick/cluster-broker
```

## Quick start

Standing up a broker and two clients over any wire is three constructions. The
in-memory fixture from `/testing` stands in for a real wire here, so this runs
with no sockets:

```typescript
import { BaseBroker, BaseClusterClient } from "@agentick/cluster-broker";
import { createInMemoryClusterPair } from "@agentick/cluster-broker/testing";
import { createJsonCodec } from "@agentick/cluster";

const codec = createJsonCodec();
const pair = createInMemoryClusterPair();

const broker = new BaseBroker({ listener: pair.listener, codec });
await broker.start();

const a = new BaseClusterClient({ nodeId: "node-a", connector: pair.createConnector(), codec });
const b = new BaseClusterClient({ nodeId: "node-b", connector: pair.createConnector(), codec });
await Promise.all([a.ready, b.ready]);

// BaseClusterClient implements ClusterTransport, so this is the real seam.
const unsub = b.subscribeInbox({ surface: "tasks" }, (env) => console.log(env.type));
await b.flush(); // let the SUBSCRIBE land before racing a send at it
await a.send("node-b", envelope);

await unsub();
await a.close();
await b.close();
await broker.close();
```

Swap `pair` for a real `Listener` / `Connector` and nothing above changes.

## Writing a wire

Three interfaces stand between the base classes and your wire. `Connection` is
deliberately **message-oriented**, not byte-stream-oriented: each `send`
carries one logical message and `onMessage` fires once per message. Delimiting
is your problem, which is why the base classes work uniformly over a TCP stream
and a WebSocket without branching.

```typescript
interface Connection {
  readonly id: string;
  readonly remote?: string; // peer descriptor, diagnostics only
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

`ConnectionCloseReason` is `"remote-graceful" | "remote-abort" | "local-close" | "transport-error"`.

> [!IMPORTANT]
> `onMessage` accepts **exactly one** handler at a time. Registering a second
> before the first detaches throws. The base classes attach exactly one each
> (`BaseBroker` one per accepted connection, `BaseClusterClient` one per
> connection), and silent fan-out was never wanted.
>
> `onClose` is the opposite — multiple handlers are fine, each fires once, and
> a registration made _after_ close fires immediately with the recorded reason.

### Length-prefix framing (byte-stream wires only)

TCP and Unix sockets deliver bytes, not messages. Wrap each codec payload with
a 4-byte little-endian length prefix and feed inbound chunks to a streaming
decoder. WebSocket wires skip this entirely.

```typescript
import { encodeLengthPrefixed, createLengthPrefixedDecoder } from "@agentick/cluster-broker";

const wire = encodeLengthPrefixed(codec.encode(frame));

const decoder = createLengthPrefixedDecoder({ maxFrameBytes: 16 * 1024 * 1024 });
const { frames, error } = decoder.feed(inboundChunk);
if (error?._tag === "frame-too-large") {
  // The decoder is poisoned past this point — close the connection.
}
for (const frameBytes of frames) {
  const frame = codec.decode(frameBytes);
}
```

`feed` accepts arbitrary chunk boundaries: a frame split across a hundred
single-byte chunks reassembles without a merge-and-copy per chunk, and a chunk
containing several frames yields all of them. `DEFAULT_MAX_FRAME_BYTES` is the
cap when you don't pass one.

### Shortcuts every wire wants

Rather than hand-rolling the `xBroker` / `xClusterNode` / `defineXCluster`
triple, compose the three helpers. This is exactly how the shipped wires are
built.

```typescript
import { startBroker, createClusterNode, defineWireCluster } from "@agentick/cluster-broker";

// 1. Broker: wrap a Listener, start serving, get an ordered close().
const running = await startBroker({ listener: myListener, onDiagnostic });
// running.broker · running.listener · running.close()

// 2. Node: one transport + one membership over ONE shared client connection.
const node = createClusterNode({ nodeId: "node-a", connector: myConnector, onDiagnostic });

// 3. Cluster factory for createGateway / createApp.
const cluster = defineWireCluster({ nodeId: "node-a", node });
```

`createClusterNode` is the reason a wire's `xClusterNode` is worth having as a
unit: both seams share a single lazily-created `BaseClusterClient`, so a node
costs one connection rather than two. The client is constructed on first
factory invocation and closed via `parent.onClose`.

## Wire protocol

Every frame is serialized by the configured `ClusterCodec` (JSON by default).
All frame `type` values live in the reserved `cluster:` namespace, so they can
never collide with adopter envelope types.

| Direction       | Frame                           | Purpose                                          |
| --------------- | ------------------------------- | ------------------------------------------------ |
| Client → Broker | `cluster:hello`                 | Identify this node on connect                    |
| Client → Broker | `cluster:send`                  | Point-to-point message to a named node           |
| Client → Broker | `cluster:broadcast`             | Fan an event out to every other node             |
| Client → Broker | `cluster:subscribe-inbox`       | Register an address-filter subscription          |
| Client → Broker | `cluster:subscribe-bus`         | Register an event-filter subscription            |
| Client → Broker | `cluster:unsubscribe`           | Cancel a subscription                            |
| Broker → Client | `cluster:welcome`               | Handshake ack + initial membership snapshot      |
| Broker → Client | `cluster:subscribe-ack`         | Subscription is recorded (what `flush()` awaits) |
| Broker → Client | `cluster:inbox-deliver`         | Deliver a routed message                         |
| Broker → Client | `cluster:bus-deliver`           | Deliver a fanned-out event                       |
| Broker → Client | `cluster:membership`            | Topology delta (joined / lost / snapshot)        |
| Bidirectional   | `cluster:ping` / `cluster:pong` | Heartbeat                                        |
| Bidirectional   | `cluster:error`                 | Non-fatal error report                           |
| Bidirectional   | `cluster:goodbye`               | Cooperative disconnect                           |

`isFrameShape(value)` is the wire-boundary validator — it accepts every known
frame type and rejects anything else, so a well-formed-JSON-but-unknown payload
becomes a diagnostic rather than an exception deep in a handler.

## `BaseBroker`

```typescript
const broker = new BaseBroker({
  listener, // required
  codec, // required
  onDiagnostic: (name, payload) => bus.append({ surface: "cluster", name /* ... */ }),
  maxQueueSize: 1024, // per-connection outbound depth
});
await broker.start();
await broker.close();
```

The broker holds routing state (nodeId → connection, plus each client's inbox
and bus filters), rejects a second client claiming an already-connected
`nodeId`, and fans membership deltas to everyone on connect and disconnect.

Every broker → client frame goes through a per-connection `BoundedWriteQueue`.
On overflow the **oldest** frame is dropped and
`cluster:broker:server:backpressure-drop` fires, so one slow client can neither
stall fan-out to the others nor grow the broker heap without bound. Surviving
frames keep their relative order.

## `BaseClusterClient`

```typescript
const client = new BaseClusterClient({
  nodeId: "node-a", // required
  connector, // required
  codec, // required
  heartbeatMs: 30_000, // ping interval
  missedPongLimit: 3, // consecutive misses before declaring the connection dead
  reconnect: { initialMs: 500, maxMs: 30_000, maxAttempts: 0 }, // 0 / omitted = unlimited
  onDiagnostic,
});

await client.ready; // resolves on the first Welcome
client.connectionState; // "disconnected" | "connecting" | "handshaking" | "connected" | "closed"
client.nodes(); // membership snapshot, synchronous
client.onMembershipChange((change) => {});
```

It satisfies `ClusterTransport` in full — `send`, `broadcast`,
`subscribeInbox`, `subscribeBus`, `flush`, `close` — so it drops straight into
`defineCluster` from [@agentick/cluster](../cluster).

Reconnect is exponential backoff with full jitter (random 0..delay), and
subscriptions are **restored** after reconnect: the client re-sends its
subscribe frames so a broker restart doesn't silently deafen a node.
`flush()` awaits outstanding subscribe acks and snapshots the pending set —
subscriptions added _during_ a flush don't extend the wait, and a flush racing
a close resolves rather than hanging.

## Codecs

The broker frames and the adopter's `ClusterCodec` speak different type
languages: the codec is declared over `MessageEnvelope | EventEnvelope`, and
frames are their own schema. `adaptClusterCodec` centralizes that cast so it
lives in one place instead of at every call site. Advanced codec authors can
implement `BrokerCodec` directly and skip the adapter.

## API reference

| Export                                                                               | Role                                       |
| ------------------------------------------------------------------------------------ | ------------------------------------------ |
| `BaseBroker`, `BaseBrokerOptions`                                                    | Server side                                |
| `BaseClusterClient`, `BaseClusterClientOptions`                                      | Client side; implements `ClusterTransport` |
| `Connection`, `ConnectionCloseReason`, `Listener`, `Connector`                       | The three interfaces a wire implements     |
| `encodeLengthPrefixed`, `createLengthPrefixedDecoder`                                | Byte-stream framing                        |
| `DEFAULT_MAX_FRAME_BYTES`                                                            | Default frame cap                          |
| `LengthPrefixedDecoder`, `LengthPrefixedDecoderOptions`, `LengthPrefixedDecodeError` | Framing types                              |
| `FRAME_*` constants, `isFrameShape`                                                  | Frame schema + wire-boundary validation    |
| `AnyFrame`, `ClientFrame`, `BrokerFrame`, per-frame types                            | Frame typing                               |
| `startBroker`, `RunningBroker`, `StartBrokerOptions`                                 | Broker bring-up shortcut                   |
| `createClusterNode`, `ClusterNodeFactories`, `CreateClusterNodeOptions`              | Multiplexed transport + membership pair    |
| `defineWireCluster`, `DefineWireClusterOptions`                                      | `ClusterFactory` shortcut                  |
| `adaptClusterCodec`, `BrokerCodec`                                                   | Codec adapter for frame types              |
| `BoundedWriteQueue`, `BoundedWriteQueueOptions`                                      | Per-connection backpressure queue          |

### `/testing`

| Export                           | Role                                                         |
| -------------------------------- | ------------------------------------------------------------ |
| `createInMemoryConnectionPair()` | Bidirectional `Connection` pair for low-level tests          |
| `createInMemoryClusterPair()`    | `Listener` + connector factory for full-stack tests, no wire |

## Diagnostics

All diagnostics arrive on the optional `onDiagnostic` callback. Wire packages
bridge it onto the parent's local bus with `surface: "cluster"`, so adopters
see the whole operational picture through one subscription. Omit the callback
and diagnostics are discarded.

**Broker side** — `cluster:broker:server:` +
`started` · `closing` · `closed` · `client-connected` · `client-welcomed` ·
`client-disconnected` · `pre-handshake-disconnected` · `routing-failed`
(unknown target node) · `routing-inconsistent` (defensive; should not occur) ·
`no-matching-subscription` · `frame-malformed` · `frame-decode-failed` ·
`unexpected-frame` · `client-error` · `dispatch-failed` · `write-failed` ·
`membership-fanout-failed` · `backpressure-drop`.

**Client side** — `cluster:broker:client:` +
`connecting` · `connected` · `disconnected` · `closed` · `connect-failed` ·
`handshake-failed` · `reconnect-scheduled` · `reconnect-gave-up` ·
`heartbeat-missed` · `write-while-disconnected` · `frame-decode-failed` ·
`frame-malformed` · `unexpected-frame` · `broker-error` · `handler-threw` ·
`membership-handler-threw`.

## Verified by

- `src/__tests__/base-broker-and-client.spec.ts` — handshake and
  duplicate-`nodeId` rejection; Welcome carries the initial snapshot and a
  disconnect propagates a `lost` delta; `send` reaches a matching inbox
  subscriber while filters narrow delivery and an unknown node produces a
  routing-failed diagnostic; broadcast fans out without self-echo; `flush()`
  resolves for subscribes issued before the handshake completed; unsubscribe
  stops callbacks; `isFrameShape` accepts every defined frame and rejects
  garbage; length-prefix framing handles a single frame, a split frame, a
  multi-frame chunk, and poisons on an oversized declared length.
- `src/__tests__/diagnostics-and-lifecycle.spec.ts` — single-handler
  `onMessage` enforcement; `ready` and `connectionState` transitions; the
  reconnect diagnostic sequence through `reconnect-gave-up`; heartbeat
  force-close after `missedPongLimit`; pre-handshake disconnect; malformed and
  undecodable frames on both sides; subscription restore after reconnect;
  100-single-byte-chunk and interleaved-frame decoding; broker lifecycle
  diagnostics.
- `src/__tests__/backpressure.spec.ts` — `BoundedWriteQueue` drops the oldest
  frame on overflow and invokes `onOverflow`, stops draining after close, and
  preserves order among survivors.

Real-wire conformance (`runClusterTransportConformance` from
[@agentick/cluster](../cluster)) is run by each wire package against its own
transport, not here — this package has no wire.

## Roadmap & known gaps

- **`FRAME_SUBSCRIBE_ACK` and `SubscribeAckFrame` are not exported from the
  barrel** even though `SubscribeAckFrame` is a member of the exported
  `BrokerFrame` union. Code switching exhaustively over `BrokerFrame` can see
  the member but cannot name its constant.
- **`Connection.id` allocation is per-wire.** Each wire picks its own scheme,
  so two listeners in one process could in principle mint colliding ids. A
  single convention across wires is not settled.
- **Adopter-facing backpressure knobs stop at `maxQueueSize`.** Per-frame
  priorities, drop-newest, and a caller-visible pressure signal are not built;
  `BoundedWriteQueue` is exported so a wire can extend the semantics itself.
- **Broker election is not part of the base.** First-to-bind races, stale
  socket cleanup, and re-election live in the wire packages, because the race
  is wire-specific — a TCP port bind and a Unix socket file behave differently.
- **UDP is deliberately unsupported.** `ClusterTransport` requires
  per-(source, destination) FIFO for `send` and per-source FIFO for
  `broadcast`; UDP violates both, and a reliable-UDP layer would reinvent TCP.
  UDP multicast for membership discovery is a gossip topology, which would be a
  separate package rather than a broker-pattern wire.
