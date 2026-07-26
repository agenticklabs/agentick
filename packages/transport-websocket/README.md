# @agentick/transport-websocket

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
import { createClient } from "@agentick/client";
import { websocket } from "@agentick/transport-websocket/client";

const client = await createClient({
  transport: websocket({ url: "wss://api.example.com" }),
});

await client.connect();
const result = await client.request("ping", {});
```

### Server

```ts
import { createServer } from "node:http";
import { createGateway } from "@agentick/gateway";
import { websocketServer } from "@agentick/transport-websocket/server";

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

### Server, gateway-owned (ADR 84 `ServerTransport`)

`webSocketServerTransport(config)` inverts the raw factory: the wire
config (`port`, TLS, origins) binds at construction, and the gateway
injects itself as the dispatch host at `listen()`. Hand it to
`createGateway({ transports })` and the gateway owns the whole
lifecycle — `gateway.listen()` creates and binds the Node `http.Server`;
`gateway.close()` tears both the WS handler and the server down.

```ts
import { createGateway } from "@agentick/gateway";
import { webSocketServerTransport } from "@agentick/transport-websocket/server";

const gateway = await createGateway({
  transports: [
    webSocketServerTransport({
      port: 8080,
      host: "0.0.0.0",
      allowedOrigins: ["https://my-app.example.com"],
    }),
  ],
});

await gateway.listen(); // creates node:http server, attaches WS, binds :8080
// ...
await gateway.close(); // tears down the WS handler AND the server it created
```

An adopter that already owns a Node server (shared with an HTTP
transport, an `https.Server`) passes `{ httpServer }` instead of
`{ port }` — the wrapper attaches to it and, since it did not create it,
does not close it.

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
  gateway: GatewayHarnessProtocol; // DispatchHost
  path?: string;
  /** WS-level ping/pong interval. Default 30_000 ms. */
  heartbeatIntervalMs?: number;
  // ── Security defaults (STATUS A2 §4c) — safe when omitted, each overridable.
  /** Cross-origin allow-list. Omitted → same-origin only. NEVER `"*"`. */
  allowedOrigins?: readonly string[];
  /** Extra `Host` values beyond loopback + allowedOrigins' hosts. */
  allowedHosts?: readonly string[];
  /** Trust `X-Forwarded-Host`/`-Proto` — only from a loopback peer. Default false. */
  trustProxy?: boolean;
  /** Ingress authentication (ADR 61). Runs ONCE per connection at
   *  upgrade; rejection destroys the socket with 401. Omitted = every
   *  connection is anonymous (the local pole). */
  authSource?: AuthSource;
  /** Accept the bearer token from `?token=`. DEFAULT FALSE (query
   *  strings leak into proxy logs / history). */
  allowQueryToken?: boolean;
}
```

### `webSocketServerTransport(config): ServerTransport`

```ts
// Common path — the wrapper owns the Node http.Server:
type WebSocketServerTransportPortConfig = Omit<WebSocketServerOptions, "gateway" | "httpServer"> & {
  port: number;
  host?: string; // bind address; DEFAULT 127.0.0.1 (loopback only — the security boundary)
};
// Or attach to an adopter-owned server:
type WebSocketServerTransportConfig =
  | WebSocketServerTransportPortConfig
  | Omit<WebSocketServerOptions, "gateway">; // { httpServer, ... }
```

Server auth extracts the bearer from `Authorization: Bearer ...` (and,
only when `allowQueryToken` is set, `?token=`), then runs it through
the shared `authenticateIngress` helper before completing the upgrade.

## Patterns

### Native `WebSocket` everywhere

The client transport uses `globalThis.WebSocket` by default. As of
**Node 22 LTS**, native `WebSocket` is stable on the global — same API
as browsers. Bun, Deno, and Cloudflare Workers have it too. **No
isomorphic shim needed.**

For Node 18/20, install `ws` and pass it explicitly:

```ts
import { WebSocket } from "ws";
import { websocket } from "@agentick/transport-websocket/client";

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

A server that mounts both `@agentick/transport-websocket/server`
and the future `@agentick/mcp-surface` extension accepts either
protocol on the same endpoint. Client picks `agentick-rpc-v1` first;
falls back to `mcp` if the server only speaks that.

## Status

Phase 33.C of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md` and
`docs/proposals/v2/blueprint/33-client-and-transports.md`.

## Roadmap & known gaps

**High severity (will land in a 33.C hardening pass):**

- **Backpressure not wired at this transport.** The bounded-buffer
  primitive now lives in the base `MultiplexedStream`
  (`@agentick/transport`: `drop-oldest` / `drop-newest` /
  `close-on-overflow` / `unbounded`), but the WS transport constructs
  its subscription / progress streams with the default `unbounded`
  policy and does not yet expose a per-stream backpressure option — a
  slow consumer with a fast emitter still grows the buffer unbounded.
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
  subprotocol option; a real bilingual server is the `@agentick/mcp-surface`
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
- **No server-initiated notification fan-out (#311).** The server
  tracks live sockets for teardown but does NOT register connections
  with the gateway (`gateway.acceptConnection`) or fan a
  `gateway.notify(...)` broadcast out to connected clients. Notifications
  today only flow within a dispatch (subscription events, progress).
  Broadcast fan-out with connection-metadata targeting is unbuilt.

**Done in this phase:**

- ✓ Subprotocol negotiation — `agentick-rpc-v1` only, server rejects others (`security.spec.ts`)
- ✓ Frame multiplexing — N concurrent RPCs verified (`smoke.spec.ts`)
- ✓ Reconnect machinery — server-bounce → reconnect transition, explicit-close suppression, disabled-reconnect → straight to closed (`reconnect.spec.ts`)
- ✓ Origin validation — disallowed Origin → 403; allowed → accept; no Origin → accept (`security.spec.ts`)
- ✓ Security defaults (STATUS A2 §4c) — safe default (no `allowedOrigins`) rejects a cross-origin upgrade, accepts same-origin; `Host` allow-list rejects a spoofed non-loopback Host; loopback bind default; loopback-only forwarded-header trust (`security.spec.ts` + policy matrix in `@agentick/transport`)
- ✓ `notifications/cancelled` from client (frame emit on AbortSignal) + server-side ConnectionContext routing (`cancellation.spec.ts`)
- ✓ Custom `WebSocket` constructor override (e.g., `ws` library) (`custom-ws-ctor.spec.ts`)
- ✓ Spec-validator integration at the wire boundary (`wire-conformance.spec.ts`)
- ✓ Wire conformance suite passes (`wire-conformance.spec.ts`)
- ✓ Shared transport conformance — `runTransportConformance` (`transport-conformance.spec.ts`)
- ✓ Per-connection ingress authn (`ingress-authn.spec.ts` via `runIngressAuthnConformance`)
- ✓ Full-jitter backoff distribution — verified upstream on the shared `computeFullJitterBackoff` in `@agentick/transport` (`backoff-jitter.spec.ts`); this transport inherits it

**Claimed but not yet under test (moved from "done" to here; promoted back when verified):**

- ✗ **Cursor-aware resubscribe under retention.** Reconnect machinery works; the cursor-aware replay path is wired but not exercised under retention pressure. Needs a `LocalEventBus` with a tight `retention.maxEvents`, a subscription that falls behind, and an assertion that the new subscription receives `notifications/subscription/evicted`. Lands in the 33.C hardening pass.
- ✗ **WS-level ping/pong heartbeat.** Server schedules pings; client receives them; the "idle client terminated on missed pong" branch is unverified. Needs a misbehaving client that ignores ping. Deferred.
- ✗ **Bilingual MCP subprotocol negotiation.** Client accepts `extraSubprotocols`; no integration test against a bilingual server. Lands with `@agentick/mcp-surface` (Phase 33.I).
- ✗ **Real `session/send` end-to-end with model adapter.** Wire path is verified; session/send dispatch into a real session with progress events flowing is not (needs a real model adapter). Lands in the hardening pass.

## Development plan

| Step                             | Lands when                                                                                                                                |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 33.C MVP                   | This commit — `a14670c8`                                                                                                                  |
| 33.C hardening pass              | After Phase 33.D + 33.E so backpressure design covers all transports; adds bounded streams, real `session/send` test with a model adapter |
| Compression / max-payload tuning | When a real workload surfaces the need                                                                                                    |
| `GatewayExtension` wrapper       | When the shared `@agentick/gateway-rpc-adapter` lands (33.D extraction)                                                                   |
| Session affinity                 | When ADR 29 Phase D cluster substrate lands                                                                                               |
| Bilingual MCP test               | Phase 33.I (`@agentick/mcp-surface`)                                                                                                      |

## Verified by

Every claim in the **Done in this phase** checklist above is verified by
tests in `src/__tests__/`. Claims listed in **Claimed but not yet under
test** sit in the same checklist with an `✗` marker — they document
behavior the design intends but tests don't yet exercise. The
discipline: a `✓` claim has a test or it doesn't ship with the `✓`.

| Concern                                                                                                                                                                      | Test file                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| End-to-end smoke (WS connect, ping, listApps, multiplexed RPCs)                                                                                                              | `src/__tests__/smoke.spec.ts`                                              |
| Shared transport conformance (`runTransportConformance`)                                                                                                                     | `src/__tests__/transport-conformance.spec.ts`                              |
| Reconnect state machine                                                                                                                                                      | `src/__tests__/reconnect.spec.ts`                                          |
| Wire conformance (envelope roundtrips, validator integration, batches)                                                                                                       | `src/__tests__/wire-conformance.spec.ts`                                   |
| Subprotocol enforcement (`agentick-rpc-v1`-only)                                                                                                                             | `src/__tests__/security.spec.ts`                                           |
| Origin validation (`allowedOrigins`)                                                                                                                                         | `src/__tests__/security.spec.ts`                                           |
| Security defaults — safe cross-origin deny / same-origin allow / Host allow-list (STATUS A2 §4c)                                                                             | `src/__tests__/security.spec.ts`                                           |
| `notifications/cancelled` client emit + server handle                                                                                                                        | `src/__tests__/cancellation.spec.ts`                                       |
| Custom WebSocket constructor (`ws` library)                                                                                                                                  | `src/__tests__/custom-ws-ctor.spec.ts`                                     |
| Ingress authn (ADR 61) — per-connection bearer auth, fail-closed 401, prototype-key guard, once-per-socket, local pole when no `authSource`                                  | `src/__tests__/ingress-authn.spec.ts` (`runIngressAuthnConformance`)       |
| `webSocketServerTransport` — `ServerTransport` conformance + real gateway-owned bind (`gateway.listen()` binds the port + WS round-trips a ping; `gateway.close()` frees it) | `src/__tests__/server-transport.spec.ts` (`runServerTransportConformance`) |
