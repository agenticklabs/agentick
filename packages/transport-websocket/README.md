# @agentick/transport-websocket

**One socket, many conversations — and a drop that doesn't lose events.** A single WebSocket carries N concurrent JSON-RPC requests (correlated by `id`) alongside N persistent subscriptions and progress streams (correlated by `subscriptionId` and `progressToken`). When the wire breaks, the client backs off with full jitter, reconnects, and replays every still-open subscription **from its last-seen cursor**.

That last part is the bet. Reconnection is treated as a data problem, not a connection problem: the server's bus retains events, the client remembers where it was, and resuming is a cursor read rather than a resync protocol. Everything else follows — plain WebSocket with a negotiated subprotocol instead of a framing library, JSON-RPC instead of a bespoke envelope, and identity pinned once at the upgrade because the connection _is_ the session.

## Install

```bash
npm install @agentick/transport-websocket
```

| Subpath                                   | What it gives you                              |
| ----------------------------------------- | ---------------------------------------------- |
| `@agentick/transport-websocket/client`    | `websocket(options)` — the `ClientTransport`   |
| `@agentick/transport-websocket/server`    | `websocketServer` / `webSocketServerTransport` |
| `@agentick/transport-websocket` (default) | both, plus `AGENTICK_SUBPROTOCOL`              |

The default subpath carries both halves for a process that owns both. A bundler resolving with the `browser` condition gets `/client` for that same specifier, because the server half reaches `node:http` and `ws` and cannot be bundled — so the obvious import works in a browser too, and asking it for `websocketServer` is a named-export error rather than an unresolvable `node:` scheme.

The client uses `globalThis.WebSocket` (Node 22+, browser, Bun, Deno, edge) — no isomorphic shim. The server uses the bundled `ws` library, because Node's native WebSocket is client-only. Pair the server with [@agentick/gateway](../gateway) and the client with [@agentick/client-core](../client-core).

## Quick start

Hand the transport to the gateway and the gateway owns the whole listener:

```ts
import { createGateway } from "@agentick/gateway";
import { webSocketServerTransport } from "@agentick/transport-websocket/server";

const gateway = await createGateway({
  transports: [webSocketServerTransport({ port: 8080 })],
});

await gateway.listen(); // creates the node:http server, attaches WS, binds 127.0.0.1:8080
// … serve traffic …
await gateway.close(); // tears down the WS handler AND the server it created
```

Point a client at it:

```ts
import { createClient } from "@agentick/client-core";
import { websocket } from "@agentick/transport-websocket/client";

const client = await createClient({
  transport: websocket({ url: "ws://127.0.0.1:8080" }),
});

await client.connect();
await client.request("ping", {});

const { apps } = await client.gateway().listApps();
```

> [!IMPORTANT]
> `webSocketServerTransport({ port })` binds `127.0.0.1` unless you pass `host`. That default is a security boundary, not a convenience. Read [Security defaults](#security-defaults) before widening it to `0.0.0.0`.

## The subprotocol is the handshake

Clients offer `Sec-WebSocket-Protocol: agentick-rpc-v1`; the server selects it or refuses the upgrade outright. A socket that negotiated no protocol never carries a frame, which makes protocol confusion impossible rather than merely unlikely — a stray browser tab pointed at the port fails at the handshake, not three frames in.

The constant is exported so a custom server or a probe can offer it verbatim:

```ts
import { AGENTICK_SUBPROTOCOL } from "@agentick/transport-websocket";
import { WebSocket } from "ws";

const raw = new WebSocket("ws://127.0.0.1:8080", [AGENTICK_SUBPROTOCOL]);
```

`extraSubprotocols` appends further offers to the upgrade for a server that speaks more than one dialect on the same endpoint; `agentick-rpc-v1` stays first in preference order.

## Reconnect with cursor-aware resubscribe

```ts
import { websocket } from "@agentick/transport-websocket/client";

const transport = websocket({
  url: "wss://agents.example.com",
  reconnect: {
    initialDelayMs: 100,
    maxDelayMs: 30_000,
    maxAttempts: Infinity,
  },
});
```

That is the default policy written out. On a drop the transport moves to `reconnecting`, waits a full-jitter exponential delay, opens a fresh socket, and replays each still-open subscription from its last-seen cursor. If the cursor is still inside the server's retention window the subscription resumes with no gap. If it fell out, the stream surfaces `notifications/subscription/evicted` as a protocol error, so the decision to resume from oldest, jump to latest, or give up is yours to make explicitly rather than silently.

Two escapes matter and both are pinned by tests: `close()` never triggers a reconnect, and `reconnect: { enabled: false }` transitions straight to `closed` on a drop instead of retrying.

## Any `WebSocket` implementation

The default is `globalThis.WebSocket`, which is stable on Node 22 LTS, browsers, Bun, Deno, and Cloudflare Workers. Override the constructor for Node 18/20, or when you need HTTP headers on the upgrade — the browser API cannot set them, `ws` can:

```ts
import { WebSocket } from "ws";
import { websocket } from "@agentick/transport-websocket/client";
import type { WebSocketTransportOptions } from "@agentick/transport-websocket/client";

const transport = websocket({
  url: "ws://127.0.0.1:8080",
  // `ws` has a wider signature than the global; the transport only uses the
  // wire-shape subset, so the cast is safe.
  WebSocket: WebSocket as unknown as WebSocketTransportOptions["WebSocket"],
});
```

With no global `WebSocket` and no override, construction throws with the fix in the message rather than failing later at connect.

## Authentication is pinned at the upgrade

WebSocket is connection-oriented, so an `AuthSource` runs **once**, at the upgrade, before the socket is wired for frames. The resolved identity governs every frame that connection ever sends. A rejection destroys the socket with `401` — there is no half-open state where an unauthenticated connection can dispatch.

```ts
import { createGateway } from "@agentick/gateway";
import { staticTokenAuthSource } from "@agentick/transport";
import { webSocketServerTransport } from "@agentick/transport-websocket/server";

const gateway = await createGateway({
  transports: [
    webSocketServerTransport({
      port: 8080,
      // Any AuthSource: a JWT verifier, an OAuth introspection call, or this
      // reference table. Rejection destroys the socket before dispatch exists.
      authSource: staticTokenAuthSource({ tokens: { "tok-alice": "alice" } }),
    }),
  ],
});
await gateway.listen();
```

The token comes from `Authorization: Bearer …`. Omitting `authSource` admits every connection as the local pole — no principal, appropriate for a loopback bind behind your own process boundary. Configuring one makes the edge fail closed: missing or unknown tokens are refused, never downgraded to anonymous.

A refused upgrade publishes a `gateway:admission:failed` event carrying the failure class, transport kind, and the peer address the edge alone knows. Credential material never rides along — no token, no header bag, no `credential` key.

> [!WARNING]
> `allowQueryToken: true` accepts the bearer from `?token=`. It defaults to **false** for good reason: query strings land in proxy access logs, browser history, and `Referer` headers. Enable it only for clients that genuinely cannot set headers, and only with short-lived tokens.

## Per-connection admission

Because a connection is a durable thing, it gets its own admission decision — fired after authentication, before the socket receives frames. A hook that throws rejects the connection; the server closes it with the WebSocket policy-violation code `1008` and never wires it up.

```ts
const gateway = await createGateway({
  transports: [webSocketServerTransport({ port: 8080 })],
});

gateway.hook({
  onBeforeGatewayAccept: (info) => {
    // info.transportId — e.g. "websocket:8080"; info.identity — from the
    // AuthSource; info.remoteAddress — the TCP peer.
    if (info.remoteAddress && isBanned(info.remoteAddress)) {
      throw new Error("connection rejected");
    }
    return info;
  },
});

await gateway.listen();
```

Rejecting one connection never takes the listener down. This is the connection-shaped counterpart to per-request authorization: rate limits per peer, tenant pinning, and connection quotas all live here rather than being re-derived on every frame.

## Security defaults

The unconfigured server ships closed, enforcing the policy in [@agentick/transport](../transport) at the upgrade:

| Default                   | What it blocks                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-site rejection      | An `Origin` that is neither same-origin nor allowlisted → `403` at the upgrade. A drive-by page cannot open the socket                      |
| `Host` allow-list         | Only loopback names and hostnames you list. Defeats DNS rebinding — an attacker name resolving to `127.0.0.1` arrives with a foreign `Host` |
| Loopback-only proxy trust | `X-Forwarded-Host` / `-Proto` are honored only with `trustProxy: true` **and** a loopback TCP peer                                          |
| Loopback bind             | `webSocketServerTransport({ port })` binds `127.0.0.1` unless `host` says otherwise                                                         |

Widening is explicit:

```ts
const transport = webSocketServerTransport({
  port: 8080,
  host: "0.0.0.0", // public bind — deliberate
  allowedHosts: ["agents.example.com"], // required once you serve under a real hostname
  allowedOrigins: ["https://app.example.com"], // exact origins; never `*`
});
```

A request carrying no `Origin` is a non-browser caller and is admitted — browsers always send one, so its absence is information, not a bypass.

> [!NOTE]
> There is no CSRF token here, and that is not an omission. A browser sends an unforgeable `Origin` on a WebSocket upgrade, so the origin and host gates _are_ the defense; a per-request token has nothing to protect on a persistent connection. The HTTP transport, whose mutations are forgeable, does carry one.

## Sharing a Node server

Pass `{ httpServer }` instead of `{ port }` to attach to a server you already own — one shared with the HTTP transport, an `https.Server`, or Express's underlying listener. The wrapper attaches and, since it did not create the server, does not close it.

```ts
import { createServer } from "node:http";
import { createGateway } from "@agentick/gateway";
import { httpServerTransport } from "@agentick/transport-http/server";
import { webSocketServerTransport } from "@agentick/transport-websocket/server";

const server = createServer();
server.on("request", (req, res) => {
  if (req.url === "/health") res.end("ok"); // else: not ours — write nothing
});

const gateway = await createGateway({
  transports: [
    httpServerTransport({ httpServer: server, path: "/agentick" }),
    webSocketServerTransport({ httpServer: server, path: "/agentick/ws" }),
  ],
});
await gateway.listen(); // attaches both; binds nothing — the server is yours
server.listen(8080);
```

> [!IMPORTANT]
> Node's `upgrade` semantics are first-wins, and an upgrade no listener claims is destroyed by Node itself. On an **attached** server this transport therefore leaves non-matching upgrades untouched, so a Socket.IO endpoint or a second transport on another path still gets its socket alive. On a server the transport created (`{ port }`), nothing else can legitimately claim an upgrade, so a non-matching one is destroyed. That is what `ownsServer` selects, and the wrapper sets it from the config branch you took.

## API

### `@agentick/transport-websocket/client`

| Export                             | Purpose                            |
| ---------------------------------- | ---------------------------------- |
| `websocket(options)`               | The `ClientTransport`              |
| `WebSocketTransportOptions` (type) | The option bag below               |
| `ReconnectPolicy` (type)           | Re-exported from the base plumbing |

| Option              | Meaning                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `url`               | `ws://` or `wss://` endpoint. Required                                                   |
| `WebSocket`         | Constructor override. Defaults to `globalThis.WebSocket`                                 |
| `extraSubprotocols` | Additional offers appended after `agentick-rpc-v1`                                       |
| `reconnect`         | `{ enabled, initialDelayMs, maxDelayMs, maxAttempts }`. Full-jitter backoff, 100ms → 30s |
| `id`                | Stable transport id for logs. Defaults to `ws-<n>`                                       |

### `@agentick/transport-websocket/server`

| Export                             | Purpose                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `webSocketServerTransport(config)` | `ServerTransport` the gateway owns. `{ port, host? }` or `{ httpServer }`                                                                  |
| `websocketServer(options)`         | The raw factory — attaches to a Node server you supply, returns `{ close() }`                                                              |
| `WebSocketServerOptions` (type)    | `httpServer`, `gateway`, `path`, `heartbeatIntervalMs`, `authSource`, `allowQueryToken`, `transportId`, `ownsServer` + the security fields |

Security fields (shared, from [@agentick/transport](../transport)): `allowedOrigins`, `allowedHosts`, `trustProxy`. Transport ids are stable and readable: `websocket:8080` for a port config, `websocket:attached` for an adopter-owned server — and that id is what `onBeforeGatewayAccept` sees.

### `@agentick/transport-websocket`

| Export                 | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| `AGENTICK_SUBPROTOCOL` | `"agentick-rpc-v1"` — the negotiated subprotocol name |

## Patterns

**Shared plumbing.** [@agentick/transport](../transport) owns `BaseClientTransport` (state machine, RPC correlation, subscription and progress multiplexing, cursor-aware resubscribe, full-jitter backoff), `dispatchRequest`, and the web-security policy. This package is the wire: upgrade, subprotocol, and frame codec.

**Sibling wires.** [@agentick/transport-http](../transport-http) speaks the same JSON-RPC over a single HTTP endpoint — the fallback where upgrades are blocked, and mountable inside a fetch-native framework. [@agentick/transport-in-process](../transport-in-process) skips serialization entirely for tests and single-process apps. All three coexist on one gateway.

**Wire shapes.** [@agentick/spec](../spec) owns `ClientTransport`, `ServerTransport`, `AuthSource`, `IngressIdentity`, `ConnectionInfo`, and the JSON-RPC types. Every inbound frame is validated against them before the transport touches it.

## Roadmap & known gaps

- **Backpressure is unbounded here.** The bounded-buffer policies live on `MultiplexedStream` in [@agentick/transport](../transport), but this transport constructs subscription and progress streams with the default `unbounded` policy and exposes no per-stream option. A slow consumer behind a fast emitter grows the buffer. Outbound is equally unguarded: `ws.send()` is called without checking `bufferedAmount`.
- **No compression.** `per-message-deflate` (RFC 7692) is supported by `ws` and not enabled. A real bandwidth win for large payloads.
- **`maxPayload` is untuned.** The `ws` default of 100 MB stands, so a misbehaving client can send very large frames.
- **No session affinity across reconnects.** `initialize` returns a `connectionId`, but the client does not carry it on reconnect, so a load balancer cannot sticky-route. Fine for single-node deployments; broken for clustered ones.
- **No server-initiated broadcast.** The server tracks live sockets for teardown but does not fan a gateway-level `notify` out to connected clients. Notifications flow only within a dispatch — subscription events and progress.
- **Heartbeat termination is unverified.** The server pings on an interval and terminates a socket that misses its pong; the miss branch has no test (it needs a client that deliberately ignores `ping`).
- **Cursor-aware replay under retention pressure is unverified.** Reconnect is covered and the replay path is wired, but no test drives a subscription past a tight retention window to assert the `evicted` notification arrives.
- **`extraSubprotocols` has no integration test.** The client offers them; nothing exercises a server that actually speaks a second dialect.

## Verified by

- `src/__tests__/smoke.spec.ts` — upgrade with subprotocol negotiation against a real gateway, `ping` round-trip, `listApps` reflecting `createApp`, a server error arriving typed (`_tag` preserved), several RPCs multiplexed on one socket, clean close with subsequent requests rejecting, and a subprotocol-less client refused.
- `src/__tests__/transport-conformance.spec.ts` (`runTransportConformance`) — state machine and listener notification, RPC correlation, pre-connect rejection, `JsonRpcError` → `TransportError`, concurrent multiplexing, `notifications/cancelled` on abort, subscription routing plus `closed` and `evicted`, and progress frames reaching `progress(token)`.
- `src/__tests__/reconnect.spec.ts` — a server bounce driving `reconnecting` → `open` with the wire working afterwards, explicit `close()` suppressing reconnect, and `enabled: false` going straight to `closed`.
- `src/__tests__/security.spec.ts` — upgrades refused with no subprotocol and with an unrecognised one, accepted with `agentick-rpc-v1`; disallowed `Origin` refused and allowlisted accepted; no `Origin` admitted; and the default posture — cross-origin refused, same-origin admitted, spoofed non-loopback `Host` refused.
- `src/__tests__/ingress-authn.spec.ts` (`runIngressAuthnConformance`) — valid bearer stamping a principal, missing and invalid and prototype-key tokens refused at the edge, local pole with no `authSource`, two dispatches on one socket sharing the connection's identity, plus the admission-failure event: published on refusal, absent on admission, and carrying no credential material.
- `src/__tests__/authn-timeout.spec.ts` — a never-answering `AuthSource` refusing the upgrade instead of leaving it pending, three refused probes leaving zero sockets held, and one that answers inside the ceiling still upgrading.
- `src/__tests__/cancellation.spec.ts` — the client emitting `notifications/cancelled` with the matching `requestId` and `reason: "aborted"` when a signal fires mid-request, and the server tolerating a cancellation for an unknown id while staying responsive.
- `src/__tests__/custom-ws-ctor.spec.ts` — the `ws` library passed as the `WebSocket` override, connecting and round-tripping.
- `src/__tests__/wire-conformance.spec.ts` (`runWireConformance`) — envelope round-trips and batch handling through the codec.
- `src/__tests__/server-transport.spec.ts` (`runServerTransportConformance`) — the lifecycle contract (stable id, bind, teardown, idempotent listen and close, re-listen), a real gateway-owned bind with a client ping and a freed port after `close()`, and per-connection admission: a throwing `onBeforeGatewayAccept` dropping the connection with code `1008`, a permitting one firing exactly once with the transport id.
- `src/__tests__/shared-server-coexistence.spec.ts` — one Node server carrying four consumers at once: this transport, [@agentick/transport-http](../transport-http), a foreign `/health` request listener that still answers `200`, and a foreign upgrade listener whose socket survives — concurrently.
- The security policy's full allow/deny matrix and the full-jitter backoff distribution are verified upstream in [@agentick/transport](../transport).
