# @agentick/transport-in-process-next

Direct-call `ClientTransport` for same-process client ↔ gateway
communication. The reference transport for tests, embedded library
deploys, and same-process TUI / daemon shapes (tentickle-class agents).

## What this package is

A `ClientTransport` impl that bypasses serialization entirely — frame
payloads pass by reference. Connects a `@agentick/client-next` client
directly to a `GatewayHarness` instance running in the same Node
process / browser tab / worker.

**Cost: zero μs per frame.** No JSON encode/decode, no socket, no
network. The client's typed surface still flows through the canonical
wire shape (JSON-RPC 2.0 envelopes from `@agentick/spec-next/wire`) so
adopters can swap to a real transport without changing application
code.

## Quick start

```ts
import { createClient } from "@agentick/client-next";
import { inProcessTransport } from "@agentick/transport-in-process-next";
import type { JsonRpcRequest, JsonRpcResponse } from "@agentick/spec-next";

// Your gateway-side request handler. In practice this is a thin adapter
// that translates JSON-RPC frames into GatewayHarness method calls —
// the same logic that lives in @agentick/transport-websocket-next/server.
const handler = async (req: JsonRpcRequest): Promise<JsonRpcResponse> => {
  switch (req.method) {
    case "ping":
      return { jsonrpc: "2.0", id: req.id, result: {} };
    // ... real methods
  }
  return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } };
};

const client = await createClient({
  transport: inProcessTransport({ handler }),
});

await client.connect();
await client.request("ping", {});
```

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

- `handler` — the server-side function called for every RPC. Receives
  a `sendNotification` callback for pushing progress / subscription
  events back to the client.
- `wireParity` — when `true`, frame payloads roundtrip through
  `JSON.parse(JSON.stringify(...))`. Catches wire-shape regressions at
  test time without paying the cost in production. Off by default.

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

When `@agentick/client-next` and `@agentick/gateway-next` live in the
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

## Status

Phase 33.B of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md`.

## Roadmap & known gaps

- **No `GatewayExtension` server-side wrapper.** Adopters currently
  hand-write a handler closure. The real adapter that translates
  JSON-RPC ↔ `GatewayHarnessProtocol` calls lives in
  `@agentick/transport-websocket-next/server/dispatch.ts` and is
  transport-agnostic — extracting it into a shared
  `@agentick/gateway-rpc-adapter-next` (or similar) is a Phase 33.D
  cleanup.
- **No cancellation propagation.** When the client aborts, the
  in-process handler doesn't receive a cancellation signal. The WS
  transport's `notifications/cancelled` machinery doesn't have an
  in-process analogue yet.

## Development plan

Stable as-is. Future changes follow the shared adapter extraction
(Phase 33.D) — at that point this package becomes a thin shim around
the canonical dispatcher, dropping handler hand-rolling for adopters.
