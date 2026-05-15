# 12 — Gateway (Optional Ingress Wrapper)

**Status:** Synthesized
`[SOURCE: gateway.md, runtime.md, harness-principle.md]`

`@agentick/gateway` is the **optional** ingress wrapper. It exposes the
runtime through network transports (HTTP, WebSocket, SSE, gRPC) without
redefining harness contracts. It is **not** a cluster member; it does
not host session entities. It is a stateless front door.

```
                    ┌────────────────────────────────────┐
                    │              Gateway               │
                    │                                    │
   network req ───► │  HTTP / WS / SSE / RPC adapters    │ ───► harness commands
                    │                                    │
                    │  auth · rate limit · audit ·       │
                    │  transport ↔ harness mapping       │
                    │                                    │
   network resp ◄── │                                    │ ◄─── events / outcomes
                    └────────────────────────────────────┘
                                     │
                                     ▼
                            Runtime (in-process or
                            cluster-routed via 11-cluster.md)
```

`[V1-INHERITED, REFINED]` of v1's `@agentick/gateway` and
`@agentick/express`. Same role, but in v2 it explicitly maps to the
harness command/event surface rather than exposing custom endpoints per
operation.

## What this layer does

- Transport protocol handling (HTTP/WS/SSE/RPC).
- Authentication and request admission.
- Rate limiting and policy enforcement.
- Client connection lifecycle (connect/disconnect/resume).
- Projection of harness commands and events to transport formats.

## What it does NOT do

- Own session execution semantics (session harness).
- Redefine harness contracts (uses them).
- Embed provider/model logic (executor harness).
- Force network deployment (library-only users don't depend on gateway).
- Host session entities (cluster does that, if present).

## Mapping model

```
Client transport message
  ──► gateway validation / auth
  ──► harness command invocation
  ──► harness result / event projection
  ──► transport response / stream
```

Every gateway endpoint maps to a harness command or stream subscription.
The gateway holds no session state of its own.

## Deployment topologies

```
Tier 0 — embedded library (no gateway)
  user code calls App.runOnce(...) directly

Tier 1 — co-located gateway
  gateway and runtime in one Node process; gateway mounts as middleware
  inside the user's HTTP server (Express, Fastify, etc.)

Tier 2 — split gateway fleet
  gateways are a separate fleet, scaling independently from runtime
  nodes. Each gateway routes into the cluster via the cluster's API.
```

These are deployment choices over the same gateway implementation. The
wire protocol between client and gateway is identical across tiers.

## Transports supported

| Transport | Bidirectional | Streaming | Use case |
| --- | --- | --- | --- |
| HTTP + SSE | two channels (POST + SSE) | server→client only | browsers, simple REST clients |
| Streamable HTTP (MCP-style) | one endpoint, upgrades to SSE | server-streamed | browsers, MCP clients |
| WebSocket | native bidirectional | both directions | browsers with bidirectional channels |
| gRPC | native bidirectional via HTTP/2 | both directions | service-to-service, typed |
| Unix socket | TCP semantics, local | both directions | same-machine IPC |
| In-process | direct calls | both directions | embedded SDK, tests |

`[V1-INHERITED]` from v1's transport list. v2 adds streamable HTTP and
optionally gRPC.

Each transport is its own package:

```
@agentick/gateway-http-sse
@agentick/gateway-streamable-http
@agentick/gateway-websocket
@agentick/gateway-grpc
@agentick/gateway-unix-socket
@agentick/gateway-local                  // in-process; testing
@agentick/gateway-express                // [V1-INHERITED] middleware integration
```

## Wire protocol

Above any transport:

- **Frames**: JSON-shaped events conforming to spec event/channel types.
- **Sequence**: monotonic per-session sequence numbers; enables resume.
- **Resume**: client sends last-seen sequence on reconnect; server
  replays from there (requires bounded server-side buffer).
- **Compression**: optional per-transport.
- **Version negotiation**: spec version exchanged at handshake (similar
  to MCP `initialize`).

`[V1-INHERITED]` from v1's existing transport protocol. v2 formalizes
the framing in `@agentick/spec` (see `02-data-model.md` §Channel types).

## Framework channels

The seven framework channels are unchanged from v1
(`packages/shared/src/protocol.ts`):

```
session:messages          — client → server: SendInput
session:events            — server → client: ProtocolEvent stream
session:control           — bidirectional: render command, abort
session:result            — server → client: SendResult
session:tool_confirmation — bidirectional: tool confirmation flow
session:context           — server → client: utilization updates
```

Plus app-wide:

```
session:messages         — well, those are per-session
app:events               — server → client: cross-session ProtocolEvent stream
                           (subject to gateway authorization)
```

`[V1-INHERITED]` exactly. The framework channel set didn't change between
v1 and v2.

User-defined channels (created via `session.channel(name)`) are exposed
through the same gateway, scoped to authorized clients of that session.

## Gateway commands in (per-transport translation)

The gateway exposes a single internal command surface that transport
adapters translate to/from:

```ts
interface GatewayProtocol {
  authenticate(req: AuthRequest):
    Effect<AuthResult, AuthError, GatewayEnv>;

  authorize(ctx: AuthorizedRequest):
    Effect<AuthorizationResult, AuthorizationError, GatewayEnv>;

  proxyCommand(ctx: AuthorizedRequest, command: HarnessCommand):
    Effect<HarnessResult, HarnessError | GatewayError, GatewayEnv>;

  subscribeStream(ctx: AuthorizedRequest, query: EventQuery):
    Effect<Stream<ProtocolEvent>, GatewayError, GatewayEnv>;

  publishChannel(ctx: AuthorizedRequest, channel: string, event: ChannelEvent):
    Effect<void, GatewayError, GatewayEnv>;

  closeConnection(connectionId: string):
    Effect<void, never, GatewayEnv>;
}
```

`[PLACEHOLDER]` shape — synthesized; sign-off needed.

The gateway implementation:

1. Accepts the transport-specific request.
2. Authenticates (extracts identity).
3. Authorizes (checks the request is allowed against the identity).
4. Translates to harness command (or stream subscription).
5. Calls into the runtime (in-process) or cluster (Tier 2).
6. Translates the result/stream back into transport frames.

## Events out

```
gateway:transport:connected           gateway:transport:disconnected
gateway:auth:terminal                 (with outcome)
gateway:rate-limit:applied            (when a request is throttled)
gateway:proxy:requested               gateway:proxy:terminal
gateway:resume:requested              gateway:resume:terminal
```

These emit on `surface: "gateway"` and feed into the same event substrate
as everything else (`10-events-and-interceptors.md`).

## Interceptors

```
authenticate         authorize         proxyCommand
subscribeStream      publishChannel    closeConnection
```

Common uses:

| Interceptor | Use case |
| --- | --- |
| `authenticate` replace | Test-mode bypass with fixture identity |
| `authorize` veto | Deny access to a session not owned by this identity |
| `proxyCommand` proceed (with rewrite) | Inject scope (tenantId from auth) into request |
| `subscribeStream` veto | Hide DevTools events from non-admin clients |
| `publishChannel` defer | Queue if rate-limit hit |

## Outcomes and failures

```ts
type GatewayError =
  | TransportError
  | AuthError
  | AuthorizationError
  | RateLimitError
  | ResumeWindowExceededError
  | InvalidWireFormatError;

interface TransportError {
  _tag: "TransportError";
  transport: string;
  cause: unknown;
}

interface AuthorizationError {
  _tag: "AuthorizationError";
  reason: string;
}

interface ResumeWindowExceededError {
  _tag: "ResumeWindowExceededError";
  requestedSequence: number;
  oldestAvailable: number;
}

interface InvalidWireFormatError {
  _tag: "InvalidWireFormatError";
  reason: string;
}
```

## Resume semantics

Per `[SOURCE: runtime.md (earlier) §Open Question 16]`:

```
Server-side buffer
  ──► retains last N events per session (default: 256)
  ──► or last T seconds (default: 5 minutes)
       whichever cap hits first

Client reconnect with lastSeenSequence
  ──► gateway looks up the session's buffer
  ──► if requested sequence is in buffer:
        replays events from that point
  ──► if older than buffer:
        ResumeWindowExceededError
        client must initiate fresh subscription (or full timeline read)
```

`[PROPOSAL]` defaults; sign-off needed.

In cluster mode, the buffer lives on the node currently hosting the
session entity. Migration carries the buffer (best-effort) but resume
across migration may require fresh start.

## Authentication

The gateway is the preferred layer for:

- Authentication (validate credentials, extract identity).
- Authorization (does this identity own this session?).
- Tenant scoping (set `metadata.tenantId` on session creation).
- Request quotas and rate limits (pre-runtime).
- Audit logging at ingress.

The runtime still enforces critical invariants — gateway is not a trust
bypass. App-level interceptors can re-check authorization.

`[V1-INHERITED, REFINED]` from v1's gateway auth model.

## Session lifecycle through gateway

```
Client connects                       Gateway                      Runtime
──────────────                        ───────                      ───────
WS / HTTP open
                                      authenticate
                                      ◄── identity
                                      
sendCreateSession({ ... })
                                      authorize
                                      proxyCommand:
                                        app.createSession(...)
                                                                    creates Session
                                      ◄── session entity ref
                                      mapping: connectionId → sessionId
                                      
sendMessage({ messages })
                                      proxyCommand:
                                        session.send(...)
                                                                    runs execution
                                                                    streams events
                                      ◄── Stream<ProtocolEvent>
                                      forward as SSE / WS frames
                                      
client disconnects
                                      mark connection idle
                                      runtime keeps session alive
                                      (hibernates per policy)
                                      
client reconnects
                                      authenticate (same identity)
                                      reattach to existing sessionId
                                      resume from lastSeenSequence
                                      ◄── replay
```

The session lives **in the runtime**, not the gateway. Gateways can
terminate independently (rolling restart, autoscaling) without dropping
sessions; clients reconnect to any gateway and resume.

## Multiple gateways, one runtime

```
            ┌─────────┐  ┌─────────┐  ┌─────────┐
            │Gateway A│  │Gateway B│  │Gateway C│
            └────┬────┘  └────┬────┘  └────┬────┘
                 │            │            │
                 └────────────┼────────────┘
                              ▼
                        Runtime (cluster
                        or single node)
```

In production, a gateway fleet fronts the runtime/cluster. Each gateway
is stateless; clients can land on any gateway and the request routes
correctly into the runtime (via the cluster's routing in Tier 2, or
directly to the local runtime in Tier 1).

## Composition with cluster

```
Client → Gateway → Cluster routing → Runtime node hosting session
                  ──────────────
                  cluster handles:
                    - which node hosts session id
                    - activate if hibernated
                    - migrate if node leaves
```

Gateways MAY use the cluster framework for routing (`@effect/cluster`'s
client API) without becoming cluster members themselves. They consume
cluster routing as a service.

## Composition with library mode

In Tier 1, the gateway is mounted **inside** the user's HTTP application:

```ts
import express from "express";
import { createApp } from "@agentick/runtime";
import { createGateway } from "@agentick/gateway";
import { httpSseTransport } from "@agentick/gateway-http-sse";

const app = createApp(<MyAgent />, { ... });
const gateway = createGateway({ app, transports: [httpSseTransport()] });

const server = express();
server.use("/agent", gateway.middleware());
server.listen(3000);
```

`[V1-INHERITED]` of v1's `@agentick/express` integration pattern.

## Streaming and backpressure

The gateway projects per-session and app-wide event streams to clients.
Backpressure rules:

- Per-connection bounded buffer (default: 256 events).
- Slow client → buffer fills → connection back-pressures the upstream
  stream.
- If buffer overflows, the connection is closed with
  `BufferOverflowError`; client must reconnect with `lastSeenSequence`.

Same backpressure model as `10-events-and-interceptors.md` but applied
at the connection boundary.

## Decisions captured

- Gateway is an optional ingress wrapper; library users don't depend on
  it.
- Maps to harness commands; does not redefine them.
- Stateless; sessions live in the runtime.
- Auth/policy at ingress; semantics in runtime.
- Multiple gateways can front one runtime/cluster.
- Resume via per-session bounded buffer + sequence numbers.

## Open questions

- Default transport set for v2 (lean: HTTP+SSE, WebSocket, in-process).
- Resume semantics mandatory vs transport-specific.
- Error envelope standardization (single gateway error schema vs
  transport-native).
- Policy plugin API shape.
- Co-located vs separate fleet operational guidance.
- `GatewayProtocol` exact shape (placeholder; sign-off).
- Server-side buffer defaults (lean: 256 events / 5 min).
