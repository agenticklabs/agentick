# @agentick/transport

Shared plumbing every `@agentick/transport-*-next` package depends on.

`BaseClientTransport` (abstract) owns the bulk of transport behavior;
concrete transports (in-process, WebSocket, HTTP, Unix-socket) subclass
and supply wire-specific connection management. The shared
`dispatchRequest` resolves JSON-RPC frames through the gateway's
`WireExtension` registry (three bootstrap builtins — `initialize`,
`ping`, `_extensions/list` — dispatch directly; every other method,
including `session/send` and `sub/subscribe`, is a registered
`WireExtension`), authorizes each resolved method at the dispatch choke
point, then invokes its handler — same dispatcher reused across every
transport.

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
                │      (in @agentick/spec)  │
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
} from "@agentick/transport";

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
- `DEFAULT_RECONNECT_POLICY`, `computeFullJitterBackoff`, `ReconnectPolicy` —
  full-jitter reconnect backoff (exported for property-based testing)
- `MultiplexedStream<T>` — AsyncIterable used by subscription + progress
  streams. Per-stream backpressure via `BackpressureOptions<T>`:
  `policy` (`"unbounded"` default / `"drop-oldest"` / `"drop-newest"` /
  `"close-on-overflow"`), `capacity` (required when bounded), `onDrop`,
  `onOverflow`. `close-on-overflow` terminates the stream with a
  `BackpressureError` (`{ kind: "backpressure" }`).
- `BackpressurePolicy`, `BackpressureOptions<T>`, `BackpressureError` — backpressure types
- `ActiveSubscription` — bookkeeping shape for cursor-aware resubscribe

### Server

- `dispatchRequest(host, req, sink, identity?)` — transport-agnostic
  JSON-RPC dispatcher. Resolves each method through the gateway's
  `WireExtension` registry and authorizes it (verb-derived scope label,
  target-session ceiling) before running the handler. The authorized
  handler then routes through `host.runWireDispatch` — the gateway's
  interceptor seam (ADR 83 §wire) — so a wire method fires the gateway's
  guards/hooks (`gateway.hooks.onBeforeWireSessionSend` around the
  `wire:`-prefixed `wire:session/send` op, distinct from the `session:send`
  op's `onBeforeSessionSend`) AFTER the un-waivable auth pre-gate. `identity` is the ingress identity
  stamped at the edge (see below); WS, HTTP, Unix-socket adapters all call
  this. Per-connection state (auth, subscriptions, in-flight ids) lives on
  the adapter, not in the dispatcher.
- `DispatchHost = GatewayHarnessProtocol` — type alias
- `DispatchSink` — contract every connection adapter implements:
  - `sendNotification(notification)` — emit a notification frame to the client
  - `registerSubscription(subId, unsubscribe)` / `unregisterSubscription(subId)`
  - `registerInFlight(id, abort)` / `unregisterInFlight(id)` for `notifications/cancelled` routing
- `resolveWebSecurity(options?)` — the shared HTTP-facing web-security policy
  (STATUS A2 §4c). Single-sources the safe-by-default posture every
  network-facing server edge enforces: `checkAccess` (Host allow-list +
  cross-site `Origin`/`Sec-Fetch-Site` rejection), `checkCsrf` (per-process
  token on mutations), `corsHeadersFor` (allowlisted origin echoed exactly —
  never `*`), `effectivePeer` (forwarded-header trust only from a loopback
  peer). `isLoopbackAddress`, `CSRF_HEADER`, and `DEFAULT_BIND_HOST` are the
  companion exports. See the "Web security defaults" pattern below.

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

### Ingress authentication (ADR 61)

Every transport edge authenticates a trust-boundary crossing through one
shared helper:

```ts
import { authenticateIngress, staticTokenAuthSource } from "@agentick/transport";

const enriched = await authenticateIngress(
  { transportKind: "http", credential: { kind: "bearer", token, headers } },
  options.authSource, // an AuthSource, or undefined
);
// enriched.identity → stamp on the connection / thread into dispatch
```

Rules the helper enforces: **no `AuthSource` → the local/trusted pole**
(identity undefined, admitted); **configured `AuthSource` → run it and
FAIL CLOSED** (a rejection propagates; the edge maps it to a 401 / dropped
connection — it never falls through to the pole). The helper is
**enrichment-only** — it never authorizes (that is the `Authorizer` at
dispatch). `staticTokenAuthSource` is the bundled reference `AuthSource`:
a token → identity table with a prototype-key-bypass guard. The seam is
**server-side only** — `AuthSource` and tokens never project to the
client.

Slice 1 (#146) calls `authenticateIngress` directly at each edge — the
degenerate single-interceptor form. The multi-interceptor
`GatewayInstaller.interceptIngress` chain and the `platform` (federated
connector) credential are later slices.

### Web security defaults (STATUS A2 §4c)

Ingress authn answers _who_ is calling; web security answers _whether the
caller should be able to reach us at all_ — the browser-drive-by / DNS-rebinding
threat model for an exposed loopback server (the opencode CVE class: an exposed
server plus a permissive origin lets any web page drive a shell). One shared
policy backs both HTTP and WebSocket server edges so the posture is uniform:

```ts
import { resolveWebSecurity } from "@agentick/transport";

const security = resolveWebSecurity(options); // options: WebSecurityOptions (flat)

const access = security.checkAccess(req); // host allow-list + cross-site gate
if (!access.ok) reject(access.status); // 403

if (security.csrfEnabled) issue(CSRF_HEADER, security.csrfToken); // bootstrap
const csrf = security.checkCsrf(req); // mutation token gate (HTTP only)
if (!csrf.ok) reject(csrf.status);
```

Defaults, all overridable (`allowedOrigins`, `allowedHosts`, `trustProxy`,
`csrf`) but closed when omitted:

- **Cross-site rejection** — `Sec-Fetch-Site: cross-site` or a foreign `Origin`
  is rejected; a request with neither (a non-browser caller) is admitted.
- **Host allow-list** — loopback names + configured hosts only.
- **Forwarded-header trust** — `X-Forwarded-Host`/`-Proto` honored ONLY when
  `trustProxy` is set AND the immediate peer is loopback (the proxy pattern);
  a direct non-loopback peer cannot spoof past the host check.
- **CSRF token** — per-process random token, issued on the bootstrap handshake
  and required in `x-agentick-csrf` on mutations (HTTP; a WS upgrade is not
  classic-CSRF-vulnerable, so it relies on the unforgeable `Origin`).
- **Non-permissive CORS** — `corsHeadersFor` echoes an allowlisted origin
  exactly; there is no wildcard code path.

Port-owning transports bind `DEFAULT_BIND_HOST` (`127.0.0.1`) unless a `host`
is given — loopback is the security boundary, widened only by explicit opt-in.

## Verified by

| Concern                                                                                         | Test file                                                                                       |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| End-to-end via in-process transport                                                             | `../transport-in-process/src/__tests__/transport-conformance.spec.ts`                           |
| End-to-end via WebSocket transport                                                              | `../transport-websocket/src/__tests__/transport-conformance.spec.ts`                            |
| State machine, RPC correlation, multiplex, cancellation, subscription routing, progress streams | `../spec-conformance/src/transport.ts` (`runTransportConformance` — invoked by every transport) |
| Ingress authn seam — fail-closed, local-pole default, prototype-key guard, once-per-crossing     | `src/testing/index.ts` (`runIngressAuthnConformance` — run by every transport against a real server) |
| `staticTokenAuthSource` credential-kind switch + platform rejection + prototype-key bypass       | `src/__tests__/wire-lane-e2e.spec.ts`                                                           |
| `MultiplexedStream` backpressure — drop-oldest / drop-newest / close-on-overflow / capacity guard | `src/__tests__/multiplexed-stream-backpressure.spec.ts`                                        |
| Full-jitter reconnect backoff bounds                                                             | `src/__tests__/backoff-jitter.spec.ts`                                                          |
| Web-security policy (STATUS A2 §4c) — host allow-list, cross-site rejection, CSRF token, forwarded-header trust (incl. non-loopback-peer spoof deny), never-`*` CORS — allow + deny for each default and each override | `src/__tests__/web-security.spec.ts`                                                            |
| WireExtension registry dispatch, bootstrap short-circuit, `_extensions/list`, `ctx.publish` declared-notification guard | `src/__tests__/wire-extension-dispatch.spec.ts`                              |

`runTransportConformance(name, factory)` in
`@agentick/spec-conformance` ships the shared behavioral suite.
Per-transport tests cover wire-specific concerns (subprotocol
negotiation for WS, peer credentials for Unix socket, etc.).

## Status

Phase 33.C.1 of the v2 implementation plan — see
`docs/proposals/v2/STATUS.md`.

## Roadmap & known gaps

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
- **JSON-RPC batch requests** — `dispatchRequest` is per-frame by
  design; the WS / HTTP / Unix server adapters fan a batch array into
  per-frame dispatch and collect the responses, so batch works
  end-to-end. What's missing is a dedicated batch-semantics test in
  this package (adapters exercise it incidentally).

## Development plan

| Step                               | Status                                                     |
| ---------------------------------- | ---------------------------------------------------------- |
| Phase 33.C.1 — extraction          | Landed                                                     |
| Backpressure on MultiplexedStream  | Landed (per-stream policy on `MultiplexedStream`)          |
| Phase 33.D — HTTP transport        | Landed (`@agentick/transport-http`)                   |
| Phase 33.E — Unix-socket transport | Landed (`@agentick/transport-unix-socket`)            |
| Batch request dispatch             | Works via adapter fan-out (`initialize` advertises `batch: true`); dedicated batch-semantics test still deferred |
