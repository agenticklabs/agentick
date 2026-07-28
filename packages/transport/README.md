# @agentick/transport

**A transport is only its bytes.** Everything above the bytes — RPC correlation, subscription streams and their re-key dance, reconnect backoff, JSON-RPC dispatch, ingress authentication, the web-security posture, the client-facing output bound — lives in this package once and is shared by every wire.

That is why writing a new transport is small: you implement "open the wire", "close the wire", "write a frame", and "here is a frame that arrived". And it is why the wires behave identically — not by convention, but because there is one implementation and a conformance suite that every transport runs. A security default cannot drift between the HTTP edge and the WebSocket edge when both call the same resolver.

## Install

```bash
npm install @agentick/transport
```

Subpaths: `/client` (the base client transport, streams, backoff), `/server` (dispatch, connection context, ingress authn, web security), `/testing` (the ingress-authentication conformance suite).

**`/client` is browser-safe; the root barrel is not.** The root re-exports `/server`, which reaches `node:crypto` and `node:http` — importing it from browser code fails the bundle outright. Client code imports `@agentick/transport/client`, always. Wire facts both halves need (the CSRF header name) live in `src/shared/wire.ts` and are exported from both doors, so neither side has to reach across for a constant. A test sweeps every browser entry point in the workspace and fails on any `node:` builtin reachable through the real import graph.

You install this only when writing a transport. To _use_ one, install the concrete package: [@agentick/transport-websocket](../transport-websocket), [@agentick/transport-http](../transport-http), [@agentick/transport-unix-socket](../transport-unix-socket), or [@agentick/transport-in-process](../transport-in-process).

## Quick start — writing a transport

A transport is two halves that never meet: a client that speaks frames outbound, and a per-connection server adapter that receives them. Both have a base class here, and neither knows anything about agentick's protocol.

### The client half

```ts
import { BaseClientTransport } from "@agentick/transport/client";
import type { ClientTransport, JsonRpcFrame, TransportCapabilities } from "@agentick/spec";

const CAPABILITIES: TransportCapabilities = {
  bidirectional: true, // server can push outside any RPC
  streamingRequest: true, // server can stream during an open RPC
  reconnectable: false, // no self-reconnect on this wire
  binaryFrames: false,
  media: false,
};

class MyTransport extends BaseClientTransport {
  readonly id = "my-transport";
  readonly capabilities = CAPABILITIES;

  protected async openConnection(): Promise<void> {
    this.setState("connecting");
    await this.wire.open();
    this.setState("open");
  }

  protected async closeConnection(): Promise<void> {
    await this.wire.shutdown();
  }

  protected sendFrame(frame: JsonRpcFrame): void {
    this.wire.write(JSON.stringify(frame));
  }

  // Inbound: decode bytes, hand the frame to the base class. It matches
  // responses to pending RPCs and routes notifications to the right
  // subscription or progress stream.
  private onBytes(text: string): void {
    this.routeFrame(JSON.parse(text) as JsonRpcFrame);
  }
}

export function myTransport(options: MyOptions): ClientTransport {
  return new MyTransport(options);
}
```

### The server half

`BaseConnectionContext` is the per-connection adapter. It owns the subscription registry, the in-flight RPC registry, cancellation routing, and the dispatch call; you supply the encoding.

```ts
import { BaseConnectionContext } from "@agentick/transport/server";
import type { IngressIdentity, JsonRpcFrame } from "@agentick/spec";

class MyConnection extends BaseConnectionContext {
  constructor(
    gateway,
    private readonly socket: MySocket,
    identity?: IngressIdentity,
  ) {
    super(gateway, identity);
  }

  protected sendFrame(frame: JsonRpcFrame): void {
    this.socket.write(JSON.stringify(frame));
  }

  protected async closeWire(): Promise<void> {
    this.socket.end();
  }

  // Every decoded inbound frame goes here. Requests get a response to
  // write back; notifications return null.
  async onFrame(frame: JsonRpcFrame): Promise<void> {
    const response = await this.dispatchInbound(frame);
    if (response) this.sendFrame(response);
  }
}
```

That is the whole surface. `close()` on the context iterates both registries and cleans up, so a dropped connection cannot leak a server-side subscription.

## What the client base class already did for you

| Concern                  | Behavior                                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **State machine**        | `connecting` → `open` → `closed`, observable via `onStateChange`.                                             |
| **RPC correlation**      | Request ids allocated, responses matched, errors rejected as typed failures.                                  |
| **Subscription streams** | One `MultiplexedStream` per subscription, routed by server-allocated id.                                      |
| **Progress streams**     | `progress(token)` mints a stream fed by `notifications/progress`, ended by `notifications/progress/complete`. |
| **Cancellation**         | An `AbortSignal` on a request emits `notifications/cancelled` for that id.                                    |
| **Reconnect backoff**    | Full-jitter, capped. `DEFAULT_RECONNECT_POLICY` is the shared shape.                                          |
| **Resubscribe**          | After a reconnect, re-issues each live subscription from its last-seen cursor.                                |

### The subscription id re-key

Subscribing is asynchronous but the caller wants a stream immediately, so the base class hands out a stream keyed by a tentative client-side id, issues the `subscribe` RPC, and re-keys the stream to the server-allocated `subscriptionId` when the response lands. Frames route by the server id from then on, and a stream closed early sends its unsubscribe under the real id.

You get this for free. It matters only if you are debugging why a frame arrived before the id you expected existed.

### Progress tokens are bounded, and say so

A progress token lives for exactly one RPC, so its stream has an end. The server-side reporter's `close()` sends `notifications/progress/complete` — token only, no reason: a bounded stream reaching its end is not a failure, which is why it is a different frame from `notifications/subscription/closed` (server-initiated teardown of an open-ended stream).

On receipt the base class closes the stream, which ends the consumer's iterator and reaps the token's registration. Two things follow, and both are the point: a client `for await` over the stream terminates on its own rather than hanging on a `next()` that will never resolve, and a completed request leaves nothing behind in the registry.

Ordering is the caller's obligation, not the transport's: send the marker after every producer feeding the token has drained, and never before the last `push`. The already-buffered tail is safe — `MultiplexedStream` empties its buffer before signalling done, so a slow consumer still receives every frame pushed before the marker.

### Backpressure is per stream

A stream is unbounded by default. Bound it and pick what gives:

```ts
import { MultiplexedStream, type BackpressureError } from "@agentick/transport/client";

const stream = new MultiplexedStream("events", onClose, {
  policy: "drop-oldest", // "unbounded" (default) | "drop-oldest" | "drop-newest" | "close-on-overflow"
  capacity: 1000, // required whenever the policy is bounded
  onDrop: (value) => metrics.count("stream.dropped"),
});
```

`drop-oldest` keeps the newest values, `drop-newest` keeps the oldest, and `close-on-overflow` terminates the stream with a `BackpressureError` (`{ kind: "backpressure" }`) rather than silently losing data. A bounded policy without a `capacity` is a constructor error, as is a zero, negative, or non-finite one — a bound you forgot to size is a bug, not a default. A consumer already parked in `next()` receives a pushed value directly and never touches the buffer, so the policy only engages under genuine backlog.

## The server dispatcher

`dispatchRequest` turns one JSON-RPC frame into one response. It is transport-agnostic — every adapter calls the same function, so there is no per-transport wire logic to drift.

```ts
import { dispatchRequest, type DispatchSink } from "@agentick/transport/server";

const response = await dispatchRequest(gateway, request, sink, identity);
```

Resolution order: the three bootstrap methods (`initialize`, `ping`, `_extensions/list`) short-circuit **before** the registry lookup, because they must answer before the registry is queryable. Everything else — including `session/send` and `sub/subscribe` — is a registered wire extension resolved through the gateway's registry. A method in neither place is `MethodNotFound`, and a handler that throws becomes a JSON-RPC error response rather than an unhandled rejection.

Each resolved method is **authorized before its handler runs**, then routed through the gateway's operation seam so the dispatch fires the gateway's guards and hooks — after the un-waivable authorization pre-gate, never before. A hook self-scopes by operation: one registered for a different wire method does not fire.

`DispatchSink` is the contract your adapter implements, and it is the only thing the dispatcher knows about your wire:

| Member                                            | Purpose                                             |
| ------------------------------------------------- | --------------------------------------------------- |
| `sendNotification(notification)`                  | Emit a notification frame to the client.            |
| `registerSubscription` / `unregisterSubscription` | Track a live subscription for cleanup.              |
| `registerInFlight` / `unregisterInFlight`         | Route `notifications/cancelled` to the right abort. |

Per-connection state — identity, subscriptions, in-flight ids — lives on the adapter, not in the dispatcher. That is what makes one dispatcher safe to share across every connection of every transport.

Handlers reach the client through their context: `ctx.publish` emits a notification, and it **rejects any notification the extension did not declare** — including the case where it declared none at all. An undeclared notification is a bug at the wire, not a frame to be forwarded.

## Ingress authentication

Every transport edge authenticates its trust-boundary crossing through one helper:

```ts
import { staticTokenAuthSource } from "@agentick/transport";
import { authenticateIngress } from "@agentick/transport/server";

const enriched = await authenticateIngress(
  { transportKind: "http", credential: { kind: "bearer", token, headers } },
  options.authSource, // an AuthSource, or undefined
);
// enriched.identity → stamp on the connection, thread into dispatch
```

Two poles, and the helper enforces the boundary between them:

- **No `AuthSource`** → the local/trusted pole. No identity is stamped, and the crossing is admitted.
- **`AuthSource` configured** → run it and **fail closed**. A rejection propagates so the edge can map it to a 401 or a dropped connection. It never falls through to the pole.

The helper is **enrichment only** — it never authorizes. That is the `Authorizer` at dispatch, and keeping the two apart is what makes "who are you" testable without a policy. `staticTokenAuthSource` is the bundled reference implementation: a token-to-identity table, with a guard so inherited object members (`toString`, `constructor`) are not valid tokens.

An `AuthSource` is adopter code that reaches the network, so the call is bounded: exceeding `timeoutMs` (default 10s, `Infinity` to opt out) refuses the crossing with `IngressAuthnTimeout` and reports it like any other refusal. The ceiling lives here rather than at each edge because the `await` does — an edge that passes no `timeoutMs` is still bounded, which is the point. A hung authenticator would otherwise hang an HTTP request and leak a WebSocket upgrade's socket, one per probe.

```ts
const enriched = await authenticateIngress({ transportKind: "http", credential }, authSource, {
  onRejected: (failure) => host.emitAdmissionFailure?.(failure),
  timeoutMs: 5_000,
});
```

> [!IMPORTANT]
> This seam is **server-side only**. `AuthSource` implementations and token material never project to a client.

### A refused crossing leaves a trace

Admission stays pre-operation: a refused crossing ran no work, so there is nothing to journal. But an audit trail that records nothing while a client probes your edge is worse than useless, so the helper takes a reporter it calls on the rejection path, before rethrowing:

```ts
await authenticateIngress(ingressContext, options.authSource, (failure) =>
  gateway.emitAdmissionFailure({
    ...failure,
    ...(remoteAddress !== undefined ? { remoteAddress } : {}), // the edge knows this; the helper doesn't
  }),
);
```

The helper stays a pure function of its inputs — no bus, no gateway reference, testable with a recording callback. The payload carries the connection **shape** (`failureClass`, `transportKind`, and optionally `connectionId`, `remoteAddress`, `reason`) and **never credential material**: no token, no header bag. The audit trail is the last place a bearer should be durable.

### Scopes narrow at connect, never widen

A client may request a subset of its credential's scopes on the `initialize` frame. The connection applies the **intersection** — effective scopes are the credential's claims ∩ the request — before dispatch, so `initialize` itself and everything after run under the narrowed set.

```ts
await client.request("initialize", { scopes: ["session:send"] }); // drop everything else
```

This is least-privilege for a long-lived connection: a client that only needs to send messages sheds its `knobs:set` claim for the life of the socket. The intersection is cover-aware, so a `session:*` claim survives narrowing to `session:send`. Re-initializing can only narrow **further** — a dropped scope is unrecoverable on that connection, which is what makes the narrowing worth trusting.

> [!NOTE]
> Narrowing is not the security floor. A session's `requiredScopes` ceiling is structural and holds even against a host with no authorizer at all; downscoping only ever removes reach.

## Web security defaults

Ingress authentication answers _who_ is calling. Web security answers _whether this caller should reach us at all_ — the browser drive-by and DNS-rebinding threat model for a server bound to a local port, where an exposed port plus a permissive origin lets any page in the user's browser drive it. One resolver backs both the HTTP and WebSocket edges, so the posture cannot differ between them:

```ts
import { resolveWebSecurity, CSRF_HEADER } from "@agentick/transport/server";

const security = resolveWebSecurity(options); // flat WebSecurityOptions

// Host allow-list + cross-site gate runs FIRST, so a rejected cross-site
// caller never learns the CSRF token.
const access = security.checkAccess(req);
if (!access.ok) return reject(access.status ?? 403);

const cors = security.corsHeadersFor(origin, req); // null unless allow-listed
if (cors) for (const [k, v] of Object.entries(cors)) setHeader(k, v);

if (security.csrfEnabled) setHeader(CSRF_HEADER, security.csrfToken); // bootstrap handshake

const csrf = security.checkCsrf(req); // mutation gate (HTTP)
if (!csrf.ok) return reject(csrf.status ?? 403);
```

Every default is overridable — `allowedOrigins`, `allowedHosts`, `trustProxy`, `csrf` — and every default is closed:

| Default                    | Behavior                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| **Loopback bind**          | `DEFAULT_BIND_HOST` is `127.0.0.1`. A port-owning transport widens only on an explicit `host`.                                          |
| **Host allow-list**        | Loopback names plus configured hosts. A non-loopback or missing `Host` is 403 — the DNS-rebinding defense.                              |
| **Cross-site rejection**   | `Sec-Fetch-Site: cross-site` or a foreign `Origin` is rejected. A request carrying **neither** is a non-browser caller and is admitted. |
| **CSRF token**             | A per-process token issued on the bootstrap handshake, required on every mutation. Reads (GET/HEAD/OPTIONS) need none.                  |
| **Forwarded-header trust** | `X-Forwarded-Host`/`-Proto` honored only when `trustProxy` is set **and** the immediate peer is loopback.                               |
| **Non-permissive CORS**    | `corsHeadersFor` echoes an allow-listed origin exactly.                                                                                 |

> [!WARNING]
> There is no code path that emits `Access-Control-Allow-Origin: *`, and that is deliberate rather than a default you can flip. A wildcard origin on a reachable agent server is the difference between a local tool and a remote shell.

A WebSocket upgrade is not vulnerable to classic CSRF, so the WS edge relies on the unforgeable `Origin` rather than the token.

## Bounding client-facing output

When the gateway opts into truncating tool results, this is where it happens — one funnel, so there is no path that bounds a result while leaking a notification. `projectClientResult` and `projectClientNotification` are the two projectors, and `dispatchRequest` applies them.

They are **pure**: the input is never mutated, so the durable store and the model-facing view keep the full bytes while the client copy is bounded. With no policy configured the boundary does zero work and frames pass through by reference.

You will rarely call these directly; they are exported because a bespoke adapter that bypasses `dispatchRequest` still owes the client the same guarantee.

## Conformance — the point of the shared base

Two suites, and a transport that skips them is not a transport:

```ts
import { runTransportConformance } from "@agentick/spec-conformance";
import { runIngressAuthnConformance } from "@agentick/transport/testing";

runTransportConformance("my-transport", () => myTransport(opts));
runIngressAuthnConformance({
  kind: "websocket",
  credentialModel: "bearer", // or "none" for a host-local wire
  crossingModel: "per-connection", // "per-request" for HTTP
  withServer: (opts, body) => bringUpRealServer(opts, body),
});
```

`runTransportConformance` pins the behavioral contract — state machine, RPC correlation, multiplexing, cancellation, subscription routing, progress streams. `runIngressAuthnConformance` runs against a **real server** and is credential-model aware: bearer transports are asserted on token-to-principal stamping, refusal of a missing or invalid token, the prototype-key bypass, and once-per-crossing isolation (two crossings on one session must not bleed identity); `none`-credential transports like the Unix socket are asserted on host-local trust instead. It also pins the admission-failure event and that its payload carries no credential — so a new transport cannot quietly skip the audit trail.

## API

### `@agentick/transport/client`

| Export                                                             | Purpose                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------- |
| `BaseClientTransport`                                              | The abstract client base. Implement three methods.            |
| `MultiplexedStream<T>`                                             | The `AsyncIterable` behind subscription and progress streams. |
| `DEFAULT_RECONNECT_POLICY` / `computeFullJitterBackoff`            | The shared reconnect backoff, exported for testing.           |
| `ReconnectPolicy` / `ActiveSubscription` (types)                   | Policy shape and resubscribe bookkeeping.                     |
| `BackpressurePolicy` / `BackpressureOptions` / `BackpressureError` | Per-stream backpressure types.                                |
| `transportError(shape)`                                            | A rejection that is both an `Error` and a `TransportError`.   |

### `@agentick/transport/server`

| Export                                                     | Purpose                                       |
| ---------------------------------------------------------- | --------------------------------------------- |
| `dispatchRequest(host, req, sink, identity?)`              | The one JSON-RPC dispatcher.                  |
| `BaseConnectionContext`                                    | The abstract per-connection server adapter.   |
| `DispatchHost` / `DispatchSink` (types)                    | The dispatcher's two contracts.               |
| `authenticateIngress(context, authSource?, options?)`      | The ingress crossing. Enrichment only.        |
| `IngressAuthnOptions` (type)                               | `{ onRejected?, timeoutMs? }`.                |
| `DEFAULT_INGRESS_AUTHN_TIMEOUT_MS` / `IngressAuthnTimeout` | The authn wall-clock ceiling and its refusal. |
| `resolveWebSecurity(options?)`                             | The shared HTTP-facing security policy.       |
| `CSRF_HEADER` / `DEFAULT_BIND_HOST` / `isLoopbackAddress`  | Companion constants and predicate.            |
| `projectClientResult` / `projectClientNotification`        | The client-facing output bounders.            |

### `@agentick/transport/testing`

| Export                                | Purpose                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| `runIngressAuthnConformance(factory)` | Certify an edge's authentication against a real server. |
| `INGRESS_AUTHN_TOKENS`                | The canonical token fixtures the suite uses.            |

## Patterns

**Concrete transports.** [@agentick/transport-in-process](../transport-in-process) is the zero-wire loopback, [@agentick/transport-websocket](../transport-websocket) and [@agentick/transport-http](../transport-http) are the network edges, [@agentick/transport-unix-socket](../transport-unix-socket) is the host-local one. Each is small precisely because this package is not.

**The host.** [@agentick/gateway](../gateway) is the `DispatchHost`: it owns the wire-extension registry the dispatcher resolves through, the `Authorizer` it gates with, and the truncation policy it applies.

**The client.** [@agentick/client](../client) sits on top of a `ClientTransport` and knows nothing about which wire it got.

**Shapes.** [@agentick/spec](../spec) owns `ClientTransport`, `ServerTransport`, `TransportCapabilities`, `AuthSource`, `IngressIdentity`, `Authorizer`, and the JSON-RPC frame types.

**Behavioral suite.** `@agentick/spec-conformance` ships `runTransportConformance`; per-transport tests then cover only what is wire-specific — subprotocol negotiation for WebSocket, peer credentials for the Unix socket.

## Roadmap & known gaps

- **Cursor eviction on resubscribe is not exercised under pressure.** The resubscribe wire path works and the evicted-cursor path is wired in the base class, but proving it needs a fixture with tight bus retention, and that fixture does not exist. Out-of-retention cursors are intended to fail loudly through `notifications/subscription/evicted`.
- **Server-side cancellation depends on the adapter.** `DispatchSink` ships `registerInFlight`/`unregisterInFlight` and the WebSocket adapter wires them. The in-process server has no single adapter — handlers are adopter-supplied — so cancellation propagation there depends on how those handlers are written.
- **No batch-semantics test in this package.** `dispatchRequest` is per-frame by design; the concrete adapters fan a batch array into per-frame dispatch and collect responses, so batching works end-to-end and `initialize` advertises it. What is missing is a test that pins the semantics here rather than incidentally in an adapter.
- **The ingress chain is a single interceptor.** Each edge calls `authenticateIngress` directly — the degenerate one-link form. A multi-interceptor chain, and a federated `platform` credential kind, are not built; `staticTokenAuthSource` explicitly rejects the platform credential rather than mishandling it.
- **`media` capability is declared but has no in-band lane.** Transports report `media: false` today; the flag exists so a media-capable transport can be feature-detected when one lands.

## Verified by

- `src/__tests__/web-security.spec.ts` — every default and every override, allow **and** deny for each: loopback predicate across the whole `127.0.0.0/8` block, host allow-list rejecting a rebinding host and a missing `Host`, cross-site rejection admitting a non-browser caller while denying a foreign `Origin`, the CSRF token on mutations but not reads, forwarded-header trust denying a spoof from a non-loopback peer, and that no wildcard CORS code path exists.
- `src/__tests__/wire-extension-dispatch.spec.ts` — registry routing, `MethodNotFound` for unknown methods, handler exceptions becoming error responses, `_extensions/list` including the no-registry case, the bootstrap short-circuit landing before the registry lookup, `ctx.session`/`ctx.app` resolution from params, and `ctx.publish` rejecting undeclared notifications.
- `src/__tests__/wire-dispatch-seam.spec.ts` — a gateway wire hook firing exactly once around dispatch, self-scoping by operation, and authorization rejecting **before** the seam.
- `src/__tests__/wire-declarative-auth.spec.ts` — verb-scope default, `required: false` skipping policy, additive roles, the anti-bypass rule that a role alone never reaches the verb, and `required: false` failing to waive a session's structural ceiling.
- `src/__tests__/wire-lane-e2e.spec.ts` — against a real gateway and session: a granted principal round-tripping `timeline/compact`, gated discovery, an addressable-but-not-wire verb returning `MethodNotFound` even when granted, Forbidden for ungranted and anonymous callers, exact-beats-dynamic on a real registry, the same-principal rule denying cross-principal access, prototype-key bypass rejection, `allowAnonymous` admitting the `none` credential, and the full scope-refinement story — `initialize` narrowing claims, cover-aware glob intersection, re-initialize only narrowing further, and the session ceiling holding with no authorizer present.
- Subscription teardown through `BaseConnectionContext` — `unregisterSubscription` running the registered cleanup rather than dropping the entry, so `sub/unsubscribe` releases the server-side stream — is verified in [@agentick/transport-in-process](../transport-in-process) (`src/__tests__/connection-teardown.spec.ts`), which drives it against a real gateway.
- `src/__tests__/ingress-timeout.spec.ts` — the wall-clock ceiling: a never-settling `AuthSource` refused, the refusal an `Error` naming its ceiling and leaving an admission-failure trace with no credential material, the 10s default applied when a caller configures none, `Infinity` opting out, and a rejecting source still surfacing its own error.
- `src/__tests__/authorize-seam.spec.ts` — a contextual scope flipping a policy deny to allow, and the structural ceiling denying regardless while the hook never fires.
- `src/__tests__/session-principal.spec.ts` — the owning principal stamped from the edge onto both harness and record, a body-smuggled principal ignored, an unauthenticated create left unstamped, and the same-principal gate engaging on the stamped value.
- `src/__tests__/wire-identity-hook.spec.ts` — a hook reading `ctx.identity` and overriding a smuggled principal, identity absent when unauthenticated, a handler reading the full structured identity, and a non-wire operation seeing none.
- `src/__tests__/wire-command-e2e.spec.ts` — a wire method as a full command: journaled operation, typed hook transform, middleware, span attributes, live context facets, and define-time guard verdicts mapping to Forbidden and rate-limited at the JSON-RPC edge with the handler never running.
- `src/__tests__/client-projection.spec.ts` — each bounded path for results and notifications, unknown methods passing through by reference, no input mutation, the default-off zero-overhead path, raised and infinite ceilings, and the two-tier proof that the client copy is bounded while store and model views keep full bytes.
- `src/__tests__/multiplexed-stream-backpressure.spec.ts` — unbounded never dropping, capacity validation, drop-oldest and drop-newest eviction order, close-on-overflow terminating with a backpressure error and ignoring later pushes, and a parked consumer bypassing the buffer.
- `src/__tests__/backoff-jitter.spec.ts` — full-jitter shape: per-attempt bounds, cap doubling to the maximum, never exceeding it, uniform distribution across the range, and reproducibility under an injected RNG.
- `src/testing/index.ts` (`runIngressAuthnConformance`) and `@agentick/spec-conformance`'s `runTransportConformance` — run by every concrete transport against a real server; see [@agentick/transport-websocket](../transport-websocket) and [@agentick/transport-in-process](../transport-in-process) for the invocations.
