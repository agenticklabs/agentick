# @agentick/client-next

Canonical TypeScript implementation of the agentick `ClientProtocol`.

Runs in **Node 22+, browsers, Bun, Deno, and edge runtimes** — zero DOM
assumptions, zero platform-specific imports. The client is a thin proxy
over the same harness protocols the server exposes in-process, so
adopters write the same code regardless of whether they're talking to a
gateway in the same process or across the wire.

## What this package is

`ClientProtocol` is **the TypeScript contract** that lives in
`@agentick/spec-next/client`. **Multiple implementations can conform**:

- `@agentick/client-next` (this package) — the canonical impl
- a test mock implementing the same interface
- a future Worker-thread proxy that runs the real client in a Worker
  and surfaces the protocol on the main thread
- adopters who need bespoke shapes for their environment

Applications that consume a `ClientProtocol` (a TUI, a web app, a CLI)
do not depend on this package's internals — they depend on the
interface in spec.

The wire that crosses the network is defined in
`@agentick/spec-next/wire` (JSON-RPC 2.0, MCP-aligned). Non-TypeScript
clients (Python, Go, Rust, Swift) speak that wire directly without
touching this package.

## Architecture

```
                    ┌────────────────────────────────┐
                    │ Application (TUI, web, CLI…)   │
                    └───────────────┬────────────────┘
                                    │ uses
                                    ▼
                    ┌────────────────────────────────┐
                    │ ClientProtocol (in spec/client)│
                    │   ──── implemented by ────     │
                    │ @agentick/client-next          │   ← this package
                    └───────────────┬────────────────┘
                                    │ uses
                                    ▼
                    ┌────────────────────────────────┐
                    │ ClientTransport (in spec/client)│
                    │   ──── implemented by ────     │
                    │ @agentick/transport-*-next     │
                    └───────────────┬────────────────┘
                                    │
                                    ▼
                    ┌────────────────────────────────┐
                    │ JSON-RPC 2.0 wire              │
                    │ (in spec/wire)                 │
                    └────────────────────────────────┘
```

## Quick start

```ts
import { createClient } from "@agentick/client-next";
import { inProcessTransport } from "@agentick/transport-in-process-next";
// or: import { websocket } from "@agentick/transport-websocket-next/client";

const client = await createClient({
  transport: inProcessTransport({ handler: myHandler }),
});

await client.connect();

// Flat shortcut for the 90% case
const result = await client.send("sess-123", {
  messages: [{ role: "user", content: "hello" }],
}).result;

// Or as an async iterable for event-by-event observation
for await (const event of client.send("sess-123", { messages: [...] })) {
  console.log(event);
}

await client.close();
```

## API surface

### `createClient(options): Promise<Client>`

```ts
interface CreateClientOptions {
  transport: ClientTransport;
  extensions?: readonly ClientExtension[];
  id?: string;
}
```

Returns a `Client` (= `ClientProtocol` widened with any extension-registered namespaces via `ClientNamespaces` declaration merging).

### Resource handles

- `client.gateway()` → `GatewayHandle` (`listApps`, `getApp`, `events`)
- `client.app(id)` → `AppHandle` (`createSession`, `listSessions`, `runOnce`, `events`)
- `client.session(id)` → `SessionHandle` (`send`, `dispatch`, `abort`, `queue`, `snapshot`, `events`)

Shapes mirror the in-process `GatewayHarnessProtocol` / `AppHarnessProtocol` / `SessionHarnessProtocol`.

### Extensions

```ts
import type { ClientExtension } from "@agentick/spec-next";

const retry: ClientExtension = {
  name: "retry",
  async request(req, next) {
    for (let i = 0; i < 3; i++) {
      try { return await next(req); }
      catch (e) { if (i === 2) throw e; }
    }
    throw new Error("unreachable");
  },
};

const client = await createClient({ transport, extensions: [retry] });
```

Three surfaces:

- **`request` / `subscribe` middleware** — chain of responsibility wrapping wire calls. Promise-native; outer→inner composition (first in array = outermost). Use `effectMiddleware()` for an Effect-flavored alternative.
- **Lifecycle handlers** — `connection:lost`, `auth:expired`, `subscription:evicted`, `rpc:error`. Per-event merge rules (`observer` / `first-non-null-wins` / `any-reconnect-wins`).
- **`install(installer)`** — bus subscriber + namespace registration + onClose handlers.

Adopters extending the public surface:

```ts
declare module "@agentick/spec-next" {
  interface ClientNamespaces {
    offline: { pending(): Promise<Request[]>; flush(): Promise<void> };
  }
}
```

### `effectMiddleware(mw)`

Opt-in adapter for adopters who prefer the Effect-native signature
(`(input, next) => Effect.Effect<Result, Error, never>`). The canonical
middleware shape is Promise-based because most adopters write trivial
wrappers.

## Patterns

### Multi-transport with selector

```ts
import { selector } from "@agentick/client-next";

const client = await createClient({
  transport: selector(
    [websocket({ url: "wss://..." }), httpTransport({ url: "https://..." })],
    { policy: "fallback-on-connect-failure" },
  ),
});
```

### Multi-tab via multiplexer

```ts
import { multiplexer } from "@agentick/transport-multiplexer-next";

const client = await createClient({
  transport: multiplexer(
    websocket({ url, auth }),
    {
      leader: webLocksLeader("my-app"),
      bridge: broadcastChannelBridge("my-app"),
    },
  ),
});
```

Leader election + cross-tab message bridge — only one tab holds the
real connection; followers proxy via `BroadcastChannel`.

## Status

Phase 33.B of the v2 implementation plan — see `docs/proposals/v2/STATUS.md` and `docs/proposals/v2/blueprint/33-client-and-transports.md`.

## Verified by

Every claim in this README has a corresponding test, or appears below
under "Roadmap & known gaps" with an explicit marker.

| Concern | Test file |
|---|---|
| `createClient`, `connect`, `close`, request dispatch | `../transport-in-process/src/__tests__/smoke.spec.ts` |
| Extension `request` middleware composition (outer→inner) | `../transport-in-process/src/__tests__/smoke.spec.ts` |
| Extension `install()` namespace registration | `../transport-in-process/src/__tests__/smoke.spec.ts` |
| `onClose` handler LIFO order | `../transport-in-process/src/__tests__/smoke.spec.ts` |
| `ClientHandlerRegistry` per-event merge kinds (`observer` / `first-non-null-wins` / `any-reconnect-wins`) | `src/__tests__/handler-registry.spec.ts` |
| `effectMiddleware` Effect↔Promise adapter, error propagation, interleave with Promise middleware | `src/__tests__/effect-middleware.spec.ts` |
| `client.send(sessionId, input)` shortcut shape equivalence with `client.session(id).send(input)` | `../transport-in-process/src/__tests__/send-shortcut.spec.ts` |

## Roadmap & known gaps

- **`client.events()` bus → AsyncIterable adapter** — type surface ships; the iterator emits no events until client event surfaces register on the bus `EventSurface` union. `onStateChange` works end-to-end today.
- **Auth surface seed** — `client.auth` is a stub (returns `null` / no-op). ADR 34 fills the full subsystem (OAuth 2.1, JWT with JWKS rotation, DPoP, RBAC/ABAC/ReBAC).
- **`composeSubscribe` is exported but unused by the client itself** — subscriptions flow through the transport directly today. Wire it in when subscription middleware lands a real use case.
- **`selector()` not yet implemented in this package** — declared in ADR 33 rev-3; lands alongside the second transport (HTTP, Phase 33.D).
- **Multi-impl `ClientProtocol` conformance suite** — `runClientConformance(factory)` shape declared in ADR 33; not yet shipped. Any TS impl claiming to be a client should pass this. Deferred until a second impl exists (test mock or Worker-thread proxy).
- **Cross-runtime verification** — "runs in Node 22+, browsers, Bun, Deno, edge runtimes" — tested only against Node 24 today. Browser smoke via headless / Bun / Deno / edge runtimes deferred to integration-test CI.

## Development plan

| Phase | What lands |
|---|---|
| 33.B (done) | This package + in-process transport + `ClientProtocol` in spec |
| 33.C (done) | WebSocket transport |
| 33.D | Streamable HTTP transport |
| 33.E | Unix socket transport |
| 33.F | `client-retry-next`, `client-telemetry-next`, `client-offline-next`, `client-cache-next` extensions |
| 33.G | Multiplexer (`@agentick/transport-multiplexer-next`) |
| 33.H | Devtools + mock |
| 33.I | MCP-bilingual (`@agentick/mcp-surface-next`, `@agentick/transport-mcp-client-next`) |
| ADR 34 | Auth subsystem fills `client.auth` |
