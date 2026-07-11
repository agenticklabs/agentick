# ADR 33 — Client + transports

**Status:** Draft · 2026-06-11 (rev 4)
**Builds on:** ADR 26 (Harness as the single shape), ADR 29 (Bus overhaul — cursor protocol), ADR 31 (Self-similar slottable harness hierarchy), ADR 32 (Extension shape spectrum)
**Companion:** ADR 34 (Auth subsystem — fills the auth slot defined here)
**Touches:** New `@agentick/spec-next/wire/` types, new `@agentick/client-next` package, new `@agentick/transport-*-next` packages, `GatewayHarness` (server-side transport extensions consume frames).

## TL;DR

**The v2 client is a thin proxy over the same harness protocols the server exposes in-process.** Every method on `GatewayHarnessProtocol` / `AppHarnessProtocol` / `SessionHarnessProtocol` becomes a wire RPC. Every event stream becomes a cursor-aware subscription. Nothing else.

- **Wire protocol:** JSON-RPC 2.0 with method-naming conventions, error codes, cancellation, progress, and keepalive all aligned with **MCP 2025-03-26**. We are a **wire-compatible peer of MCP** — same envelope, same Streamable HTTP transport, same `/` method separator, same `notifications/` prefix, same `_meta.progressToken` location, disjoint application namespace. A single JSON-RPC endpoint can host both protocols simultaneously. OpenRPC schema generation is a separate effort, deferred.
- **One `ClientTransport` interface; four impls:** in-process, WebSocket, **Streamable HTTP** (single-endpoint per MCP 2025-03-26), Unix socket. A legacy `http-sse` dual-endpoint variant ships separately. Each transport package exports both client + server (`GatewayExtension`) sides.
- **Extension shape mirrors `BaseHarness`** (chain of responsibility for middleware, handler registry with verdicts for lifecycle decisions) — but **adapted to the client's idioms.** Client middleware is **Promise-native** by default (`(req, next) => Promise<R>`); the harness-style Effect-native signature is available as an opt-in adapter. Subscription middleware is `AsyncIterable`-native to match. Verdict semantics are **per-event**, not the universal `proceed | veto | replace | defer` of command-body wrappers — most client lifecycle events use first-non-null-wins or first-handler-wins.
- **Multi-transport via composite-pattern transports:** `selector([...])` for fallback chains, `multiplexer(transport, {...})` for cross-tab leader-election. Composed transports start in `state: "idle"`; only the active candidate is connected. No factories at the public surface.
- **Auth is a slot, not a baked-in policy.** Each transport carries native auth (Authorization header, WS subprotocol, `SO_PEERCRED`, mTLS client cert, etc.); transport-side adapters normalize to `AuthContext`. ADR 34 defines the full subsystem (OAuth 2.1 + OIDC, JWT with JWKS rotation, DPoP, RBAC/ABAC/ReBAC).
- **Client-bus** mirrors ADR 31's substrate hierarchy on the receive side — observability for connection state, request lifecycle, subscriptions, auth. `client.events()` exposes it. Wire-events stay on their per-resource streams; a `wireMirror()` extension republishes them onto client-bus for devtools / record-replay.

Result: the same API in-process and over the wire. Adopters compose transports + extensions; we ship the small set everyone needs.

## What v1 has and why it's wrong for v2

v1's `AgentickClient` is an ~1800-line god class: transport, session handle proxy, dispatch, event subscription, auth, reconnect, and tab multiplexing all entangled. Four separate transports (SSE, WS, HTTP, Unix socket) each carry copies of similar logic. No cursor protocol — reconnect drops any events that fired during the gap. The shape worked for v1's scope; it doesn't survive multi-tenant cloud, embedded library, OpenClaw-class local agents, or the federation/cluster fleet model.

v2 inverts the design:

1. **Proxy, not god class.** Every method/event stream the server exposes maps 1:1 to wire calls/subscriptions. No bespoke client API.
2. **Cursor protocol native to the wire.** Resume is first-class. Loud-failure backpressure via `CursorEvictedError` (ADR 29).
3. **One pipeline, many extensions.** Same composition story as App / Session / Gateway extensions on the server (ADR 32).
4. **In-process and remote indistinguishable.** Tests and embedded-library deploys use the in-process transport; same API.

## The developer surface

Vercel-flavored composition: small factories, defaults that work, positional-first for the common case, type inference through composition.

### Simplest path

```ts
import { createClient } from "@agentick/client-next";
import { websocket } from "@agentick/transport-websocket-next/client";

const client = createClient({
  transport: websocket({ url: "wss://api.example.com" }),
});

// Flat shortcut for the 90% case
const result = await client.send("sess-123", { messages: [...] }).result;

// Or as an async iterable when you want event-by-event observation
for await (const event of client.send("sess-123", { messages: [...] })) {
  console.log(event);
}
```

Two concepts: `createClient` and a transport factory. Zero required config beyond the wire endpoint.

The accessor form `client.session(id).send(...)` stays for the cases where you want to cache the session reference (UI components subscribed to one session's stream). It returns the same handle shape.

### With auth

```ts
import { bearer } from "@agentick/client-next"; // auth source helpers

const client = createClient({
  transport: websocket({
    url: "wss://api.example.com",
    auth: bearer({ token: async () => fetchTokenFromStore() }), // refresh hook
  }),
});
```

### With extensions

```ts
import { retry } from "@agentick/client-extensions-next/retry";
import { telemetry } from "@agentick/client-extensions-next/telemetry";
import { offline } from "@agentick/client-extensions-next/offline";

const client = createClient({
  transport: websocket({ url, auth }),
  extensions: [
    telemetry({ tracer }), // outermost — sees logical request
    retry({ maxAttempts: 5 }), // retries actual wire attempts
    offline({ store: indexedDbStore() }), // buffers requests when disconnected
  ],
});
```

Extension ordering: **listed-first = outermost.** Convention documented; see "Extension ordering" below.

### Multi-transport (fallback)

```ts
import { selector } from "@agentick/client-next";
import { websocket } from "@agentick/transport-websocket-next/client";
import { http } from "@agentick/transport-http-next/client";

const client = createClient({
  transport: selector([websocket({ url: "wss://..." }), http({ url: "https://..." })], {
    policy: "fallback-on-connect-failure",
  }),
});
```

Array order = priority. Candidates are constructed eagerly but start in `state: "idle"`; selector calls `.connect()` only on the active candidate. No factory wrappers — the transport's own state machine handles deferred connection.

### Multi-tab (multiplexer)

```ts
import { multiplexer } from "@agentick/transport-multiplexer-next";
import { webLocksLeader } from "@agentick/transport-multiplexer-next/web-locks";
import { broadcastChannelBridge } from "@agentick/transport-multiplexer-next/broadcast-channel";

const client = createClient({
  transport: multiplexer(websocket({ url, auth }), {
    leader: webLocksLeader("my-app"),
    bridge: broadcastChannelBridge("my-app"),
  }),
});
```

Two sub-pluggables (leader elector, cross-context bridge) so the same package serves browser tabs, Node `worker_threads`, and any future cross-process need without code duplication. Multiplexer only calls `.connect()` on the inner transport when it wins leader election; followers leave the inner transport in `state: "idle"`.

### Type inference

The handle types flow from the server-side harness types, not from a hand-maintained client-side mirror:

```ts
const session = client.session("sess-123");
//    ^? SessionFacade — derived from SessionHarnessProtocol
const handle = await session.send({ messages: [...] });
//    ^? ClientSessionHandle — extends SessionExecutionHandle
const result = await handle.result;
//    ^? SendResult — same type as in-process
```

In-process and remote: identical types. Generic in the client's auth context shape (`createClient<TAuth>`) so adopter-extended `AuthContext.claims` flow through.

### Extension namespaces — declaration merging

When an extension registers a namespace (`installer.registerNamespace("offline", api)`), that namespace appears typed on the client through TypeScript declaration merging. Same pattern as `HookBridges` augmentation (ADR 27):

```ts
declare module "@agentick/client-next" {
  interface ClientNamespaces {
    offline: { pending(): Promise<Request[]>; flush(): Promise<void> };
    telemetry: { metrics(): SnapshotMetrics };
  }
}

// Then in adopter code:
const client = createClient({ transport, extensions: [offline(...), telemetry(...)] });
await client.offline.flush();         // typed
const m = client.telemetry.metrics(); // typed
```

`@agentick/client-next` ships `ClientNamespaces` as an empty seed (mirrors `HookBridges`). Extension packages augment via `declare module` in their `augment.ts`. The metapackage bundles common extensions' augmentations.

## Wire protocol — JSON-RPC 2.0 (MCP-aligned)

Plain JSON-RPC 2.0 envelopes with conventions deliberately aligned with **MCP 2025-03-26**: same method separator (`/`), same notification prefix (`notifications/`), same long-running-RPC pattern (`_meta.progressToken` + `notifications/progress`), same cancellation (`notifications/cancelled`), same keepalive (`ping`). Same error-code namespace style with disjoint application codes.

The relationship: **wire-compatible peer protocol** with overlapping but disjoint method namespaces. MCP owns `tools/*`, `resources/*`, `prompts/*`, `sampling/*`, `completion/*`, `logging/*`, `initialize`. Agentick owns `gateway/*`, `app/*`, `session/*`, `subscribe`, `unsubscribe`, `auth/*`. A single JSON-RPC endpoint can host both simultaneously without collision.

JSON-RPC inspectors (Postman, Bruno, Insomnia) work out of the box. OpenRPC schema generation is a separate effort (`@agentick/wire-openrpc-next`) — deferred; see Open Questions §6.

### Rejected alternative — `@effect/rpc` as the wire

Tempting, because the substrate is Effect end-to-end (`BaseHarness.runOperation` returns `Effect`, middleware is Effect, typed error channels flow through), and `@effect/rpc` offers schema-first method definitions, generated typed clients, `RpcMiddleware`, and streaming responses. If the agentick client and gateway were the *only* peers that ever spoke this wire, it would be a strong buy.

They are not, and that decides it:

1. **It abandons MCP envelope-parity — the entire point of choosing JSON-RPC 2.0.** `@effect/rpc` uses its own request/response framing and serialization protocol, *not* JSON-RPC 2.0. Adopting it forfeits "wire-compatible peer of MCP — same envelope, one endpoint hosts both" (this section's thesis). The parity is the load-bearing design win; `@effect/rpc` trades it away.
2. **A wire protocol and `@effect/rpc` optimize opposite things.** `@effect/rpc` optimizes *Effect-client-to-Effect-server* ergonomics. A wire's job is *interoperability and independence from any one runtime* — it must be speakable by MCP hosts, AG-UI frontends, plain browser JS, JSON-RPC inspectors, other languages. `@effect/rpc`'s private format leaks Effect into every consumer; JSON-RPC 2.0 stays library-agnostic and inspectable out of the box.
3. **Its benefits are separable from the library.** Typed client → derive from the gateway's method-contract registry (the proxy is already 1:1 with harness protocols). Wire middleware → the client extension pipeline (this ADR) / substrate middleware (ADR 76). Schema validation → Standard Schema. Streaming → the two MCP-aligned patterns above. We *steal `@effect/rpc`'s patterns* (schema-first defs, typed error channels, streaming) on top of JSON-RPC 2.0, without its envelope.

`@effect/rpc` would be **one more wire, not THE wire — and a worse one**, because it costs the MCP parity. Door left cracked: `@effect/rpc` has pluggable `RpcSerialization`, so a JSON-RPC-2.0 serializer is *conceivable* for the native client↔gateway path — but it fights its request/response model against JSON-RPC method/params/id + our streaming-envelope semantics, for a payoff (typed client) obtainable more cheaply from our own registry. Not worth it.

### Rejected alternative — tRPC as the wire

Same disqualifier as `@effect/rpc`, different value prop. tRPC's headline — **end-to-end type inference with no codegen** (the client imports the server's types and gets fully-typed calls) — is genuinely best-in-class DX. But:

1. **tRPC's wire is not JSON-RPC 2.0.** It's tRPC's own HTTP-batching / WS protocol → forfeits MCP envelope-parity (one endpoint hosting both).
2. **TypeScript-only, both ends** → forecloses MCP hosts, other-language clients, any non-tRPC consumer. The wire's job is to be speakable by non-us parties; tRPC optimizes TS-to-TS, the opposite.
3. **The tRPC client requires the tRPC server** — coupled; there is no "tRPC on the client only."

**We take the DX, not the library.** The gateway is already a proxy whose methods are 1:1 with typed harness protocols, so we **derive a typed proxy client from those shared protocol interfaces** (`client.session.send(input)` typed by TypeScript inference across the import boundary) — tRPC's magic, on the JSON-RPC 2.0 wire, keeping MCP parity + multi-language. tRPC gives that typing for free; we build it (a typed proxy + type-derivation from the protocol registry) — bounded work, and the piece that makes the JSON-RPC 2.0 client feel as good as tRPC.

**Principle (both rejections):** steal the typed-client *pattern*; keep the interoperable wire. The wire's consumers include MCP hosts, browser JS, and other languages — none of which speak `@effect/rpc` or tRPC.

### WebSocket subprotocol

WebSocket transports advertise `agentick-rpc-v1` as a subprotocol per RFC 6455. Lets servers version-negotiate at the WS handshake. Wire-format-breaking changes bump the version suffix; client and server must agree before the first frame. (MCP-compatible servers also advertise `mcp` as a parallel subprotocol when they want to accept MCP clients.)

### Method namespaces (no MCP collisions)

| Namespace                   | Owner                | Methods (illustrative)                                                    |
| --------------------------- | -------------------- | ------------------------------------------------------------------------- |
| `gateway/*`                 | agentick             | `listApps`, `getApp`                                                      |
| `app/*`                     | agentick             | `createSession`, `getSession`, `listSessions`, `runOnce`, `close`         |
| `session/*`                 | agentick             | `send`, `render`, `dispatch`, `abort`, `queue`, `snapshot`, `rebind`      |
| `subscribe`, `unsubscribe`  | agentick             | general-purpose persistent subscriptions                                  |
| `auth/*`                    | agentick             | `refresh`, `completeChallenge`, `signOut` (filled by ADR 34)              |
| `ping`                      | shared with MCP      | keepalive                                                                 |
| `tools/*`                   | **reserved for MCP** | agentick servers MAY implement when bundling `@agentick/mcp-surface-next` |
| `resources/*`               | **reserved for MCP** | ditto                                                                     |
| `prompts/*`                 | **reserved for MCP** | ditto                                                                     |
| `sampling/*`                | **reserved for MCP** | ditto                                                                     |
| `completion/*`              | **reserved for MCP** | ditto                                                                     |
| `logging/*`                 | **reserved for MCP** | ditto                                                                     |
| `initialize`, `initialized` | **reserved for MCP** | ditto                                                                     |

Reserved namespaces guarantee non-collision: agentick will not define methods in MCP's namespaces. Bilingual servers (`@agentick/mcp-surface-next`) implement the MCP methods natively and route them through the harness substrate.

### Two streaming patterns, both MCP-aligned

**Execution-bound streams** use the LSP/MCP `$/progress` pattern — client allocates a token in `params._meta.progressToken`; server begins streaming `notifications/progress` immediately; final result returns on the original RPC's `id`. One round trip.

**Persistent subscriptions** use the Ethereum-style `subscribe` RPC returning a server-allocated `subscriptionId`; events arrive as `notifications/subscription/event` notifications correlated by that id. Survives across multiple RPCs.

### Frame examples

#### 1. Simple RPC

```jsonc
// → request
{ "jsonrpc": "2.0", "id": 1, "method": "gateway/listApps", "params": {} }

// ← response
{ "jsonrpc": "2.0", "id": 1,
  "result": { "apps": [{ "id": "app-7", "name": "..." }] } }
```

#### 2. RPC error with structured `data`

```jsonc
// ← response
{
  "jsonrpc": "2.0",
  "id": 2,
  "error": {
    "code": -32010,
    "message": "session not found",
    "data": { "appId": "app-7", "sessionId": "does-not-exist" },
  },
}
```

#### 3. Batch (JSON-RPC 2.0 standard)

```jsonc
// → request batch
[
  { "jsonrpc": "2.0", "id": 3, "method": "gateway/listApps", "params": {} },
  { "jsonrpc": "2.0", "id": 4, "method": "app/listSessions",
    "params": { "appId": "app-7" } }
]

// ← response batch (order need not match)
[
  { "jsonrpc": "2.0", "id": 4, "result": { "sessions": [...] } },
  { "jsonrpc": "2.0", "id": 3, "result": { "apps": [...] } }
]
```

#### 4. Long-running RPC with client-allocated progress token (MCP-aligned)

```jsonc
// → request — client allocates progressToken at params._meta.progressToken
{ "jsonrpc": "2.0", "id": 5, "method": "session/send",
  "params": {
    "sessionId": "sess-123",
    "messages": [...],
    "_meta": { "progressToken": "p-5" }
  } }

// ← notifications — stream immediately, correlated by progressToken
{ "jsonrpc": "2.0", "method": "notifications/progress",
  "params": {
    "progressToken": "p-5",
    "cursor": "evt-00031",
    "envelope": { "surface": "executor", "phase": "delta", "op": "...", "data": {...} }
  } }
// ... many more ...

// ← final response — completes the original RPC
{ "jsonrpc": "2.0", "id": 5,
  "result": {
    "executionId": "exec-abc",
    "finalCursor": "evt-00128",
    "result": { "outputs": {...}, "usage": {...}, "stopReason": "end" }
  } }
```

The `cursor` field on `notifications/progress.params` is the **agentick-specific addition** to MCP's progress shape. MCP's `params` carries `{ progressToken, progress, total? }`; ours carries `{ progressToken, cursor, envelope }`. Both are valid MCP-shaped progress notifications — extra fields are explicitly permitted by JSON-RPC 2.0.

#### 5. Cancellation (MCP-aligned)

```jsonc
// → client cancels in-flight RPC with id 5
{ "jsonrpc": "2.0", "method": "notifications/cancelled",
  "params": { "requestId": 5, "reason": "user-aborted" } }

// ← server may send a terminal error for the cancelled RPC
{ "jsonrpc": "2.0", "id": 5,
  "error": { "code": -32800, "message": "request cancelled" } }
```

#### 6. Persistent subscription (Ethereum-style, agentick namespace)

```jsonc
// → subscribe
{ "jsonrpc": "2.0", "id": 6, "method": "subscribe",
  "params": {
    "scope": { "kind": "session", "id": "sess-123" },
    "query": { "surface": "executor" },
    "fromCursor": "evt-00091"
  } }

// ← server-allocated subscription id
{ "jsonrpc": "2.0", "id": 6, "result": { "subscriptionId": "s-44" } }

// ← events, correlated by subscriptionId
{ "jsonrpc": "2.0", "method": "notifications/subscription/event",
  "params": {
    "subscriptionId": "s-44",
    "cursor": "evt-00092",
    "envelope": {...}
  } }

// ← cursor evicted — server notifies and closes the subscription
{ "jsonrpc": "2.0", "method": "notifications/subscription/evicted",
  "params": {
    "subscriptionId": "s-44",
    "lastCursor": "evt-00400",
    "oldestAvailable": "evt-00800"
  } }

// → client unsubscribe
{ "jsonrpc": "2.0", "id": 7, "method": "unsubscribe",
  "params": { "subscriptionId": "s-44" } }

// ← response
{ "jsonrpc": "2.0", "id": 7, "result": null }
```

#### 7. Auth challenge via RPC error (one round trip to challenge)

```jsonc
// → step-up-required RPC
{ "jsonrpc": "2.0", "id": 8, "method": "session/send", "params": {...} }

// ← error with challenge metadata in data
{ "jsonrpc": "2.0", "id": 8,
  "error": {
    "code": -32030,
    "message": "challenge required",
    "data": {
      "challengeId": "ch-9",
      "method": "mfa-totp",
      "acr": "urn:mace:incommon:iap:silver"
    }
  } }

// → client posts the proof
{ "jsonrpc": "2.0", "id": 9, "method": "auth/completeChallenge",
  "params": { "challengeId": "ch-9",
              "proof": { "type": "totp", "code": "123456" } } }

// ← accepted
{ "jsonrpc": "2.0", "id": 9,
  "result": { "elevated": true, "validUntil": 1717000000 } }

// → retry original
{ "jsonrpc": "2.0", "id": 10, "method": "session/send", "params": {...} }
```

#### 8. Unsolicited auth event (notification)

```jsonc
// ← server-initiated: token revoked
{
  "jsonrpc": "2.0",
  "method": "notifications/auth/expired",
  "params": {
    "reason": "token-revoked",
    "renewable": false,
    "affectedSessions": ["sess-123", "sess-456"],
  },
}
```

#### 9. Keepalive (MCP convention)

```jsonc
// → ping (either direction)
{ "jsonrpc": "2.0", "id": "ping-1", "method": "ping", "params": {} }

// ← pong
{ "jsonrpc": "2.0", "id": "ping-1", "result": {} }
```

### Error code table

Standard JSON-RPC 2.0 reserved codes (-32700 to -32099) for transport / parse / envelope errors. LSP-convention codes (-32800/-32801) for cancellation / content modified. Agentick application codes -32000 to -32099. Codes -32099 to -32050 reserved for adopter overrides.

| Code     | Source         | Meaning                          |
| -------- | -------------- | -------------------------------- |
| `-32700` | JSON-RPC 2.0   | Parse error                      |
| `-32600` | JSON-RPC 2.0   | Invalid request                  |
| `-32601` | JSON-RPC 2.0   | Method not found                 |
| `-32602` | JSON-RPC 2.0   | Invalid params                   |
| `-32603` | JSON-RPC 2.0   | Internal error                   |
| `-32800` | LSP convention | Request cancelled                |
| `-32801` | LSP convention | Content modified                 |
| `-32000` | Agentick       | Unspecified application error    |
| `-32001` | Agentick       | Authentication required          |
| `-32002` | Agentick       | Authentication failed            |
| `-32003` | Agentick       | Insufficient scope / forbidden   |
| `-32010` | Agentick       | Session not found                |
| `-32011` | Agentick       | App not found                    |
| `-32012` | Agentick       | Subscription not found           |
| `-32020` | Agentick       | Cursor evicted                   |
| `-32021` | Agentick       | Operation in progress (conflict) |
| `-32030` | Agentick       | Challenge required (step-up)     |
| `-32031` | Agentick       | Token expired                    |
| `-32040` | Agentick       | Rate limit exceeded              |
| `-32050` | Agentick       | Backpressure — try again later   |

### Cursor

`Cursor` is an opaque string (ADR 29 Phase C). Single-node `LocalEventBus` uses a monotonic integer; cluster mode (Redis Streams / Kafka) uses native stream offsets. The wire never inspects cursors; transports never inspect cursors; only the server-side bus impl produces and consumes them.

### TypeScript surface

```ts
// @agentick/spec-next/wire/index.ts

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: P;
}

export interface JsonRpcResponse<R = unknown> {
  jsonrpc: "2.0";
  id: string | number;
  result?: R;
  error?: JsonRpcError;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: "2.0";
  method: string;
  params?: P;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcFrame = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
export type JsonRpcBatch = readonly JsonRpcFrame[];

// MCP-compatible meta object on request params
export interface RequestMeta {
  progressToken?: string;
}

// ───────── method-bound param shapes ─────────

export interface SessionSendParams {
  sessionId: string;
  messages: readonly ContentBlock[];
  _meta?: RequestMeta;
}

export interface SubscribeParams {
  scope: Scope;
  query?: EventQuery;
  fromCursor?: Cursor;
  _meta?: RequestMeta;
}

export interface SubscribeResult {
  subscriptionId: string;
}

export interface UnsubscribeParams {
  subscriptionId: string;
}

// ───────── notification param shapes ─────────

export interface ProgressNotificationParams {
  progressToken: string;
  cursor: Cursor;
  envelope: EventEnvelope;
}

export interface SubscriptionEventParams {
  subscriptionId: string;
  cursor: Cursor;
  envelope: EventEnvelope;
}

export interface SubscriptionEvictedParams {
  subscriptionId: string;
  lastCursor: Cursor;
  oldestAvailable: Cursor;
}

export interface CancelledParams {
  requestId: string | number;
  reason?: string;
}

export interface AuthExpiredParams {
  reason: string;
  renewable: boolean;
  affectedSessions?: readonly string[];
}

// ───────── error codes as named constants ─────────

export const ErrorCode = {
  // JSON-RPC 2.0 standard
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  // LSP convention
  RequestCancelled: -32800,
  ContentModified: -32801,
  // Agentick application codes
  AppError: -32000,
  AuthRequired: -32001,
  AuthFailed: -32002,
  Forbidden: -32003,
  SessionNotFound: -32010,
  AppNotFound: -32011,
  SubscriptionNotFound: -32012,
  CursorEvicted: -32020,
  Conflict: -32021,
  ChallengeRequired: -32030,
  TokenExpired: -32031,
  RateLimited: -32040,
  Backpressure: -32050,
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
```

Spec owns the wire types; transports import; gateway-side extensions import; `@agentick/client-next` imports. Zero cycles.

### MCP interop — bilingual servers and clients

Three planned extensions exploit the wire-compatible-peer relationship:

| Package                               | Direction                      | Role                                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@agentick/mcp-surface-next`          | server-side `GatewayExtension` | mounts MCP methods (`tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/*`) onto an agentick gateway and answers them by routing through the active session's harnesses. MCP clients (Claude Desktop, Cline, Continue.dev) see a standard MCP server. |
| `@agentick/transport-mcp-client-next` | client-side `ClientTransport`  | connects to a pure MCP server; exposes `client.mcp.tools`, `client.mcp.resources`, etc. namespaces. Agentick clients gain access to the MCP server ecosystem with no extra library.                                                                                        |
| Tool projection                       | shared                         | tools defined via `createTool({ name, description, input: zodSchema })` project automatically to MCP tool descriptors. Same code, two protocols.                                                                                                                           |

Sequenced after Phase 33.F (common middleware) to keep the critical path lean.

## The `ClientTransport` interface

```ts
// @agentick/client-next/src/transport.ts
export interface ClientTransport {
  readonly id: string;
  readonly capabilities: TransportCapabilities;

  connect(): Promise<void>;
  close(): Promise<void>;

  // RPC — single round trip
  request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown>;

  // Subscription — cursor-aware event stream returned as AsyncIterable
  subscribe(
    scope: Scope,
    query?: EventQuery,
    fromCursor?: Cursor,
  ): AsyncIterable<EventFrame> & { close(): Promise<void> };

  // Connection lifecycle for selector / multiplexer / extensions
  onStateChange(handler: (state: TransportState) => void): () => void;
  readonly state: TransportState;
}

export type TransportState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | { kind: "failed"; error: TransportError }
  | "closed";

export interface TransportCapabilities {
  bidirectional: boolean; // true for WS, Unix socket; false for HTTP+SSE
  streamingRequest: boolean; // server can stream notifications during an open RPC
  reconnectable: boolean; // self-reconnect supported
  binaryFrames: boolean; // future: MessagePack/CBOR
}
```

Capabilities expose differences without forcing all transports to behave identically. `selector` reads them; extensions can inspect; spec stays minimal.

## The transports

| Package                                    | Wire                                                                                                                                                                  | When                                                                                                | Capabilities                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `@agentick/transport-in-process-next`      | direct function call                                                                                                                                                  | tests, embedded library (one-process gateway), tentickle TUI ↔ same-process daemon                  | `bidirectional: true`, `streamingRequest: true`, `reconnectable: false`, `binaryFrames: true`                              |
| `@agentick/transport-websocket-next`       | WebSocket, JSON frames                                                                                                                                                | primary browser + server-to-server                                                                  | `bidirectional: true`, `streamingRequest: true`, `reconnectable: true`, `binaryFrames: false` (v1)                         |
| `@agentick/transport-http-next`            | **Streamable HTTP** (MCP 2025-03-26 spec) — single endpoint, POST returns JSON or SSE based on response shape; persistent SSE via `GET` for stand-alone subscriptions | modern HTTP deploys; cooperates with edge/serverless; load-balancer-friendly                        | `bidirectional: false` (asymmetric), `streamingRequest: true` (SSE response), `reconnectable: true`, `binaryFrames: false` |
| `@agentick/transport-http-sse-legacy-next` | HTTP+SSE dual-endpoint (`GET /events` for stream + `POST /rpc/<session-token>` for requests, with sticky session affinity)                                            | environments where Streamable HTTP isn't viable (older load balancers, content-type-strict proxies) | `bidirectional: false`, `streamingRequest: true`, `reconnectable: true`, `binaryFrames: false`                             |
| `@agentick/transport-unix-socket-next`     | newline-delimited JSON over Unix socket                                                                                                                               | local IPC (TUI ↔ local daemon)                                                                      | `bidirectional: true`, `streamingRequest: true`, `reconnectable: true`, `binaryFrames: false`                              |

Each package ships both ends:

- `@agentick/transport-<name>-next/client` — `ClientTransport` impl
- `@agentick/transport-<name>-next/server` — `GatewayExtension` (shape-1 harness extension per ADR 32) that mounts on a `GatewayHarness` and translates wire frames ↔ harness protocol calls

The server side is shape-1 because per-connection state (active subscriptions, cursor positions, auth context, in-flight RPC ids) IS observable substrate the gateway audits.

### Streamable HTTP — endpoint topology

Single endpoint serves both request/response and notification streaming. Same shape as MCP 2025-03-26.

```
POST /rpc
  Content-Type: application/json
  body: JSON-RPC request (or batch)
  response:
    Content-Type: application/json     → single JSON-RPC response (non-streaming RPC)
    Content-Type: text/event-stream    → SSE stream of notifications followed by the final response
                                          (streaming RPC, e.g., session.send returning a subscription token
                                          alongside execution/event notifications)

GET /rpc
  Accept: text/event-stream
  response: persistent SSE stream of JSON-RPC notifications
            (for general-purpose subscriptions independent of an RPC)

DELETE /rpc
  closes the session at the transport level (server cleans up subscriptions, auth context, etc.)
```

Each SSE `data:` line is a JSON-RPC envelope. There is no second wire format anywhere on the transport. Sticky session affinity is handled via a session-token cookie set on the first POST and echoed by clients on subsequent requests.

**CORS / Origin handling.** Streamable HTTP's single endpoint returning either `application/json` or `text/event-stream` complicates pre-built Express/Fastify CORS middleware (CORS preflights cache by URL + method, not by response content-type). The gateway-side transport extension owns CORS handling explicitly — adopters supply `allowedOrigins` / `allowedHeaders` to the transport extension, which handles preflight and adds the right headers on both response shapes. Adopters running behind a reverse proxy (nginx, Cloudflare) handle CORS at the proxy and pass `{ cors: "passthrough" }` to disable transport-side CORS.

### Legacy HTTP+SSE — endpoint topology

Two endpoints. Provided for older infrastructure that can't cleanly handle a single-endpoint, dual-content-type transport.

```
GET /events
  response: persistent SSE stream.
            First event:   { type: "endpoint", data: "/rpc/<session-token>" }
            Subsequent events: JSON-RPC notifications

POST /rpc/<session-token>
  body: JSON-RPC request
  response: JSON-RPC response
```

The initial `endpoint` event encodes sticky session affinity in the URL — subsequent POSTs route to the gateway node that owns the SSE stream. Same pattern v1 used.

### In-process — what direct-pass means

The in-process transport bypasses serialization entirely — frame payloads pass by reference. We're in TypeScript-in-one-process; mutation hazards are mitigated by the substrate's immutable envelope discipline (events are `Readonly<…>`), not by defensive cloning. Cost: zero μs.

`structuredClone` is **not** used: it preserves things JSON wouldn't (Map, Set, Date, ArrayBuffer, RegExp), giving false confidence about wire compatibility. Worse than nothing for that purpose.

Test mode: `inProcess({ wireParity: true })` routes frame bodies through `JSON.parse(JSON.stringify(...))` to catch wire-incompat shapes. Off by default. Adopters using in-process for production / embedded library deploys never pay this cost.

## Extensions — middleware + lifecycle handlers (parallels `BaseHarness`)

The canonical pattern on both sides of the wire is **chain of responsibility for command bodies** (middleware) and **registered handlers for lifecycle decisions** (handler registry). v2 server-side ships this Effect-native in `@agentick/runtime-next/substrate/base-harness.ts` (`Middleware<I, R, E>`, `MiddlewareChain`, `LifecycleHandler<I, R, E>`, `HandlerVerdict`, `HandlerRegistry`). The client uses the **same canonical patterns** at the wire boundary, adapted to client-side idioms — Promise-native by default, with an opt-in Effect adapter for adopters who want the harness-style signature.

### Why the client is Promise-native (and the harness isn't)

|                   | Harness middleware                                                          | Client middleware                                                   |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Substrate         | Effect-native (`runOperation`, FiberRef, Layer)                             | Promise/AsyncIterable native (transports are Promise-based)         |
| Adopter audience  | Framework-internal + advanced extension authors                             | Every adopter writing a `retry()` or `cache()` extension            |
| Composition needs | `Effect.withSpan`, `Effect.retry`, `Effect.timeout`, `FiberRef` propagation | `try`/`catch`, `AbortController`, OTel JS SDK                       |
| Right default     | Effect — substrate IS Effect                                                | Promise — keeps the install-and-write-three-lines path frictionless |

Forcing client extension authors into Effect for what is typically a 10-line `retry({ maxAttempts })` would be an own-goal. The pattern stays canonical (chain of responsibility, outer→inner composition, identical merge semantics where it makes sense); the **representation** differs because the layer's primitive differs.

Adopters who DO want Effect on the client get it via `effectMiddleware(eff)`:

```ts
import { effectMiddleware } from "@agentick/client-next";
import { Effect, Duration } from "effect";

const extension = {
  name: "fancy-retry",
  request: effectMiddleware((input, next) =>
    next(input).pipe(
      Effect.retry({ times: 3, schedule: Schedule.exponential(Duration.millis(50)) }),
    ),
  ),
};
```

`effectMiddleware` is a thin adapter — runs the Effect with a default runtime and bridges to Promise at the boundary. One way for the common case; an explicit upgrade path for adopters who want Effect.

### Middleware — Promise-native canonical signature

```ts
// @agentick/client-next/src/extension.ts
export interface ClientExtension {
  readonly name: string;
  install?(installer: ClientInstaller): void | Promise<void>;

  request?: RequestMiddleware;
  subscribe?: SubscribeMiddleware;
}

export type RequestMiddleware<TResult = unknown> = (
  req: RequestInput,
  next: (req: RequestInput) => Promise<TResult>,
) => Promise<TResult>;

export interface RequestInput {
  readonly method: string;
  readonly params: unknown;
  readonly signal?: AbortSignal;
}

export type SubscribeMiddleware = (
  input: SubscribeInput,
  next: (input: SubscribeInput) => AsyncIterable<EventFrame>,
) => AsyncIterable<EventFrame>;

export interface SubscribeInput {
  readonly scope: Scope;
  readonly query?: EventQuery;
  readonly fromCursor?: Cursor;
}
```

Same chain-of-responsibility shape as `BaseHarness.Middleware`. Different primitive (Promise instead of Effect). Same outer→inner composition rule (`Array.prototype.reduceRight`). Same `(input, next) => result` contract.

### Composition

```ts
// @agentick/client-next/src/pipeline.ts
export function composeRequest(
  extensions: readonly ClientExtension[],
  terminal: (req: RequestInput) => Promise<unknown>,
): (req: RequestInput) => Promise<unknown> {
  return extensions
    .filter((e): e is ClientExtension & { request: RequestMiddleware } => !!e.request)
    .reduceRight<
      (req: RequestInput) => Promise<unknown>
    >((next, ext) => (req) => ext.request(req, next), terminal);
}
```

Outer extension wraps last → executes first → reads top-to-bottom in adopter code. Identical to the `MiddlewareChain.compose` mental model on the server.

### Lifecycle handlers — per-event verdicts, not a universal merge rule

Server-side `BaseHarness` uses one merge rule (`veto > replace > defer > proceed`) because handlers there vote on **command-body wrapping** — a uniform decision space. Client lifecycle events are heterogeneous: voting on reconnect, voting on auth refresh strategy, providing an MFA proof. Forcing one merge rule across all of them is incoherent.

Client uses **per-event verdict types** with **per-event merge rules**, declared alongside the event:

```ts
// @agentick/client-next/src/lifecycle.ts
export interface ClientLifecycleEvents {
  "connection:opening": LifecycleEventSpec<{ transport: ClientTransport }, void, "observer">;
  "connection:opened": LifecycleEventSpec<{ transport: ClientTransport }, void, "observer">;
  "connection:lost": LifecycleEventSpec<
    { reason: TransportError },
    ReconnectDecision,
    "any-reconnect-wins"
  >;
  "auth:expired": LifecycleEventSpec<AuthExpiredInput, AuthExpiredDecision, "first-non-null-wins">;
  "auth:challenge": LifecycleEventSpec<AuthChallenge, ChallengeProof, "first-non-null-wins">;
  "subscription:evicted": LifecycleEventSpec<
    EvictionInput,
    EvictionDecision,
    "first-non-null-wins"
  >;
}

export interface LifecycleEventSpec<TInput, TResult, TMerge extends MergeKind> {
  input: TInput;
  result: TResult;
  merge: TMerge;
}

export type MergeKind =
  | "observer" // result is void; multiple handlers all run; no merge needed
  | "first-non-null-wins" // first handler returning non-null wins; remaining handlers don't run
  | "any-reconnect-wins" // for connection:lost — any "reconnect" vote prevails over "give-up"
  | "verdict-merge"; // BaseHarness-style merge — for events that genuinely have proceed/veto/replace/defer semantics

export type ReconnectDecision = "reconnect" | "give-up";
export type AuthExpiredDecision = "refresh" | "re-authenticate" | "fail";
export type EvictionDecision = "resubscribe-from-oldest" | "resubscribe-from-latest" | "give-up";

export interface ClientExtension {
  // ...
  handlers?: {
    [K in keyof ClientLifecycleEvents]?: LifecycleHandlerFor<ClientLifecycleEvents[K]>;
  };
}

export type LifecycleHandlerFor<S extends LifecycleEventSpec<unknown, unknown, MergeKind>> = (
  input: S["input"],
) => S["result"] | null | undefined | Promise<S["result"] | null | undefined>;
```

The framework picks the merge function based on the event's declared `merge` kind. Adopters never see merge-rule machinery; they return a value (or null to abstain) from their handler. Each event documents its merge rule in the type declaration — no hidden semantics.

For events that genuinely match `BaseHarness`'s verdict shape (future expansion — e.g., middleware-style decisions on request dispatch), `"verdict-merge"` is available and uses the same `mergeVerdict` from runtime. Today's events don't need it.

### Three extension surfaces

| Surface                                 | Use when                                        | Pattern                                  |
| --------------------------------------- | ----------------------------------------------- | ---------------------------------------- |
| **Middleware** (`request`, `subscribe`) | Wrap + transform an operation                   | Chain of responsibility                  |
| **Lifecycle handlers** (`handlers`)     | Vote on a decision (reconnect, refresh, etc.)   | Registered handlers with per-event merge |
| **Bus subscribers** (`install`)         | Pure observation (telemetry, logging, devtools) | Pub/sub                                  |

Same three surfaces `BaseHarness` exposes (middleware + handler registry + bus). Same canonical patterns. Different representations on each layer because the layer's idioms differ.

### `ClientInstaller`

```ts
export interface ClientInstaller {
  readonly clientId: string;
  readonly transport: ClientTransport;        // post-composition; treat as opaque
  readonly bus: EventBus;                     // client-bus — same EventBus type as the server's
  readonly registerNamespace<N extends string, T>(name: N, namespace: T): void;
  readonly onClose(handler: () => void | Promise<void>): void;
}
```

Same shape as `AppInstaller` / `SessionInstaller` / `GatewayInstaller` (ADR 31, ADR 32). Same `registerNamespace` for surface-on-the-client. Same `onClose` for cleanup. Substrate is bus-only.

### `ClientInstaller`

```ts
export interface ClientInstaller {
  readonly clientId: string;
  readonly transport: ClientTransport;        // post-composition; treat as opaque
  readonly bus: EventBus;                     // client-bus — same EventBus type as the server's
  readonly registerNamespace<N extends string, T>(name: N, namespace: T): void;
  readonly onClose(handler: () => void | Promise<void>): void;
}
```

Same shape as `AppInstaller` / `SessionInstaller` / `GatewayInstaller` (ADR 31, ADR 32). Same `registerNamespace` for surface-on-the-client. Same `onClose` for cleanup. The substrate is bus-only (clients don't author operations, so no journal; no inbox until cross-client messaging is a thing).

### Extension ordering

Listed-first = outermost. Same `reduceRight` composition. The convention:

| Extension   | Typical position                  | Why                                                                                    |
| ----------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| `telemetry` | first (outermost)                 | Spans should wrap the logical request, not each wire attempt; metrics see ground truth |
| `auth`      | early                             | Auth state changes are user-facing concerns; surface before retry buries them          |
| `retry`     | middle                            | Retries actual wire attempts; sees errors `cache` and `offline` couldn't handle        |
| `cache`     | middle                            | Returns cached results without hitting `retry` or `offline`                            |
| `offline`   | last (innermost before transport) | Sits just above the wire to buffer when disconnected                                   |

Framework doesn't enforce ordering. Adopters who want different get different.

## Multi-transport composition (composite pattern)

Two composite-pattern transports for the multi-transport cases. Composed transports are passed as instances; the transport's own `state: "idle"` start handles deferred connection.

### `selector` — fallback chain, one active at a time

```ts
export function selector(
  candidates: ClientTransport[], // array order = priority
  options?: SelectorOptions,
): ClientTransport;

export interface SelectorOptions {
  policy?: SelectorPolicy; // default: "fallback-on-connect-failure"
  healthCheck?: { intervalMs: number; method?: string };
}

export type SelectorPolicy =
  | "fallback-on-connect-failure"
  | "fallback-on-disconnect" // also re-evaluate on transport-state transitions
  | "round-robin" // dev/test only
  | { kind: "custom"; choose: (state: SelectorState) => number /* candidate index */ };
```

Candidates are constructed eagerly but `state: "idle"` at start. Selector calls `.connect()` only on the active candidate. The custom-policy hook covers scope-routing, A/B routing, regional preference.

### `multiplexer` — leader-election + cross-context bridge

```ts
export function multiplexer(
  transport: ClientTransport, // started in state: "idle"
  options: MultiplexerOptions,
): ClientTransport;

export interface MultiplexerOptions {
  leader: LeaderElector;
  bridge: CrossContextBridge;
  // Subscription-union strategy — how leader composes followers' interests
  subscriptionStrategy?: SubscriptionUnionStrategy;
}

export interface LeaderElector {
  start(): Promise<void>;
  onElected(handler: () => void | Promise<void>): () => void;
  onResigned(handler: () => void | Promise<void>): () => void;
  resign(): Promise<void>;
}

export interface CrossContextBridge {
  start(): Promise<void>;
  send(target: "leader" | "broadcast", msg: BridgeMessage): void;
  onMessage(handler: (from: string, msg: BridgeMessage) => void): () => void;
}
```

Sub-pluggables for `LeaderElector` (Web Locks browser-side per [W3C Web Locks API spec], file-lock Node-side, Redis-lock for cross-process Node) and `CrossContextBridge` (BroadcastChannel browser-side, `worker_threads` MessagePort Node-side) keep the same package serving every cross-context shape.

Multiplexer only calls `.connect()` on the inner transport when elected leader; followers leave the inner transport in `state: "idle"` and proxy requests via the bridge.

**Correctness properties** (documented for adopters extending the multiplexer):

1. **Subscription-union semantics** — leader subscribes to the OR-superset of followers' queries (a `{ surface: "executor" }` superset covers a follower's `{ surface: "executor", phase: "delta" }`), then filters per-follower client-side. **The general union algorithm for arbitrary `EventQuery` shapes is non-trivial** — surface/phase queries union easily; queries on specific operation IDs, cursor windows, or composite predicates may require subscribing per-follower rather than computing a union. Phase 33.G ships with a simple "union by surface/phase, fall back to per-follower subscription for everything else" strategy; the `subscriptionStrategy` slot lets adopters supply smarter unions. See Open Questions §7.
2. **Cursor coherence** — each follower advances its cursor independently. Leader tracks the highest cursor per scope; on reconnect, leader resumes from the highest. Lagging followers may receive `subscription:evicted` for their own cursors.
3. **Leader failover** — leader-elector transfers leadership atomically; the new leader calls `.connect()` on its inner transport and re-establishes subscriptions for all followers from their last cursors. Brief gap during failover; followers detect via `connection:lost` lifecycle handlers.
4. **Auth handoff** — only leader holds creds. Followers' requests carry no creds; leader applies its own. Multi-account-multi-tab requires separate broker namespaces (separate `BroadcastChannel` names).

## The client-bus

The client gets its own `LocalEventBus` instance — small, in-memory, internal. Extensions emit on it; adopters read it via `client.events(filter?)`.

```ts
// Client-bus event surfaces (initial set)
type ClientEventSurface =
  | "connection" // connection:state transitions
  | "request" // request:sent, request:completed, request:failed
  | "subscription" // subscription:opened, subscription:closed, subscription:evicted
  | "auth" // auth:changed, auth:refresh-required, auth:expired, auth:challenge
  | "extension"; // extension-emitted events (free-form)
```

Same `EventBus` interface as server-side (ADR 29). Same cursor protocol. Same `client.events({ fromCursor })` for resume of _client-internal_ events across reconnects.

### Wire firehose — opt-in

By default, wire events (`ProtocolEvent` from server-side harnesses) flow only through their per-resource streams (`client.session(id).events()`, `client.app(id).events()`, etc.). They do NOT appear on `client.events()`.

For devtools / debug / recording use cases, the `wireMirror()` extension republishes every received `EventFrame` to client-bus under `surface: "wire"`:

```ts
import { wireMirror } from "@agentick/client-devtools-next";

const client = createClient({
  transport: websocket({ url, auth }),
  extensions: [wireMirror()],
});

for await (const ev of client.events({ surface: "wire" })) {
  console.log("wire frame:", ev);
}
```

Off by default — wire-firehose double-publishes and adds GC pressure on high-throughput sessions. Opt-in keeps the default path lean.

## Auth — the slot

Auth is its own subsystem; ADR 34 defines it in full. This ADR establishes only the **slot** transports hand off to.

### Wire side — per-transport auth variants (compile-time enforcement)

Each transport accepts only the auth variants it can carry natively. A single `AuthSource` union forced together with `wsInitFrame` would accept impossible combinations on HTTP transports; the type system should prevent that.

```ts
// @agentick/spec-next/wire/auth.ts
export interface AuthVariants {
  // Universally available
  bearer: { token: string | (() => Promise<string>) };
  custom: { value: unknown };

  // HTTP-flavored (HTTP, WS, Streamable HTTP, SSE)
  headers: { headers: Record<string, string> };

  // WebSocket-only
  wsInitFrame: { payload: unknown };

  // Unix socket-only
  unixPeerCred: {};

  // HTTP and WS
  mtls: { cert: string; key: string; ca?: string };
}

// Each transport declares which variants it accepts
export type AuthSourceFor<T extends TransportKind> = T extends "websocket"
  ? AuthVariantsForKeys<"bearer" | "headers" | "wsInitFrame" | "mtls" | "custom">
  : T extends "http"
    ? AuthVariantsForKeys<"bearer" | "headers" | "mtls" | "custom">
    : T extends "unix-socket"
      ? AuthVariantsForKeys<"unixPeerCred" | "bearer" | "custom">
      : T extends "in-process"
        ? AuthVariantsForKeys<"custom">
        : never;

type AuthVariantsForKeys<K extends keyof AuthVariants> = {
  [Key in K]: { kind: Key } & AuthVariants[Key];
}[K];
```

WebSocket transport accepts `bearer | headers | wsInitFrame | mtls | custom`. HTTP accepts the same minus `wsInitFrame`. Unix socket accepts `unixPeerCred | bearer | custom`. Compile-time error if you pass an incompatible variant.

Token refresh is a hook on each variant that supports it (`bearer.token` is `string | (() => Promise<string>)`); transport invokes it when wire returns 401-equivalent.

### Server side

- Each transport's server-side extension normalizes wire credentials to `AuthContext`.
- `AuthContext` propagates via ALS to every handler.
- ADR 34 defines `AuthMethod` strategies (JWT with JWKS rotation, OAuth 2.1 / OIDC, API key, mTLS, DPoP per RFC 9449), `Authorizer` (RBAC, ABAC, ReBAC) and challenge-response wire flow.

### What's in scope for ADR 33

- Per-transport `AuthSourceFor<T>` shape (the wire-side input).
- Wire methods/notifications reserved for auth: `auth.refresh`, `auth.completeChallenge`, `auth.signOut`, `auth/expired`, `auth/challenge`.
- Per-transport native auth handoff documented in each transport package's README.

Everything else is ADR 34. The variant set may grow as ADR 34 lands (DPoP-bound tokens, OAuth Token Exchange) — the per-transport parameterization makes additions non-breaking.

## Extension catalog

Shapes correspond to the three surfaces from the middleware section: **middleware** (wraps requests / subscribes), **handler** (lifecycle verdicts), **installer** (bus subscriber + namespace registration + onClose). An extension may use any combination.

| Extension                                    | Shape                            | Provider  | Notes                                                                                                                                |
| -------------------------------------------- | -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `@agentick/transport-multiplexer-next`       | composite transport              | framework | cross-tab / cross-process leader-election                                                                                            |
| `@agentick/transport-in-process-next`        | transport                        | framework | direct calls; test mode `{ wireParity: true }`                                                                                       |
| `@agentick/transport-websocket-next`         | transport                        | framework | primary                                                                                                                              |
| `@agentick/transport-http-next`              | transport                        | framework | Streamable HTTP (MCP 2025-03-26 spec); default for HTTP                                                                              |
| `@agentick/transport-http-sse-legacy-next`   | transport                        | framework | dual-endpoint HTTP+SSE for legacy infra                                                                                              |
| `@agentick/transport-unix-socket-next`       | transport                        | framework | local IPC                                                                                                                            |
| `@agentick/client-extensions-next/retry`     | middleware + handler             | framework | exponential backoff, idempotency-key tracking, retryable-error predicate; handler for `connection:lost` votes "reconnect"            |
| `@agentick/client-extensions-next/telemetry` | middleware + installer           | framework | W3C Trace Context propagation, OTel spans per logical RPC, counters; exposes `client.telemetry` namespace                            |
| `@agentick/client-extensions-next/offline`   | middleware + installer + handler | framework | persistent outbound queue (IndexedDB / SQLite); replay on reconnect; handler for `connection:lost` defers in-flight                  |
| `@agentick/client-extensions-next/cache`     | middleware                       | framework | read-through cache for idempotent RPCs; event-driven invalidation via bus                                                            |
| `@agentick/client-devtools-next`             | installer (+ `wireMirror`)       | framework | devtools panel namespace + wire-firehose                                                                                             |
| `@agentick/client-mock-next`                 | transport / middleware           | framework | record-replay for tests                                                                                                              |
| Rate limiter                                 | middleware                       | adopter   | trivial — `(input, next) => throttle(input, next, opts)`                                                                             |
| Compression                                  | middleware                       | adopter   | per-deploy choice of algorithm                                                                                                       |
| E2E encryption envelope                      | middleware                       | adopter   | adopter key-management                                                                                                               |
| Optimistic updates                           | installer                        | adopter   | domain-specific reconciliation                                                                                                       |
| Service worker proxy                         | transport                        | adopter   | browser-specific; survives page refresh                                                                                              |
| `@agentick/mcp-surface-next`                 | server-side `GatewayExtension`   | framework | mounts MCP methods (`tools/list`, `tools/call`, `resources/*`, `prompts/*`) on an agentick gateway. Makes the gateway an MCP server. |
| `@agentick/transport-mcp-client-next`        | transport                        | framework | connects to pure MCP servers. Exposes `client.mcp.*` namespaces.                                                                     |

The framework provides the extension shapes (middleware, handler, installer) — same shapes as `BaseHarness` — plus the small set of common needs. Everything else is adopter territory.

## Package layout

```
@agentick/spec-next
  wire/                                — JsonRpcRequest, JsonRpcResponse, JsonRpcNotification,
                                          SubscribeParams, EventNotificationParams,
                                          Scope, AuthSource, …
  protocol/auth.ts                     — AuthContext, AuthMethod, Decision (full impl in ADR 34)

@agentick/runtime-next                 — (existing) Middleware<I,R,E>, MiddlewareChain,
                                          LifecycleHandler<I,R,E>, HandlerVerdict, HandlerRegistry,
                                          mergeVerdict — REUSED by client-next

@agentick/client-next                  — AgentickClient, createClient,
                                          ClientTransport interface,
                                          ClientExtension (re-exports Middleware, LifecycleHandler),
                                          ClientLifecycleEvents,
                                          ClientNamespaces (empty seed, declaration-merge),
                                          ClientInstaller, client-bus,
                                          selector(), bearer(), headers(), …

@agentick/transport-in-process-next    — direct-call transport (client + server)
@agentick/transport-websocket-next     — WS (client + server)
@agentick/transport-http-next          — Streamable HTTP (client + server)
@agentick/transport-http-sse-legacy-next — legacy dual-endpoint (client + server)
@agentick/transport-unix-socket-next   — Unix socket (client + server)
@agentick/transport-multiplexer-next   — leader-election + bridge (client only — composes any transport)
@agentick/transport-mcp-client-next    — connects to pure MCP servers (client only)

@agentick/mcp-surface-next             — server-side GatewayExtension: mounts MCP methods
                                          on an agentick gateway. Bilingual server.

@agentick/client-extensions-next       — first-party extensions bundle with subpath exports
  /retry                                  — middleware + handler
  /telemetry                              — middleware + installer
  /offline                                — middleware + installer + handler
  /cache                                  — middleware
@agentick/client-devtools-next         — installer + wireMirror
@agentick/client-mock-next             — transport / middleware
@agentick/client-react-next            — (future) React binding (hooks + context provider)
@agentick/client-angular-next          — (future) Angular binding
@agentick/client-vue-next              — (future) Vue binding

(Auth packages — see ADR 34)
@agentick/auth-next
@agentick/auth-jwt-next
@agentick/auth-oauth2-next
@agentick/auth-dpop-next
@agentick/auth-mtls-next
@agentick/auth-rbac-next
@agentick/auth-policy-next             — adapter to Cedar / OPA / OpenFGA / SpiceDB
```

Dependency graph (zero cycles):

```
spec-next                               (wire types, AuthContext, AuthMethod)
  ↑                                       ↑
client-next ──────────────► gateway-next  (gateway has server-side extension surface)
  ↑                                       ↑
transport-*-next/client    transport-*-next/server
  ↑                                       ↑
client-extensions-next/{retry,telemetry,cache,offline}  (first-party client extensions, subpath imports)
```

## Open questions

1. **`session.send` two patterns or one?** Method-bound subscription (RPC returns `subscriptionToken`, events arrive as notifications correlated by token — LSP `$/progress` pattern) is what's drawn here. Alternative: every send opens an explicit subscription (more uniform but two round trips). Recommendation: keep method-bound for execution streams, explicit subscribe for `app.events()` / `gateway.events()`. **Resolved in this ADR — flagged for revisit if implementation reveals friction.**

2. **Cursor format normalization across cluster substrates.** `Cursor` is opaque, but cluster mode's Redis Streams / Kafka cursors are heavier than `LocalEventBus` monotonic ints. Wire size matters for high-volume subscriptions. Worth a benchmark before ADR 29 Phase D lands. **Deferred to ADR 29 Phase D.**

3. **`AuthSource` exhaustiveness.** The variants drawn (`bearer`, `headers`, `wsInitFrame`, `unixPeerCred`, `mtls`, `custom`) cover the standard cases but DPoP and OAuth Token Exchange may want first-class variants. **Deferred to ADR 34.**

4. **Cross-tab failover gap.** Multiplexer leader transition: how long do followers wait before re-electing? Web Locks gives instant transfer; file locks may not. Configurable timeout vs heuristic. **Deferred to implementation.**

5. **Wire compression / binary frames.** JSON over WS is fine to multi-thousand events/sec; beyond that, MessagePack or CBOR. `TransportCapabilities.binaryFrames` is the slot; impls fill it later. **Deferred to post-MVP benchmarking.**

6. **Should the framework expose JSON-RPC tooling integrations (OpenRPC schema generation, JSON-RPC validators) as separate packages?** Likely yes — `@agentick/wire-openrpc-next` for OpenRPC document generation off the harness protocols. **Deferred to post-MVP.**

7. **Multiplexer subscription-union algorithm for arbitrary `EventQuery` shapes.** The phase-33.G simple strategy ("union by surface/phase; per-follower otherwise") is correct but loses the multiplex win for complex queries. A general algorithm requires either (a) a query-normal-form that lets us compute predicate union, or (b) a query-introspection API on the bus that exposes the matcher's structure. **Deferred — track in `@agentick/transport-multiplexer-next`'s open issues.**

8. **`agentick-rpc-v1` subprotocol version bumping.** First wire-breaking change forces `v2`. Coordination story with adopters TBD. **Deferred to first wire-breaking change.**

9. **Higher-level web-framework adapters.** Today `@agentick/transport-http-next` and `@agentick/transport-websocket-next` accept a Node `http.Server` instance and attach via `on("upgrade")` / `on("request")`. That's the universal integration point — it works with Express's `app.listen()`-returned server, NestJS's `app.getHttpServer()`, Fastify's `server.server`, and any other framework wrapping `http.Server`. Bare-Node deploys obviously work too. **Bookmark:** ergonomic per-framework adapter packages (`@agentick/express-next`, `@agentick/nestjs-next`, `@agentick/koa-next`, `@agentick/elysia-next`, `@agentick/hono-next`, `@agentick/fastify-next`) would shave 10-20 lines of boilerplate per framework — useful adoption but not blocking. Each is a small wrapper that mounts `httpServer(...)` / `websocketServer(...)` and exposes a framework-idiomatic API (Express middleware shape, NestJS module, Fastify plugin, Hono `app.route(...)`, Elysia `.use(plugin)`, Koa middleware). **Weigh against:** the universal `http.Server` integration path means adopters can use any framework today by passing the underlying server — adapters are pure ergonomics. Defer until adopter requests surface a specific framework or pattern that the universal path doesn't serve cleanly. Track as a roadmap item, not a phased commitment.

## Sequencing — what ships when

The work is broken into phases that exit cleanly:

**Phase 33.A — Wire + spec types**

- `@agentick/spec-next/wire/` — `WireFrame`, `JsonRpcRequest`, `JsonRpcResponse`, `JsonRpcNotification`, param shapes, `Scope`, `AuthSource`, `TransportCapabilities`, `TransportState`.
- Test: type-only round-trip tests; no impl.

**Phase 33.B — `@agentick/client-next` skeleton**

- `AgentickClient` + `createClient`.
- `ClientTransport` interface, `ClientExtension`, `ClientInstaller`, client-bus.
- Selector transport.
- Middleware composition (request + subscribe pipelines).
- In-process transport (client + server side).
- End-to-end smoke: in-process gateway → in-process transport → client → `session.send` → events → result.
- Conformance suite for `ClientTransport` (any transport must pass).

**Phase 33.C — WebSocket transport**

- Client + server sides.
- Auth slot wired (default `bearer({ token })`).
- Pass conformance suite.
- Pass cursor-resume test.

**Phase 33.D — HTTP transports**

- `@agentick/transport-http-next` (Streamable HTTP, primary).
- `@agentick/transport-http-sse-legacy-next` (legacy dual-endpoint).
- Both pass conformance + cursor-resume.

**Phase 33.E — Unix socket transport**

- Client + server sides.
- Required for tentickle migration.
- Same conformance.

**Phase 33.F — Common extensions**

- `@agentick/client-extensions-next` — subpath bundle with `/retry`, `/telemetry`, `/cache`, `/offline`.
- Each subpath ships with its own README + test suite + prior-art table.
- Establishes the `{layer}-extensions-next` naming convention (reserved `{layer}-{framework}-next` for future React/Angular/Vue bindings).

**Phase 33.G — Multiplexer**

- Web Locks elector + BroadcastChannel bridge.
- Browser-only first.
- Node `worker_threads` flavor later if anyone needs it.

**Phase 33.H — Devtools + mock**

- `client-devtools-next` (wire firehose + namespace).
- `client-mock-next` (record-replay).

**Phase 33.I — MCP interop**

- `@agentick/mcp-surface-next` (server-side `GatewayExtension`): mounts `tools/*`, `resources/*`, `prompts/*` on an agentick gateway. Routes via session's tool executor + reconciler. Agentick gateway becomes an MCP server for any MCP client (Claude Desktop, Cline, Continue.dev, etc.) with one extension install.
- `@agentick/transport-mcp-client-next`: client-side transport that connects to a pure MCP server. Exposes `client.mcp.tools.call(name, input)`, `client.mcp.resources.read(uri)`, etc. Reuses the same `ClientTransport` interface.
- Tool projection: `createTool()` descriptors map automatically to MCP tool descriptors (both Zod-schema-based; trivial mapping).

Auth ADR (34) lands in parallel with 33.B/33.C; auth-impl packages ship after 33.F. MCP interop (33.I) ships after the core transports are stable but can land in parallel with 33.F/33.G/33.H.

## How this lands in CS / engineering terms

| Design element        | Canonical name                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wire format           | JSON-RPC 2.0; agentick is a **wire-compatible peer of MCP** with disjoint method namespace. Same family: LSP, Ethereum RPC.                                                  |
| HTTP topology         | Streamable HTTP (MCP 2025-03-26 spec); legacy HTTP+SSE dual-endpoint with sticky-session affinity (RFC 7230)                                                                 |
| Long-running RPC      | LSP `$/progress` pattern via `_meta.progressToken` + `notifications/progress` (MCP-aligned)                                                                                  |
| Cancellation          | LSP / MCP convention: `notifications/cancelled` with `requestId`                                                                                                             |
| Keepalive             | MCP convention: `ping`/pong RPCs                                                                                                                                             |
| Extension wrapping    | **Chain of responsibility** (GoF); aliases: Koa middleware, Express middleware, hapi extensions, Effect Layers                                                               |
| Composing transports  | **Composite pattern** (GoF)                                                                                                                                                  |
| Lifecycle decisions   | **Observer-with-veto** via `HandlerRegistry` + verdict merge (same as `BaseHarness`)                                                                                         |
| Cross-tab leadership  | **Leader election** via Web Locks API (W3C spec); cross-process variants via Raft / Bully algorithm                                                                          |
| Cursor resume         | **Loud-failure backpressure** via cursor-pull (Kafka / Redis Streams / event-sourcing pattern)                                                                               |
| Client-bus            | **Self-similar substrate hierarchy** (ADR 31) carried down to the receive side                                                                                               |
| Cluster fan-out       | **Sticky session affinity + pub/sub fan-out** (Discord gateway fleet, Slack gateway, Phoenix Channels on BEAM)                                                               |
| Telemetry correlation | **W3C Trace Context** propagation (`traceparent` / `tracestate`) across the client/server boundary                                                                           |
| Auth handoff          | **PEP/PDP separation** per NIST 800-162: transport extension = PEP, Authorizer = PDP; normalized `AuthContext` per Spring Security / Express Passport / NextAuth conventions |

Nothing in this design is novel. The contribution is the **uniform application** of these patterns top-to-bottom (gateway → app → session → client) using the same primitive types (`Middleware`, `HandlerRegistry`, `EventBus`) at every layer.

## Decision

Adopt this design. Ship phases 33.A through 33.E first (wire + skeleton + WebSocket + HTTP + Unix socket); these unblock tentickle migration. Phases 33.F through 33.H follow as common-extension polish. ADR 34 (auth subsystem) drafts in parallel with 33.B/33.C and its impl packages land after 33.F.

Architecture: **proxy + middleware/handler chain + composite transports** — well-known patterns applied uniformly. Adopters get a single mental model that works in-process, over a wire, single-tab, multi-tab, single-machine, or fleet-clustered.
