# @agentick/transport-in-process

Direct-call `ClientTransport` for same-process client ↔ gateway
communication. The reference transport for tests, embedded library
deploys, and same-process TUI / daemon shapes (tentickle-class agents).

## What this package is

A `ClientTransport` impl that bypasses serialization entirely — frame
payloads pass by reference. Connects a `@agentick/client` client
directly to a `GatewayHarness` instance running in the same Node
process / browser tab / worker.

**Cost: zero μs per frame.** No JSON encode/decode, no socket, no
network. The client's typed surface still flows through the canonical
wire shape (JSON-RPC 2.0 envelopes from `@agentick/spec/wire`) so
adopters can swap to a real transport without changing application
code.

## Quick start

Point it at a gateway — that's the whole thing. The transport builds the
per-request `DispatchSink` + `dispatchRequest` wiring internally; you never
touch the server plumbing.

```ts
import { createClient } from "@agentick/client";
import { inProcessTransport } from "@agentick/transport-in-process";

const client = await createClient({ transport: inProcessTransport({ gateway }) });
await client.connect();
await client.request("ping", {});
```

### Escape hatch — a raw handler

For a stub server, request interception, or a non-gateway host, pass a
`handler` instead of `gateway` (exactly one, not both):

```ts
import { inProcessTransport, withHandshake } from "@agentick/transport-in-process";
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec";

const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
  if (req.method === "ping") return { jsonrpc: "2.0", id: req.id, result: {} };
  return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } };
};

// `client.connect()` auto-issues `initialize` + `_extensions/list`; a stub that
// answers neither still connects but sees no serverInfo/capabilities.
// `withHandshake` answers both with canned results. (A real `gateway` answers
// these bootstrap methods itself — no wrapper needed.)
const client = await createClient({
  transport: inProcessTransport({ handler: withHandshake(handler) }),
});
```

`withHandshake(inner, overrides?)` answers `initialize` and
`_extensions/list` from `buildHandshakeInitializeResult()` /
`buildHandshakeExtensionsListResult()` (override either via the second
argument), then falls through to `inner` for everything else.
`withHandshake` is for **stub** handlers; a real gateway wired through
`dispatchRequest(gateway, req, sink)` from `@agentick/transport`
answers `initialize` / `ping` / `_extensions/list` itself as bootstrap
builtins.

## API surface

### `inProcessTransport(options): ClientTransport`

```ts
interface InProcessTransportOptions {
  handler: InProcessGatewayHandler;
  wireParity?: boolean;
  id?: string;
}

type InProcessGatewayHandler = (
  request: JsonRpcRequest,
  sendNotification: (n: { method: string; params?: unknown }) => void,
) => Promise<JsonRpcResponse>;
```

- `handler` — server-side function called for every RPC. Receives a
  per-request `sendNotification` it can call to push out-of-band frames
  (progress, subscription events, and control-plane notifications) to
  the client on the same connection.
- `wireParity` — when `true`, frame payloads roundtrip through
  `JSON.parse(JSON.stringify(...))`. Catches wire-shape regressions at
  test time without paying the cost in production. Off by default.
- `id` — optional transport id; defaults to a `in-process-N` counter.

There is no separate server-push slot. Server→client notifications
travel through the `sendNotification` callback the handler already
receives — the same channel `dispatchRequest`'s `DispatchSink` uses to
fan subscription events back to the subscriber.

### `inProcessServerTransport(): ServerTransport`

The server-side symmetry of the ADR 84 transport family. In-process is a
DIRECT-CALL transport: the client reaches the gateway through the
`handler` closure above, not through a bound socket. There is nothing to
open, so `listen()` and `close()` are honest no-ops. It exists so an
in-process deployment can list its transport alongside the network
transports and `gateway.listen()` fan-out stays uniform:

```ts
import { createGateway } from "@agentick/gateway";
import { inProcessServerTransport } from "@agentick/transport-in-process";
import { webSocketServerTransport } from "@agentick/transport-websocket/server";

// A gateway reachable both in-process AND over the network:
const gateway = await createGateway({
  transports: [inProcessServerTransport(), webSocketServerTransport({ port: 8080 })],
});
await gateway.listen(); // binds :8080; in-process transport is a no-op
```

Its `id` is the stable string `"in-process"`.

### Server-initiated notifications — the control-plane bus (ADR 47)

Control-plane signals (`gateway:capabilities:changed`) ride the
substrate bus, not a bespoke push slot. Wire a real gateway through
`dispatchRequest` so `sub/subscribe` establishes a live bus
subscription, then emit on the gateway:

```ts
import { dispatchRequest, type DispatchSink } from "@agentick/transport";

const gateway = await createGateway();

const handler: InProcessGatewayHandler = (req, sendNotification) => {
  // sendNotification MUST be the sink's notifier so subscription-event
  // frames reach the subscriber over this connection.
  const sink: DispatchSink = {
    sendNotification,
    registerSubscription: () => {},
    unregisterSubscription: () => {},
    registerInFlight: () => {},
    unregisterInFlight: () => {},
  };
  return dispatchRequest(gateway, req, sink);
};

const client = await createClient({
  transport: inProcessTransport({ handler: withHandshake(handler) }),
});
await client.connect();

// From anywhere on the server side, after the client has opened a
// gateway-scope subscription:
gateway.emitCapabilitiesChanged();
```

The `gateway:capabilities:changed` event drains through the gateway's
`sub/subscribe` fan-out and arrives as a `notifications/subscription/event`
frame. **The client does NOT auto-react to it today** — runtime
capability re-sync is deferred to #308; a subscriber consumes the frame
manually. This is exactly what
`src/__tests__/capabilities-changed-e2e.spec.ts` drives.

## Patterns

### Test fixture

Use this transport in unit tests instead of standing up a real WS
server:

```ts
const lastSeen: { method?: string; params?: unknown } = {};
const transport = inProcessTransport({
  handler: async (req) => {
    lastSeen.method = req.method;
    lastSeen.params = req.params;
    return { jsonrpc: "2.0", id: req.id, result: {} };
  },
});

const client = await createClient({ transport });
await client.connect();
await client.session("s1").abort("test");

expect(lastSeen.method).toBe("session/abort");
```

### Embedded library / single-process gateway

When `@agentick/client` and `@agentick/gateway` live in the
same process (CLI tools, daemons, the TUI talking to its own embedded
gateway), wrap the gateway in an in-process handler and use this
transport. The client surface is identical to the remote case;
adopters can move the gateway behind a wire without touching call
sites.

### Wire-parity test mode

```ts
const transport = inProcessTransport({
  handler: myHandler,
  wireParity: true,
});
```

Every frame payload survives `JSON.parse(JSON.stringify(...))`. Catches
adopter mistakes like `Map`/`Set`/`Date`/`RegExp` in payloads that
would break the moment the code moves to a real wire. `structuredClone`
is **not** used — it preserves things JSON wouldn't, giving false
confidence.

## Verified by

| Concern                                                                                       | Test file                                   |
| --------------------------------------------------------------------------------------------- | ------------------------------------------- |
| End-to-end `createClient` + `inProcessTransport` + handler stub                               | `src/__tests__/smoke.spec.ts`               |
| `ping` roundtrip                                                                              | `src/__tests__/smoke.spec.ts`               |
| `gateway.listApps`, `app.listSessions` returning `SessionEntry[]`                             | `src/__tests__/smoke.spec.ts`               |
| `session.abort` parameter plumbing                                                            | `src/__tests__/smoke.spec.ts`               |
| RPC error propagation as `TransportError { kind: "rpc" }`                                     | `src/__tests__/smoke.spec.ts`               |
| `wireParity: true` JSON roundtrip mode                                                        | `src/__tests__/smoke.spec.ts`               |
| Pre-connect request rejection                                                                 | `src/__tests__/smoke.spec.ts`               |
| Extension `request` middleware observation order                                              | `src/__tests__/smoke.spec.ts`               |
| Extension `install()` namespace registration                                                  | `src/__tests__/smoke.spec.ts`               |
| `onClose` handler LIFO order                                                                  | `src/__tests__/smoke.spec.ts`               |
| Wire conformance (envelope roundtrips, validator integration, batches, empty batch rejection) | `src/__tests__/wire-conformance.spec.ts`    |
| Full `session/send` client → gateway → executor roundtrip                                     | `src/__tests__/session-send-e2e.spec.ts`    |
| `ctx.progress` during an in-flight send reaches `client.transport.progress(token)` (ADR 64)   | `src/__tests__/progress-signal-e2e.spec.ts` |
| `inProcessServerTransport` — `ServerTransport` conformance + no-op `listen`/`close` inside a gateway; stable `"in-process"` id | `src/__tests__/server-transport.spec.ts` (`runServerTransportConformance`) |

## Status

Phase 33.B of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md`.

## Roadmap & known gaps

- **Adopters hand-write a handler closure or delegate to
  `dispatchRequest`.** The canonical adapter that translates
  JSON-RPC ↔ `GatewayHarnessProtocol` calls is `dispatchRequest` in
  `@agentick/transport` (`src/server/dispatch.ts`). It's
  transport-agnostic — every transport (in-process, WebSocket, Unix
  socket) routes frames through it — so an in-process handler can be as
  thin as `(req, send) => dispatchRequest(gateway, req, sink)`.
- **No cancellation propagation.** When the client aborts, the
  in-process handler doesn't receive a cancellation signal. The WS
  transport's `notifications/cancelled` machinery doesn't have an
  in-process analogue yet.

## Development plan

Stable as-is. Future changes follow the shared adapter extraction
(Phase 33.D) — at that point this package becomes a thin shim around
the canonical dispatcher, dropping handler hand-rolling for adopters.
