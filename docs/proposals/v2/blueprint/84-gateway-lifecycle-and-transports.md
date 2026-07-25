# ADR 84 — Gateway lifecycle, transport ownership, and the gateway op surface

**Status:** ACCEPTED 2026-07-14 (Fable, for Ryan)
**Depends on:** ADR 83 (one interceptor primitive; §4 live inheritance — amended by this ADR's requirement), ADR 61 (ingress authn), ADR 46/51 (wire extensions + dispatch authz).
**Amends:** ADR 83 §4 (frozen construction-fold → live inheritance) and its wire section (`wire:` prefix).

## TL;DR

The gateway is a **Tier-0 stub** today: it can `close()`, but it has no
`start`, owns no transports, and does not propagate its hooks to the apps it
creates. This ADR makes the gateway a real deployment root:

1. **Lifecycle is `listen()` / `close({ drain })`.** The canonical server pair
   (Node `http.Server`, gRPC/k8s). No `destroy()` twin — graceful-vs-forced is a
   `close()` argument, not a second verb.
2. **The gateway owns transports.** A symmetric `ServerTransport` abstraction
   (mirror of `BaseClientTransport`) with wire config bound at construction and a
   uniform `listen(host)`. `gateway.listen()` fans out to every
   `transport.listen(this)`; `gateway.close()` closes each.
3. **Gateway hooks propagate to apps — live.** A hook declared on the gateway
   reaches every app (created before AND after it) and cascades to their sessions
   and sub-harnesses. This is the ADR 83 §4 live-inheritance amendment; the
   gateway is the top edge of the same uniform cascade, not a special case.
4. **The gateway op surface grows** — `gateway:start`, `gateway:close` (renamed
   from `gateway:close-gateway`), `authorizer:authorize`, `gateway:accept`,
   `gateway:create-app` — each hookable through the one seam.

## 1. Lifecycle — `listen()` / `close({ drain })`, no `destroy()`

The gateway is a server. The canonical server lifecycle is a **pair**, and
graceful-vs-forced teardown is a **parameter**, not a second method:

| Precedent | Start | Stop |
| --- | --- | --- |
| Node `http.Server` / `net.Server` | `listen()` | `close()` |
| gRPC / k8s servers | `Start()` | `Stop(grace)` |
| Node `net.Socket` (no graceful drain) | `connect()` | `destroy()` / `end()` |

A gateway HAS a graceful drain, so it takes the `http.Server` shape:

```ts
gateway.listen(): Promise<void>            // fan out to transport.listen(this); flip ready
gateway.close(opts?: { drain?: boolean }): Promise<void>  // terminal; drain-by-default
```

- `listen()` names what start *does* — bind the transports so they listen — and
  reads identically to each `transport.listen()`, keeping the fan-out nominally
  consistent. (`start()` is the acceptable generic if a deployment has no
  transports; `listen()` on zero transports is a no-op that just flips ready.)
- `close()` is the **sole terminal verb** (symmetric with `app.close()`); the
  old `closeGateway()` name is removed — one way to do things. It gains
  `{ drain }`. **No `destroy()`** — shipping both invites "which do I call?" and
  double-teardown bugs, and violates the one-way-to-do-things line.
  `close({ drain: false })` is the forced variant.

Both are hookable ops (§4): `gateway:start` and `gateway:close`.

**`listen()` is REQUIRED before app hosting.** `createApp` is gated on the
started latch and throws `GatewayNotStartedError` until `listen()` has run, so
the `gateway:start` seam is guaranteed to fire before any app mounts. The gate
is a pre-check ahead of the `gateway:create-app` op, so `onBeforeGatewayCreateApp`
never fires on the not-started path. `close()` is NOT gated on started — an
unstarted gateway can still be closed. The canonical flow is therefore
`createGateway(...)` → `await gateway.listen()` → `createApp(...)` →
`await gateway.close()`.

## 2. `ServerTransport` — the missing symmetry

**Status: LANDED — the abstraction + gateway ownership + conformance
(`@agentick/spec` `server/transport.ts`, `@agentick/gateway`,
`@agentick/spec-conformance` `runServerTransportConformance`) AND the
four concrete transport wrappers:**

- **`webSocketServerTransport({ port, host?, … })`** — `@agentick/transport-websocket/server`. Owns the Node `http.Server`: `listen(host)` creates it, attaches `websocketServer`, binds the port; `close()` tears down both. `{ httpServer }` config attaches to an adopter-owned server (not closed).
- **`httpServerTransport({ port, host?, … })`** — `@agentick/transport-http/server`. Same http-server ownership as WS (`httpServer` mounts on a caller-supplied Node server, so the wrapper creates + binds it). `{ httpServer }` config for adopter-owned servers.
- **`unixSocketServerTransport({ path, … })`** — `@agentick/transport-unix-socket/server`. Simplest — `unixSocketServer` binds its own `net.Server`; the wrapper defers the host and awaits `listening`. `close()` closes the socket (Node unlinks the path).
- **`inProcessServerTransport()`** — `@agentick/transport-in-process`. Direct-call transport: no wire to bind, so `listen`/`close` are honest no-ops. Present so an in-process deployment lists its transport alongside the network ones and fan-out stays uniform. Stable id `"in-process"`.

Each wraps the existing `websocketServer` / `httpServer` /
`unixSocketServer` factory (or, for in-process, the direct-call handler)
behind this interface, inverting the shape: **wire config binds at
construction; the host is injected at `listen(host)`.** Each ships
`runServerTransportConformance` plus a real gateway-owned bind test in
its package `__tests__/server-transport.spec.ts`.

The client side has `BaseClientTransport`; the server side has only the loose
`dispatchRequest` + per-transport adapters the adopter wires by hand. Add the
symmetric abstraction (lives in spec — `GatewayHarnessProtocol` directly, NOT
the `transport-next` `DispatchHost` alias, so spec stays dep-free):

```ts
interface ServerTransport {
  readonly id: string;
  listen(host: GatewayHarnessProtocol): Promise<void>; // bind + accept; route inbound via dispatchRequest(host, …)
  close(): Promise<void>;                                // stop accepting, drain
}
```

**Transport-specific config binds at construction, not at `listen()`.** A WS
server needs a port/TLS; a Unix socket needs a path; in-process needs nothing.
That variance does not belong in the `listen()` signature — it is closed over in
the transport's factory, exactly as Node splits `http.createServer(opts)` from
`server.listen(port)` (we push the port into construction too, so the gateway's
fan-out stays uniform):

```ts
webSocketServerTransport({ port: 8080, host: "0.0.0.0", tls })
unixSocketServerTransport({ path: "/run/agentick.sock" })
httpServerTransport({ port: 3000 })
inProcessServerTransport()                       // nothing to bind
```

The **one** thing every transport needs at listen-time that only the gateway can
supply is the `DispatchHost` (the gateway itself). So `listen(host)` is uniform.
An exotic transport that needs late binding closes over a thunk at construction.

**Gateway ownership.** The gateway takes transports through a flat adopter
(the `withX` convention — no `config: {}` nest):

```ts
createGateway({ transports: [webSocketServerTransport({ port: 8080 }), inProcessServerTransport()] })

gateway.listen()  →  await Promise.all(transports.map(t => t.listen(this)))
gateway.close()   →  await Promise.all(transports.map(t => t.close()))
```

**Close ordering (LANDED).** `gateway.close()` closes transports **first** in
its LIFO teardown (`transports → apps → extensions → substrate`). Transports
are the ingress edge; stopping them before apps tear down prevents an inbound
frame from routing `dispatchRequest(this, …)` into a half-closed app. Symmetric
with `listen()`, which binds transports **last** (after gateway-ready seals the
wire registry). Transport close failures are best-effort — one failure never
blocks the rest of teardown. `listen()`'s started-latch short-circuits before
the op fires, so a second `listen()` does NOT re-listen transports.

Concrete server transports route each inbound frame through the existing
`dispatchRequest(this, req, sink, identity)` — the wire seam (ADR 83 wire
section) fires from there. The gateway owns transports the way it owns apps.

## 3. Gateway hooks propagate to apps — live (the §4 amendment realized)

The requirement: a hook declared on the gateway must reach **all** apps — those
created before it and those created after — and cascade on down the chain to
sessions and sub-harnesses. Apps may also declare their own hooks separately.

This is not gateway-specific machinery. It is the ADR 83 §4 cascade made **live**
(frozen construction-fold → live inheritance), applied uniformly at every edge:

- **The name is the routing.** A hook fires wherever an op's name matches it. A
  gateway `onBeforeSessionSend` matches no gateway op (the wire op is
  `wire:session/send` → `WireSessionSend`, §2 of the wire section), so it never
  fires on the gateway — it folds down and fires once at each `session:send`.
  A gateway `onBeforeGatewayStart` matches only `gateway:start` and fires
  locally. No layer classifies hooks as "mine vs not mine"; the op name does it.
- **Live, both directions in time.** Registering on the gateway pushes to every
  live app (and on to their sessions); a newly-created app pulls the gateway's
  current set at construction. Post-creation gateway hooks reach already-running
  apps. Unsubscribe cascades.

The gateway "delegating hooks to apps" is thus realized for free — the gateway
keeps its own (they match its ops) and lets apps take the rest (they match app /
session ops), with zero delegation code. The `createApp` path threads the
gateway into the app as its interceptor parent (the app registers as a live
child), exactly as the app already threads to its sessions.

## 4. The gateway op surface

Each routes through `BaseHarness.runOperation`, so each mints the full triad
(`on<X>` / `onBefore<X>` / `onAfter<X>`) and is `guard`-able:

| Op | Hooks | Purpose |
| --- | --- | --- |
| `gateway:start` | `onGatewayStart` triad | before = gate / feature-flag transports; after = log bound addresses |
| `gateway:close` (was `gateway:close-gateway`) | `onGatewayClose` triad | terminal teardown; symmetric with start |
| `authorizer:authorize` | `onBeforeAuthorize` / `onAfterAuthorize` | the **fine contextual** auth layer (see §5) |
| `gateway:accept` | `onBeforeGatewayAccept` / `onAfter…` | **LANDED.** Per-CONNECTION admission / rate-limit / observe — fired ONCE when a **connection-oriented** transport (WebSocket / Unix socket) accepts a persistent client connection, after ingress-authn, before frames flow. `onBeforeGatewayAccept` throws to REJECT (the transport drops the connection). Request-oriented HTTP does NOT fire it — its admission is the per-request `authorize` path |
| `gateway:create-app` | `onBeforeGatewayCreateApp` / `onAfter…` | multi-tenant gating — veto/transform an app mount |
| `wire:<method>` | `onBeforeWire<Method>` … | the wire boundary (ADR 83 wire section) |

`gateway:close-gateway` → `gateway:close` drops the redundant `Gateway` in the
Pascal suffix (`onGatewayCloseGateway` → `onGatewayClose`), pairing cleanly with
`onGatewayStart`.

## 5. Auth: two layers, refined (not reversed)

Earlier guidance said "the authorizer does not need hooks." That was about the
**structural ceiling** — `requiredScopes`, the coarse pre-gate (`authorizeDispatch`)
— which stays **un-waivable and OUTSIDE the seam**: no hook can widen it. Routing
the `authorize` **op** through `runOperation` adds the **fine contextual layer**
on top of that floor:

- `onBeforeAuthorize` — augment `AuthorizeInput` from request context (add
  contextual scopes) or throw to deny. It can make auth *stricter* or grant
  contextually; it can NEVER waive the ceiling (checked separately, before).
- `onAfterAuthorize` — observe / audit the decision.

Credentials never cross the wire (unchanged): the authorizer and its hooks are
server-resident; only verbs and status project to the client. Ingress
`authenticateIngress` (ADR 61) may take the same before/after treatment for edge
identity enrichment — lower priority, same rules.

## 6. Non-goals / deferred

- **Live inheritance everywhere is now the mechanism** (§3) — this ADR does not
  keep a frozen-fold fast-path. If a deployment wants immutable-after-construction
  interceptor sets, that is a future opt-in, not a parallel code path.
- **Federated / cluster gateways** (multi-node) remain out of scope; this is the
  single-node deployment root.
- **`gateway:accept` per-connection identity plumbing** — LANDED. It rides the
  `ServerTransport` connection lifecycle: the WebSocket and Unix-socket servers
  call `host.accept({ transportId, identity, remoteAddress? })` at the
  connection-accepted point (after ingress-authn, before wiring frames); a
  throwing `onBeforeGatewayAccept` drops the connection. Scoped to
  connection-oriented transports only — HTTP is request-oriented and fires
  `authorize`, not `accept`.

## 7. Rollout

1. Foundation — ADR 83 §4 live inheritance in `base-harness` (children registry,
   push-on-register, pull-on-construct, cascade unsubscribe). Drive workspace green.
2. `wire:` prefix on wire ops (ADR 83 wire section) — kills the collision.
3. Gateway lifecycle — `listen()` / `close({ drain })`; `gateway:start` /
   `gateway:close` ops; thread gateway→app live inheritance in `createApp`.
4. `ServerTransport` abstraction + flat `transports` gateway ownership +
   conformance — **LANDED**. Concrete transport wrappers
   (`webSocketServerTransport` / `httpServerTransport` /
   `unixSocketServerTransport` / `inProcessServerTransport`) — **LANDED**
   (§2), each with conformance + a real gateway-owned bind test.
5. Gateway op surface — `authorizer:authorize`, `gateway:create-app`, and
   `gateway:accept` through `runOperation` — **LANDED**. `gateway:accept` is
   scoped to connection-oriented transports (WebSocket / Unix socket); the
   servers call `host.accept(...)` at connection-accept time and drop the
   connection when `onBeforeGatewayAccept` throws.

Each step ships with conformance + a firing test and updates
[`HOOK-LIFECYCLE.md`](../HOOK-LIFECYCLE.md).
