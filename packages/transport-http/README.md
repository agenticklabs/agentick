# @agentick/transport-http

Streamable HTTP transport for agentick — JSON-RPC 2.0 over a single
endpoint per the **MCP 2025-03-26 Streamable HTTP** spec.

Ships **both ends**: a `fetch`-based client (Node 22+, browser, Bun,
Deno, edge runtimes) and a Node `http.Server`-mountable adapter.

## What this package is

The HTTP fallback for environments where WebSocket is blocked (corporate
proxies, certain CDNs, serverless platforms that don't allow WS upgrade).
Same JSON-RPC 2.0 wire as `@agentick/transport-websocket`; different
HTTP topology.

Subclasses `BaseClientTransport` from `@agentick/transport` — the
extraction in Phase 33.C.1 means HTTP gets state machine, RPC
correlation, subscription multiplexing, notification routing, and
cursor-aware resubscribe for free. The HTTP-specific code is just the
wire (POST / GET / DELETE + SSE parsing).

## Architecture

Streamable HTTP routes everything through one URL using HTTP method
discrimination:

| Method                                       | Purpose                                                                                                                                                                                                        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST <url>`                                 | JSON-RPC request. Response is `application/json` for non-streaming RPCs; `text/event-stream` when the request carries `_meta.progressToken` (server streams `notifications/progress` then the final response). |
| `GET <url>` with `Accept: text/event-stream` | Persistent SSE channel for notifications outside any specific RPC — subscription events, `notifications/auth/expired`, etc.                                                                                    |
| `DELETE <url>`                               | Terminate the server-side session state.                                                                                                                                                                       |

Session affinity via the `Mcp-Session-Id` header — server returns it on
first response; client echoes on subsequent requests. Load balancers
sticky-route by header.

## Quick start

### Client

```ts
import { createClient } from "@agentick/client";
import { http } from "@agentick/transport-http/client";

const client = await createClient({
  transport: http({ url: "https://api.example.com/rpc" }),
});

await client.connect();
const result = await client.request("ping", {});
```

### Server

```ts
import { createServer } from "node:http";
import { createGateway } from "@agentick/gateway";
import { httpServer } from "@agentick/transport-http/server";

const gateway = await createGateway();
const node = createServer();
const server = httpServer({
  httpServer: node,
  gateway,
  allowedOrigins: ["https://my-app.example.com"],
});

node.listen(8080);
```

### Server, gateway-owned (ADR 84 `ServerTransport`)

`httpServerTransport(config)` binds the wire config at construction and
takes the dispatch host at `listen()`. Because `httpServer` mounts on a
caller-supplied Node server, the wrapper owns the port: given `{ port }`
it creates the Node `http.Server` on `gateway.listen()`, mounts the
handler, and binds; `gateway.close()` tears both down.

```ts
import { createGateway } from "@agentick/gateway";
import { httpServerTransport } from "@agentick/transport-http/server";

const gateway = await createGateway({
  transports: [httpServerTransport({ port: 3000, host: "0.0.0.0" })],
});

await gateway.listen(); // creates + binds the node:http server on :3000
// ...
await gateway.close(); // closes the request handler AND the server it created
```

Pass `{ httpServer }` instead of `{ port }` to mount on a server the
adopter already owns (shared with a WS transport, an `https.Server`);
the wrapper does not close what it did not create.

## API surface

### `http(options): ClientTransport`

```ts
interface HttpTransportOptions {
  url: string;
  /** Custom fetch override (auth wrappers, mTLS, etc.). Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  reconnect?: ReconnectPolicy;
  id?: string;
}
```

### `httpServer(options): HttpServerHandle`

```ts
interface HttpServerOptions {
  httpServer: http.Server;
  gateway: GatewayHarnessProtocol;
  path?: string;
  heartbeatIntervalMs?: number;
  // ── Security defaults (STATUS A2 §4c) — safe when omitted, each overridable.
  /** Cross-origin allow-list. Omitted → same-origin only. NEVER `"*"`. */
  allowedOrigins?: readonly string[];
  /** Extra `Host` values beyond loopback + allowedOrigins' hosts. */
  allowedHosts?: readonly string[];
  /** Trust `X-Forwarded-Host`/`-Proto` — only from a loopback peer. Default false. */
  trustProxy?: boolean;
  /** Require the `x-agentick-csrf` token on mutations. Default true. */
  csrf?: boolean;
  /**
   * Ingress authentication (ADR 61). HTTP is stateless, so this runs
   * PER REQUEST — each POST authenticates from its own
   * `Authorization: Bearer` header and that request's identity governs
   * only that request's dispatch (no cross-request bleed). GET/SSE
   * authenticates at stream-open. Rejection → 401. Omitted = anonymous
   * (the local pole).
   */
  authSource?: AuthSource;
}
```

> **Security defaults.** The unconfigured server ships closed (STATUS A2 §4c),
> enforcing a shared `@agentick/transport` policy: cross-site `Origin` /
> `Sec-Fetch-Site` rejection, a `Host` allow-list (loopback + configured only —
> DNS-rebinding defense), non-permissive CORS (an allowlisted origin echoed
> exactly, never `*`), and a per-process CSRF token issued on the GET bootstrap
> handshake and required in the `x-agentick-csrf` header on every mutation. The
> framework client handshakes the token transparently; a raw non-browser caller
> either performs the GET-then-echo handshake or sets `csrf: false`.

### `httpServerTransport(config): ServerTransport`

```ts
// Common path — the wrapper owns the Node http.Server:
type HttpServerTransportPortConfig = Omit<HttpServerOptions, "gateway" | "httpServer"> & {
  port: number;
  host?: string; // bind address; DEFAULT 127.0.0.1 (loopback only — the security boundary)
};
// Or mount on an adopter-owned server:
type HttpServerTransportConfig = HttpServerTransportPortConfig | Omit<HttpServerOptions, "gateway">; // { httpServer, ... }
```

> **Server-side auth (prod edge).** `authSource` authenticates the
> INBOUND request. It is unrelated to the client-side `fetch` example
> below (which attaches the caller's credential). Two POSTs on one
> `Mcp-Session-Id` with different tokens resolve to their own
> principals — the per-session connection state deliberately caches no
> identity.

### `fetchServerTransport(options): { transport, handler }` — the embedded gateway (`@agentick/transport-http/fetch`)

Mount the gateway INSIDE an existing fetch-native HTTP framework (Hono,
Nitro, Next.js route handlers, Bun/Deno) instead of owning a port. The
embedded door is the **fifth `ServerTransport`** (alongside in-process / ws /
http / unix): the gateway owns it, so `gateway.listen()` binds it and
`gateway.close()` sweeps every open SSE connection. Same pipeline as
`httpServer` (`dispatchRequest`, `resolveWebSecurity`, the SSE codec) behind a
web-standard `(req: Request) => Promise<Response>`:

```ts
import { fetchServerTransport } from "@agentick/transport-http/fetch";

// Construct BEFORE the gateway exists, so you can mount the handler in your
// framework's route table at app-setup time.
const { transport, handler } = fetchServerTransport({
  // YOUR auth already ran in YOUR middleware — hand us the RESULT, never tokens.
  identity: async (req) => {
    const user = await myAuth(req); // your session/JWT/cookie check
    if (!user) return new Response(null, { status: 401 }); // your rejection, verbatim
    return {
      principal: user.id, //           → ADR-48 event stamping
      user: { tenantId: user.tenantId }, // → RuntimeContextUser (ctx.user everywhere)
      scopes: user.scopes, //          → the authorizer
    };
  },
});

app.all("/agentick/*", (c) => handler(c.req.raw)); // Hono

const gateway = await createGateway({ transports: [transport] });
await gateway.listen(); // binds the transport (fills the host slot)
// …later: await gateway.close() sweeps open SSE streams + unbinds.
```

`transport.listen(host)` fills the handler's host slot (the one thing only the
gateway can supply, ADR 84 §2 — all other config binds at construction); a
request that arrives **before `listen()` or after `close()`** gets an honest
`503` (typed JSON-RPC `InvalidRequest` body — the gateway enforces
`listen()`-before-`createApp`, so pre-listen traffic is a host-app ordering
bug, never a silent queue).

`identity` is the ONLY difference from standalone HTTP: the host's existing
auth piggybacks here per request. Returning a `Response` short-circuits (the
adopter's 401 / redirect, verbatim); returning an `Identity` (`{ principal?,
user?, scopes? }` — the same `IngressIdentity` every ingress edge stamps)
threads straight into dispatch. Token material NEVER crosses into the
framework.

> **Security is ON by default, even embedded (fail closed).** No `identity`
> callback → every request is REFUSED (`401`, typed `IngressAuthRequired`).
> The single documented opt-out is `security: "host-managed"` — the adopter
> attests their host framework gates access, and requests then run as the
> trusted local pole. The `Host` / `Origin` / CSRF defenses still run against
> the request headers, so serving under a real hostname requires configuring
> `allowedHosts` (security applies MORE when embedded, not less). There is no
> TCP peer on a web `Request`, so `trustProxy` is inert — the adopter's
> framework terminates the connection and owns the network boundary.

## Patterns

### Adopter-supplied `fetch` for auth

```ts
const authedFetch: typeof fetch = async (input, init) => {
  const token = await getAccessToken();
  return fetch(input, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${token}` },
  });
};

const transport = http({ url, fetch: authedFetch });
```

### Streaming response for long-running RPCs

Pass `_meta.progressToken` on the request. The server responds with
`Content-Type: text/event-stream` and streams `notifications/progress`
followed by the final result, all as SSE `data:` frames. Adopters don't
do anything special — the client unpacks the stream transparently and
fans events to the matching `transport.progress(token)` stream.

### Notification channel (subscriptions)

Client opens `GET <url>` with `Accept: text/event-stream` at connect
time and keeps it open. Server pushes `notifications/subscription/event`,
`notifications/auth/expired`, etc. through this channel. Reconnect
re-opens it with exponential backoff and replays subscriptions from
their last cursor (via `BaseClientTransport.resubscribeAfterReconnect`).

## Status

Phase 33.D of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md`.

## Verified by

Every claim in this README has a corresponding test, or appears below
under "Roadmap & known gaps" with an explicit marker.

| Concern                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Test file                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| End-to-end ping, listApps, RPC error → TransportError, multiplexed RPCs, close transition                                                                                                                                                                                                                                                                                                                                                                                                                 | `src/__tests__/smoke.spec.ts`                                                                                  |
| State machine, RPC correlation, multiplexed concurrent RPCs, `notifications/cancelled` emit, subscription routing + close + eviction, progress streams                                                                                                                                                                                                                                                                                                                                                    | `src/__tests__/transport-conformance.spec.ts` (`runTransportConformance` from `@agentick/spec-conformance`)    |
| SSE codec — `encodeSseFrame` + `parseSseFrames`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | covered via the conformance suite's streaming-response path                                                    |
| Per-request ingress authn — valid/invalid/missing bearer, prototype-key guard, no cross-request identity bleed (two POSTs, one session)                                                                                                                                                                                                                                                                                                                                                                   | `src/__tests__/ingress-authn.spec.ts` (`runIngressAuthnConformance`)                                           |
| `httpServerTransport` — `ServerTransport` conformance + real gateway-owned bind (`gateway.listen()` creates + binds the node server, ping round-trips; `gateway.close()` frees the port)                                                                                                                                                                                                                                                                                                                  | `src/__tests__/server-transport.spec.ts` (`runServerTransportConformance`)                                     |
| Security defaults (STATUS A2 §4c) — CSRF bootstrap handshake + missing/invalid-token deny, cross-site `Origin`/`Sec-Fetch-Site` deny, `Host` allow-list deny, non-permissive CORS (allowlisted origin echoed, never `*`), loopback bind default; overrides (`csrf:false`, `allowedOrigins`, `allowedHosts`)                                                                                                                                                                                               | `src/__tests__/security.spec.ts` + policy matrix in `@agentick/transport` `src/__tests__/web-security.spec.ts` |
| Embedded gateway (`fetchServerTransport`) — identity round-trip (dispatch sees the callback's principal), identity `Response` short-circuit, fail-closed default + `security: "host-managed"` local-pole opt-out, scopes denied through the existing `authorizeDispatch` choke point, subscription stream (GET SSE + `sub/subscribe` → frame → teardown), cross-site reject when embedded, Hono-style mount typechecks, `gateway.close()` sweeps live SSE sessions, pre-listen / post-close `503` refusal | `src/__tests__/embedded-fetch-handler.spec.ts`                                                                 |
| Embedded door `ServerTransport` conformance — stable id (`http:fetch`), `listen`/`close` bind + teardown, idempotent listen + close, re-listen after close                                                                                                                                                                                                                                                                                                                                                | `src/__tests__/server-transport.spec.ts` (`runServerTransportConformance("fetchServerTransport", …)`)          |

## Roadmap & known gaps

**Done:**

- ✓ Streamable HTTP routing: POST (JSON or SSE response), GET (persistent SSE), DELETE
- ✓ Session-id propagation via `Mcp-Session-Id` header (sticky-routing-ready)
- ✓ Universal `fetch` on the client side
- ✓ SSE codec with W3C `data:` field handling (multi-line `data:` support, `\r\n\r\n` and `\n\n` separators)
- ✓ Exponential backoff with full jitter reconnect (shared with WS via `BaseClientTransport`)
- ✓ Cursor-aware resubscribe on reconnect (shared with WS via `BaseClientTransport`)
- ✓ Non-permissive CORS via `allowedOrigins` (allowlisted origin echoed exactly, never `*`); OPTIONS preflight handler
- ✓ Security defaults (STATUS A2 §4c): loopback bind default, cross-site `Origin`/`Sec-Fetch-Site` rejection, `Host` allow-list, loopback-only forwarded-header trust, per-process CSRF token (bootstrap handshake + `x-agentick-csrf` on mutations) — each overridable
- ✓ `notifications/cancelled` client emit + server-side routing into per-session abort callbacks

**Claimed but not yet under test (✗):**

- ✗ **`Mcp-Session-Id` echo on reconnect** — server returns the id; client stores it; client echoes on subsequent POSTs. Wire-tested only by the implicit cookie-shaped behavior; no explicit "client survives a sticky-route shuffle" test.
- ✗ **Persistent notification GET reconnect under server bounce** — the reconnect machinery is wired; not exercised by a server-bounce test (unlike WS where `reconnect.spec.ts` covers it).
- ✗ **Per-message-deflate / brotli compression** — not implemented; trivial to add via `Accept-Encoding` + Node `zlib`.
- ✗ **Bilingual MCP** — server doesn't yet implement MCP method namespaces; landing with `@agentick/mcp-surface` (Phase 33.I).

## Development plan

| Step                                | Lands when                                                                                                                                |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 33.D MVP                      | Landed                                                                                                                                    |
| Backpressure wiring                 | Primitive landed in `@agentick/transport` (`MultiplexedStream`); this transport still uses the default `unbounded` policy                 |
| Notification-channel reconnect test | Base reconnect machinery lives in `@agentick/transport`; an HTTP server-bounce test (parallel to WS `reconnect.spec.ts`) is still missing |
| Bilingual MCP support               | Phase 33.I                                                                                                                                |
