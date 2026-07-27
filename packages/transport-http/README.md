# @agentick/transport-http

**One URL carries the whole protocol.** JSON-RPC 2.0 over Streamable HTTP: `POST` for requests — answered with `application/json`, or with `text/event-stream` when the request asks for progress — a persistent `GET` for notifications that belong to no single call, and `DELETE` to release server state. Session affinity rides the `Mcp-Session-Id` header, so a load balancer sticky-routes without parsing bodies.

That single-endpoint shape is the bet. It reaches the places a socket cannot: proxies that strip `Upgrade`, CDNs, serverless platforms with no upgrade path. And because a request and a response are web standards, the same package also ships a `(req: Request) => Promise<Response>` handler you mount inside Hono / Nitro / Next.js — so a gateway can be a route in an app you already run instead of a port you have to open.

## Install

```bash
npm install @agentick/transport-http
```

| Subpath                              | What it gives you                                                     |
| ------------------------------------ | --------------------------------------------------------------------- |
| `@agentick/transport-http/client`    | `http(options)` — a `fetch`-based `ClientTransport`                   |
| `@agentick/transport-http/server`    | `httpServer` / `httpServerTransport` — mounts on a Node `http.Server` |
| `@agentick/transport-http/fetch`     | `fetchServerTransport` — the embedded web-standard handler            |
| `@agentick/transport-http` (default) | all of the above                                                      |

The client runs anywhere `fetch` does (Node 20.19+, browser, Bun, Deno, edge). The Node server paths need `node:http`. Pair the server with [@agentick/gateway](../gateway) and the client with [@agentick/client-core](../client-core).

## Quick start

Hand the transport to the gateway and the gateway owns the port:

```ts
import { createGateway } from "@agentick/gateway";
import { httpServerTransport } from "@agentick/transport-http/server";

const gateway = await createGateway({
  transports: [httpServerTransport({ port: 3000 })],
});

await gateway.listen(); // creates the node:http server, binds 127.0.0.1:3000
// … serve traffic …
await gateway.close(); // detaches the handler AND closes the server it created
```

Point a client at the URL and the wire is done:

```ts
import { createClient } from "@agentick/client-core";
import { http } from "@agentick/transport-http/client";

const client = await createClient({
  transport: http({ url: "http://127.0.0.1:3000" }),
});

await client.connect(); // opens the GET notification stream, completes the CSRF handshake
await client.request("ping", {});

const { apps } = await client.gateway().listApps();
```

`connect()` does three things that matter later: it opens the persistent `GET` stream, captures the CSRF token the server issues on it, and remembers the `Mcp-Session-Id` the first response carries. Every subsequent `POST` echoes both.

> [!IMPORTANT]
> `httpServerTransport({ port })` binds `127.0.0.1` unless you pass `host`. That default is a security boundary, not a convenience. Read [Security defaults](#security-defaults) before widening it to `0.0.0.0`.

## One URL, three methods

| Request                                      | Response                                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST <url>`                                 | `application/json` for an ordinary RPC. `text/event-stream` when the request carries `_meta.progressToken` — progress notifications, then the final response |
| `GET <url>` with `Accept: text/event-stream` | The persistent notification channel: subscription events, auth expiry, anything not scoped to one call. Keep-alive comments every 30s                        |
| `DELETE <url>`                               | Releases the session's fan-out state (subscriptions, notification stream)                                                                                    |
| `OPTIONS <url>`                              | CORS preflight — `204`, and headers only for an explicitly allowlisted origin                                                                                |

A JSON array body is a JSON-RPC batch and answers with an array of responses. A frame with no `id` is a notification and answers `204`; `notifications/cancelled` routes into the abort registry of the in-flight request it names.

## Streaming a long-running call

A request that carries `_meta.progressToken` gets an SSE body instead of a JSON one: progress notifications first, the final JSON-RPC response as the terminal frame. The client unpacks that stream and fans the frames to the matching progress stream — nothing to configure.

```ts
import { createClient } from "@agentick/client-core";
import { http } from "@agentick/transport-http/client";

const transport = http({ url: "http://127.0.0.1:3000" });
const client = await createClient({ transport });
await client.connect();

// Frames for a progress token land here, whichever body shape carried them.
const progress = transport.progress("run-1");
for await (const frame of progress) {
  console.log(frame.cursor, frame.envelope);
}
```

Notifications that belong to no request — subscription events, auth expiry — arrive on the persistent `GET` stream instead, and route to `transport.subscribe(...)` streams by subscription id.

## Security defaults

The unconfigured server ships closed. Four defaults come from the policy in [@agentick/transport](../transport), shared with every network-facing edge so the posture is identical across them:

| Default                   | What it blocks                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-site rejection      | `Sec-Fetch-Site: cross-site`, or an `Origin` that is neither same-origin nor allowlisted → `403` before dispatch                            |
| `Host` allow-list         | Only loopback names and hostnames you list. Defeats DNS rebinding — an attacker name resolving to `127.0.0.1` arrives with a foreign `Host` |
| Loopback-only proxy trust | `X-Forwarded-Host` / `-Proto` are honored only with `trustProxy: true` **and** a loopback TCP peer                                          |
| CSRF token                | A per-process token issued on the `GET` bootstrap, required in `x-agentick-csrf` on every mutation                                          |

CORS is never permissive: an allowlisted origin is echoed back verbatim, and there is no code path that emits `*`.

Each default is overridable, and widening is explicit:

```ts
import { httpServerTransport } from "@agentick/transport-http/server";

const transport = httpServerTransport({
  port: 3000,
  host: "0.0.0.0", // public bind — deliberate
  allowedHosts: ["agents.example.com"], // required once you serve under a real hostname
  allowedOrigins: ["https://app.example.com"], // echoed exactly; never `*`
  trustProxy: true, // honored only when the TCP peer is loopback
});
```

> [!WARNING]
> A non-browser caller that cannot run the `GET`-then-echo handshake needs `csrf: false`. That turns off **only** the CSRF token — the cross-site and `Host` gates stay in force. The framework client handshakes the token for you, so `csrf: false` is for raw callers, not browsers.

## Per-request authentication

HTTP is request-oriented, so an `AuthSource` runs **per request**: each `POST` authenticates from its own `Authorization: Bearer` header, and that request's identity governs only that request's dispatch. Two `POST`s sharing one `Mcp-Session-Id` with different tokens resolve to their own principals — the per-session state deliberately caches no identity, so identity cannot bleed between requests.

```ts
import { createGateway } from "@agentick/gateway";
import { staticTokenAuthSource } from "@agentick/transport";
import { httpServerTransport } from "@agentick/transport-http/server";

const gateway = await createGateway({
  transports: [
    httpServerTransport({
      port: 3000,
      // Any AuthSource: a JWT verifier, an OAuth introspection call, or this
      // reference table. Rejection → 401, and dispatch is never reached.
      authSource: staticTokenAuthSource({ tokens: { "tok-alice": "alice" } }),
    }),
  ],
});
await gateway.listen();
```

Omitting `authSource` admits every request as the local pole — no principal, appropriate for a loopback bind behind your own process boundary. Configuring one makes the edge fail closed: a missing or unknown token is a `401`, never a silent downgrade to anonymous.

A refused crossing publishes a `gateway:admission:failed` event carrying the failure class and transport kind, with the peer address the edge alone knows. Credential material never rides along — no token, no header bag, no `credential` key.

## Embedded in a fetch-native framework

`fetchServerTransport` swaps the Node server for a web-standard handler you mount in your own route table. The gateway still owns the lifecycle: `gateway.listen()` binds it, `gateway.close()` sweeps every open SSE stream.

```ts
import { createGateway } from "@agentick/gateway";
import { fetchServerTransport, type Identity } from "@agentick/transport-http/fetch";

// Construct BEFORE the gateway exists, so the handler can be mounted at
// app-setup time — it closes over a host slot that listen() fills.
const { transport, handler } = fetchServerTransport({
  // YOUR auth already ran in YOUR middleware. Hand back the RESULT, never tokens.
  identity: async (req): Promise<Identity | Response> => {
    const user = await authenticate(req);
    if (!user) return new Response(null, { status: 401 }); // your rejection, verbatim
    return {
      principal: user.id, // stamped on every event this request produces
      user: { tenantId: user.tenantId }, // reachable as ctx.user everywhere
      scopes: user.scopes, // fed to the gateway's authorizer
    };
  },
});

app.all("/agentick/*", (c) => handler(c.req.raw)); // Hono; Nitro/Next are the same shape

const gateway = await createGateway({ transports: [transport] });
await gateway.listen();
```

`identity` is the only difference from the standalone server. Returning a `Response` short-circuits — the caller gets your 401 or redirect byte for byte and dispatch is never reached. Returning an `Identity` threads it into dispatch as the ingress identity, where the gateway's authorizer enforces `scopes` at the same choke point every other transport uses. Token material stays inside your callback.

> [!WARNING]
> Embedded mode is fail-closed. With no `identity` callback, **every request is refused** with a typed `IngressAuthRequired` `401` — a missing resolver is a misconfiguration, not an invitation to run as the local pole. The one documented opt-out is `security: "host-managed"`: you attest that your framework gates access, and requests then run as the local pole.

Two things behave differently when embedded. `trustProxy` is inert — a web `Request` exposes no TCP peer, so your framework owns the network boundary. And the `Host` / `Origin` / CSRF gates still run against the request headers, which means serving under a real hostname requires `allowedHosts`. Security applies _more_ when embedded, not less.

A request that arrives before `listen()` or after `close()` gets an honest `503` with a typed JSON-RPC body. There is no silent queue: the gateway requires `listen()` before apps exist, so pre-listen traffic is a host-app ordering bug and is surfaced as one.

## Sharing a Node server

Pass `{ httpServer }` instead of `{ port }` to mount on a server you already own — an `https.Server`, Express's underlying listener, or one shared with the WebSocket transport. The wrapper attaches and, since it did not create the server, does not close it.

```ts
import { createServer } from "node:http";
import { createGateway } from "@agentick/gateway";
import { httpServerTransport } from "@agentick/transport-http/server";

const server = createServer();
server.on("request", (req, res) => {
  if (req.url === "/health") res.end("ok"); // else: not ours — write nothing
});

const gateway = await createGateway({
  transports: [httpServerTransport({ httpServer: server, path: "/agentick" })],
});
await gateway.listen(); // attaches; does NOT bind — the server is yours
server.listen(8080);
```

> [!IMPORTANT]
> Every Node `request` listener fires for every request. On an attached server the transport therefore **ignores** requests outside its `path` rather than answering `404` — writing one would double-respond against your framework and clobber its headers. On a server the transport created (`{ port }`), nothing else can answer, so a non-matching request is safely `404`'d. That's what `ownsServer` selects, and the wrapper sets it from the config branch you took.

## API

### `@agentick/transport-http/client`

| Export                        | Purpose                                      |
| ----------------------------- | -------------------------------------------- |
| `http(options)`               | The `fetch`-based `ClientTransport`          |
| `HttpTransportOptions` (type) | `url`, `fetch`, `headers`, `reconnect`, `id` |

| Option      | Meaning                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| `url`       | The single endpoint. Required                                                            |
| `fetch`     | Override `globalThis.fetch` — auth wrappers, mTLS, interceptors                          |
| `headers`   | Attached to every request; snapshotted at construction                                   |
| `reconnect` | `{ enabled, initialDelayMs, maxDelayMs, maxAttempts }`. Full-jitter backoff, 100ms → 30s |
| `id`        | Stable transport id for logs. Defaults to `http-<n>`                                     |

### `@agentick/transport-http/server`

| Export                        | Purpose                                                                                                  |
| ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| `httpServerTransport(config)` | `ServerTransport` the gateway owns. `{ port, host? }` or `{ httpServer }`                                |
| `httpServer(options)`         | The raw factory — attaches to a Node server you supply, returns `{ close() }`                            |
| `HttpServerOptions` (type)    | `httpServer`, `gateway`, `path`, `heartbeatIntervalMs`, `authSource`, `ownsServer` + the security fields |

Security fields (shared, from [@agentick/transport](../transport)): `allowedOrigins`, `allowedHosts`, `trustProxy`, `csrf`.

### `@agentick/transport-http/fetch`

| Export                          | Purpose                                                                                             |
| ------------------------------- | --------------------------------------------------------------------------------------------------- |
| `fetchServerTransport(options)` | Returns `{ transport, handler }` — the gateway owns one, you mount the other                        |
| `FetchHandler` (type)           | `(req: Request) => Promise<Response>`                                                               |
| `Identity` (type)               | `{ principal?, user?, scopes? }` — what your auth returns; the same shape every ingress edge stamps |
| `FetchHandlerOptions` (type)    | `identity`, `security`, `path`, `heartbeatIntervalMs` + the security fields                         |

Transport ids are stable and readable: `http:3000` for a port config, `http:attached` for an adopter-owned server, `http:fetch` for the embedded handler.

## Patterns

**Client-side credentials.** `headers` covers a static token; `fetch` covers a rotating one, because the wrapper runs per request:

```ts
import { http } from "@agentick/transport-http/client";

const authedFetch: typeof fetch = async (input, init) => {
  const token = await getAccessToken(); // refreshes on its own schedule
  return fetch(input, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
};

const transport = http({ url: "https://agents.example.com/rpc", fetch: authedFetch });
```

That is the client attaching _its_ credential. It is unrelated to `authSource`, which authenticates inbound requests on the server.

**Shared plumbing.** [@agentick/transport](../transport) owns `BaseClientTransport` (state machine, RPC correlation, subscription and progress multiplexing, cursor-aware resubscribe, full-jitter backoff), `dispatchRequest`, and the web-security policy. This package is the wire: methods, bodies, and SSE framing.

**Sibling wires.** [@agentick/transport-websocket](../transport-websocket) speaks the same JSON-RPC over a persistent socket, and the two coexist on one Node server. [@agentick/transport-in-process](../transport-in-process) skips serialization entirely for tests and single-process apps.

**Wire shapes.** [@agentick/spec](../spec) owns `ClientTransport`, `ServerTransport`, `AuthSource`, `IngressIdentity`, and the JSON-RPC types.

## Roadmap & known gaps

- **Backpressure is unbounded here.** The bounded-buffer policies live on `MultiplexedStream` in [@agentick/transport](../transport), but this transport constructs subscription and progress streams with the default `unbounded` policy and exposes no per-stream option. A slow consumer behind a fast emitter grows the buffer.
- **No compression.** No `Accept-Encoding` negotiation, no `zlib` on responses. Straightforward to add; not done.
- **`DELETE` is not authenticated.** A configured `authSource` gates `POST` and the `GET` stream open, but not the session teardown. Whoever knows a session id can release its fan-out state.
- **No wall-clock ceiling on authentication.** A hung `AuthSource` leaves the request pending rather than rejecting on a timeout.
- **Sticky-route survival is untested.** The server returns `Mcp-Session-Id`, the client stores it and echoes it, but nothing exercises the client across a load-balancer reshuffle.
- **Notification-stream reconnect is untested here.** The reconnect machinery is shared and covered, but the HTTP-specific "persistent `GET` survives a server bounce" path has no test (the WebSocket package has the equivalent).
- **MCP method namespaces are not served.** The wire follows the Streamable HTTP transport profile; the server does not answer MCP's own method names.

## Verified by

- `src/__tests__/smoke.spec.ts` — `POST` round-trip and `GET` channel against a real gateway, `listApps` reflecting `createApp`, concurrent RPCs on one client, a server error arriving typed (`_tag` preserved), clean close.
- `src/__tests__/transport-conformance.spec.ts` (`runTransportConformance`) — state machine, RPC correlation, pre-connect rejection, `JsonRpcError` → `TransportError`, concurrent multiplexing, `notifications/cancelled` on abort, subscription routing plus `closed` and `evicted`, and progress frames reaching `progress(token)` through the streaming-response path. Exercises the SSE codec end to end.
- `src/__tests__/security.spec.ts` — the CSRF bootstrap handshake, missing and forged token denial, `csrf: false`, cross-site `Origin`/`Sec-Fetch-Site` denial, same-origin admission, `Host` allow-list denial and the `allowedHosts` override, exact-origin CORS echo and disallowed-preflight denial, and a real client round-trip over the loopback bind default.
- `src/__tests__/ingress-authn.spec.ts` (`runIngressAuthnConformance`) — valid bearer stamping a principal, missing and invalid and prototype-key tokens refused at the edge, local pole with no `authSource`, two `POST`s on one session resolving to their own principals, plus the admission-failure event: published on refusal, absent on admission, and carrying no credential material.
- `src/__tests__/server-transport.spec.ts` (`runServerTransportConformance`) — the lifecycle contract for both `httpServerTransport` and `fetchServerTransport` (stable id, bind, teardown, idempotent listen and close, re-listen), plus a real gateway-owned bind: `gateway.listen()` binds the port and a client pings through it, `gateway.close()` frees it.
- `src/__tests__/embedded-fetch-handler.spec.ts` — identity round-trip through the authorizer, `Response` short-circuit reaching nothing, fail-closed default and the `host-managed` opt-out, out-of-scope denial at the dispatch choke point, `GET` SSE plus `sub/subscribe` delivering a frame then tearing down on cancel, cross-site rejection while embedded, a Hono-shaped mount, `gateway.close()` closing live streams, and the pre-listen / post-close `503`.
- Shared-server coexistence — one Node server carrying this transport, the WebSocket transport, a foreign `/health` handler, and a foreign upgrade listener — is verified in [@agentick/transport-websocket](../transport-websocket) (`src/__tests__/shared-server-coexistence.spec.ts`), which drives both transports at once.
- The security policy's full allow/deny matrix and the full-jitter backoff distribution are verified upstream in [@agentick/transport](../transport).
