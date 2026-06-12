# @agentick/transport-base-next

Shared plumbing every `@agentick/transport-*-next` package depends on.

`BaseClientTransport` (abstract) owns the bulk of transport behavior;
concrete transports (in-process, WebSocket, HTTP, Unix-socket) subclass
and supply wire-specific connection management. The shared
`dispatchRequest` translates JSON-RPC frames into
`GatewayHarnessProtocol` method calls — same dispatcher reused across
every transport.

## What this package is

The result of a Phase 33.C.1 extraction. After WS + in-process landed
as separate packages, the shared plumbing (RPC correlation, stream
registries, state machine, notification routing, JSON-RPC dispatch)
turned into ~400 LOC of duplication. This package consolidates it into
one place; concrete transports become wire-specific and small.

## Architecture

```
                ┌────────────────────────────────┐
                │      ClientTransport interface │
                │      (in @agentick/spec-next)  │
                └─────────────┬──────────────────┘
                              │ implements
                              ▼
                ┌────────────────────────────────┐
                │      BaseClientTransport       │
                │      (abstract, this package)  │
                │                                │
                │  - state machine               │
                │  - RPC correlation             │
                │  - subscription/progress       │
                │    stream registries           │
                │  - notification routing        │
                │  - cursor-aware resubscribe    │
                │  - AbortSignal → cancelled     │
                └─────────────┬──────────────────┘
                              │ subclass + fill in
                              ▼
                ┌────────────────────────────────┐
                │  Concrete transports           │
                │  - InProcessTransport          │
                │  - WebSocketTransport          │
                │  - HttpTransport (Phase 33.D)  │
                │  - UnixSocketTransport (33.E)  │
                │                                │
                │  Override:                     │
                │    openConnection / close      │
                │    sendFrame                   │
                │  Receive inbound via:          │
                │    this.routeFrame(frame)      │
                └────────────────────────────────┘
```

## Quick start (writing a new transport)

```ts
import {
  BaseClientTransport,
  type ClientTransport,
  type JsonRpcFrame,
  type TransportCapabilities,
} from "@agentick/transport-base-next";

const CAPABILITIES: TransportCapabilities = {
  bidirectional: true,
  streamingRequest: true,
  reconnectable: false,
  binaryFrames: false,
};

class MyTransport extends BaseClientTransport {
  readonly id = "my-transport";
  readonly capabilities = CAPABILITIES;

  protected async openConnection(): Promise<void> {
    this.setState("connecting");
    // ... open the wire
    this.setState("open");
  }

  protected async closeConnection(): Promise<void> {
    // ... tear down
  }

  protected sendFrame(frame: JsonRpcFrame): void {
    // ... write frame to the wire (e.g., socket.send(JSON.stringify(frame)))
  }

  // When bytes arrive from the wire and decode to a frame, call
  // this.routeFrame(frame). The base class dispatches responses to
  // pending RPCs and notifications to subscription / progress streams.
}

export function myTransport(opts: { ... }): ClientTransport {
  return new MyTransport(opts);
}
```

## API surface

### Client

- `BaseClientTransport` — abstract base class
- `MultiplexedStream<T>` — AsyncIterable used by subscription + progress streams
- `ActiveSubscription` — bookkeeping shape for cursor-aware resubscribe

### Server

- `dispatchRequest(host, req, sink)` — transport-agnostic JSON-RPC →
  `GatewayHarnessProtocol` dispatcher. WS, HTTP, Unix-socket adapters
  all call this; per-connection state (auth, subscriptions, in-flight
  ids) lives on the adapter, not in the dispatcher.
- `DispatchHost = GatewayHarnessProtocol` — type alias
- `DispatchSink` — contract every connection adapter implements:
  - `sendNotification(notification)` — emit a notification frame to the client
  - `registerSubscription(subId, unsubscribe)` / `unregisterSubscription(subId)`
  - `registerInFlight(id, abort)` / `unregisterInFlight(id)` for `notifications/cancelled` routing

## Patterns

### Cursor-aware resubscribe

After a reconnect, transports that support it (WS, HTTP-with-SSE) call
`this.resubscribeAfterReconnect()`. The base class iterates
`this.activeSubscriptions` and re-issues `subscribe` RPCs with each
subscription's last-seen cursor. Server-side bus retention decides
whether the cursor is still in window; out-of-retention cursors fail
loudly via `notifications/subscription/evicted` and surface on the
stream's failure channel.

### Subscription id re-key

When `transport.subscribe(scope, query, fromCursor)` is called, the
base class:

1. Generates a tentative client-side id (`tentative-sub-<n>`)
2. Creates a `MultiplexedStream` keyed by that tentative id
3. Issues a `subscribe` RPC
4. On response, re-keys the stream to the server-allocated
   `subscriptionId`

Subsequent `notifications/subscription/event` frames route by the
server id. Adopters who close the stream early get the unsubscribe RPC
sent under the real id.

## Verified by

| Concern | Test file |
|---|---|
| End-to-end via in-process transport | `../transport-in-process/src/__tests__/transport-conformance.spec.ts` |
| End-to-end via WebSocket transport | `../transport-websocket/src/__tests__/transport-conformance.spec.ts` |
| State machine, RPC correlation, multiplex, cancellation, subscription routing, progress streams | `../spec-conformance/src/transport.ts` (`runTransportConformance` — invoked by every transport) |

`runTransportConformance(name, factory)` in
`@agentick/spec-conformance-next` ships the shared behavioral suite.
Per-transport tests cover wire-specific concerns (subprotocol
negotiation for WS, peer credentials for Unix socket, etc.).

## Status

Phase 33.C.1 of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md`.

## Roadmap & known gaps

- **Backpressure on `MultiplexedStream`** — unbounded buffer today.
  ADR 33 rev-3 specified bounded queue + `drop-oldest` /
  `close-subscription` / `unbounded` policy; lands in the 33.C
  hardening pass alongside transport-wide backpressure design.
- **Cursor-aware resubscribe under retention pressure** —
  resubscribe wire path works (verified by reconnect tests); the
  cursor-evicted-on-resubscribe path is wired in the base class but
  not exercised under retention pressure. Needs a test fixture with
  tight `LocalEventBus` retention.
- **Server-side `notifications/cancelled` plumbing** — `DispatchSink`
  ships `registerInFlight` / `unregisterInFlight`. The transport-
  websocket server adapter wires it; in-process server adapter pattern
  doesn't have a single adapter (handlers are user-provided), so
  cancellation propagation depends on adopter handler design.
- **JSON-RPC batch requests** — wire format supports them; dispatcher
  handles single frames today. Batch dispatch is mechanical follow-up.

## Development plan

| Step | Lands when |
|---|---|
| Phase 33.C.1 — extraction | This commit |
| Backpressure on MultiplexedStream | 33.C hardening pass |
| Phase 33.D — HTTP transport | Subclasses `BaseClientTransport`; reuses `dispatchRequest` |
| Phase 33.E — Unix-socket transport | Same |
| Batch request dispatch | When a real workload surfaces the need |
