# @agentick/transport-websocket-next

WebSocket transport for agentick. JSON-RPC 2.0 over WS with
`agentick-rpc-v1` subprotocol negotiation, cursor-aware reconnect,
and MCP-compatible wire conventions.

Ships **both ends**: the client transport (browser, Node 22+, Bun,
Deno, edge) and the server adapter (Node, via the `ws` library).

## What this package is

The first network transport in agentick's `ClientTransport` family. A
single WebSocket connection carries N concurrent JSON-RPC requests
(correlated by `id`) plus N persistent subscriptions and execution
progress streams (correlated by `subscriptionId` / `progressToken`).
The same multiplexing pattern Phoenix Channels and Slack's gateway
use — no Socket.IO. (See `docs/proposals/v2/blueprint/33-client-and-transports.md`
for why JSON-RPC 2.0 + plain WS is the right call over Socket.IO.)

## Quick start

### Client

```ts
import { createClient } from "@agentick/client-next";
import { websocket } from "@agentick/transport-websocket-next/client";

const client = await createClient({
  transport: websocket({ url: "wss://api.example.com" }),
});

await client.connect();
const result = await client.request("ping", {});
```

### Server

```ts
import { createServer } from "node:http";
import { createGateway } from "@agentick/gateway-next";
import { websocketServer } from "@agentick/transport-websocket-next/server";

const gateway = await createGateway();
const httpServer = createServer();
const server = websocketServer({
  httpServer,
  gateway,
  allowedOrigins: ["https://my-app.example.com"],
});

httpServer.listen(8080);
```

Browser clients send `Sec-WebSocket-Protocol: agentick-rpc-v1`; the
server rejects connections that don't.

## API surface

### `websocket(options): ClientTransport`

```ts
interface WebSocketTransportOptions {
  url: string;
  /** Defaults to `globalThis.WebSocket`. Pass `(await import("ws")).WebSocket`
   *  for Node 18/20 or when you need custom headers in Node. */
  WebSocket?: WebSocketConstructor;
  /** Additional subprotocols offered at the upgrade. E.g. ["mcp"] for
   *  bilingual servers that also speak MCP. */
  extraSubprotocols?: readonly string[];
  /** Exponential backoff (100ms → 30s cap) with full jitter by default. */
  reconnect?: ReconnectPolicy;
  id?: string;
}

interface ReconnectPolicy {
  enabled?: boolean;
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxAttempts?: number;
}
```

### `websocketServer(options): WebSocketServerHandle`

```ts
interface WebSocketServerOptions {
  httpServer: http.Server;
  gateway: GatewayHarnessProtocol;
  path?: string;
  allowedOrigins?: readonly string[] | "*";
  /** WS-level ping/pong interval. Default 30_000 ms. */
  heartbeatIntervalMs?: number;
}
```

## Patterns

### Native `WebSocket` everywhere

The client transport uses `globalThis.WebSocket` by default. As of
**Node 22 LTS**, native `WebSocket` is stable on the global — same API
as browsers. Bun, Deno, and Cloudflare Workers have it too. **No
isomorphic shim needed.**

For Node 18/20, install `ws` and pass it explicitly:

```ts
import { WebSocket } from "ws";
import { websocket } from "@agentick/transport-websocket-next/client";

const transport = websocket({
  url: "ws://localhost:8080",
  WebSocket,
});
```

Same constructor override lets you pass `ws` in Node when you need
custom HTTP headers on the upgrade (the browser `WebSocket` API
doesn't expose headers).

### Reconnect with cursor-aware resubscribe

```ts
const transport = websocket({
  url: "wss://api.example.com",
  reconnect: {
    initialDelayMs: 100,
    maxDelayMs: 30_000,
    maxAttempts: Infinity,
  },
});
```

On connection drop:
1. Transport enters `state: "reconnecting"`
2. Exponential backoff with full jitter (per AWS Builder's Library
   "Timeouts, retries, and backoff with jitter")
3. New WS connection opens
4. Every still-open subscription replays from its last-seen cursor
5. Server's bus has retention; if the cursor is still in window, the
   subscription resumes. If evicted (`notifications/subscription/evicted`),
   the registered lifecycle handler decides policy
   (`resubscribe-from-oldest` / `resubscribe-from-latest` / `give-up`).

This is the load-bearing improvement over Socket.IO and v1: **the wire
drop doesn't drop events**.

### Bilingual MCP support

```ts
const transport = websocket({
  url: "wss://gateway.example.com",
  extraSubprotocols: ["mcp"],
});
```

A server that mounts both `@agentick/transport-websocket-next/server`
and the future `@agentick/mcp-surface-next` extension accepts either
protocol on the same endpoint. Client picks `agentick-rpc-v1` first;
falls back to `mcp` if the server only speaks that.

## Status

Phase 33.C of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md` and
`docs/proposals/v2/blueprint/33-client-and-transports.md`.

## Roadmap & known gaps

**High severity (will land in a 33.C hardening pass):**

- **No backpressure** on subscription / progress streams.
  `MultiplexedStream` is unbounded — a slow consumer with a fast
  emitter leaks memory. ADR 33 rev-3 specified bounded queue with
  `drop-oldest` / `close-subscription` / `unbounded` policy; not
  implemented. Hardening pass lands when the backpressure design is
  settled across all transports for consistency.
- **No real `session/send` end-to-end test.** The dispatcher handles
  `session/send` with progress notifications; no test runs against a
  real session with a real model adapter. The shape is verified by
  type and by the in-process smoke tests; the wire path is exercised
  but only with stub executors.

**Medium severity:**

- **No per-message-deflate compression** (RFC 7692). `ws` supports it;
  not enabled. Cheap bandwidth win for large payloads.
- **No session affinity echo.** `initialize` returns `connectionId`;
  client doesn't carry it on reconnect, so load balancers can't
  sticky-route. Works for single-node deploys, breaks for clustered.
- **No bilingual MCP integration test.** Client supports the
  subprotocol option; a real bilingual server is the `@agentick/mcp-surface-next`
  scope (Phase 33.I).
- **No `outboundBackpressure` check on `ws.send()`.** A misbehaving
  emitter could fill the WS buffer; we don't check `bufferedAmount`.
- **No tuned `maxPayload`.** `ws` default is 100 MB. Misbehaving client
  could DoS the server with huge frames.

**Architecture:**

- **No `GatewayExtension` wrapper for the server side.** Ships as a
  plain `websocketServer(opts)` factory; ADR 33 rev-3 specified the
  server side as shape-1 (`GatewayExtension` with substrate audit + per-
  connection state). Deferred until the shared dispatcher gets
  extracted (Phase 33.D cleanup).

**Done in this phase:**

- ✓ Subprotocol negotiation
- ✓ Frame multiplexing (N RPC + M subscriptions on one socket)
- ✓ Exponential backoff + full jitter reconnect with cursor-aware
  resubscribe
- ✓ WS-level ping/pong heartbeat (RFC 6455 §5.5.2/3)
- ✓ Origin validation
- ✓ `notifications/cancelled` from client + server-side handler abort
- ✓ Spec-validator integration at the wire boundary
- ✓ Wire conformance suite passes
- ✓ Real-WS smoke (8 tests) and reconnect (3 tests)

## Development plan

| Step | Lands when |
|---|---|
| Phase 33.C MVP | This commit — `a14670c8` |
| 33.C hardening pass | After Phase 33.D + 33.E so backpressure design covers all transports; adds bounded streams, real `session/send` test with a model adapter |
| Compression / max-payload tuning | When a real workload surfaces the need |
| `GatewayExtension` wrapper | When the shared `@agentick/gateway-rpc-adapter-next` lands (33.D extraction) |
| Session affinity | When ADR 29 Phase D cluster substrate lands |
| Bilingual MCP test | Phase 33.I (`@agentick/mcp-surface-next`) |
