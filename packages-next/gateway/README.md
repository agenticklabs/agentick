# @agentick/gateway-next

The `GatewayHarness` — runtime root of agentick's harness hierarchy.

A gateway hosts one or more `AppHarness` instances, owns the
substrate (journal + bus + inbox) they inherit by default, and
mediates cross-app event observation. It's the entry point for
embedded library deploys, single-process daemons, cloud multi-tenant
hosts, and (with future cluster substrate) fleet-clustered
deployments.

## What this package is

Phase 4 of the v2 implementation plan landed the thin
`GatewayHarness` scaffold. It implements
`GatewayHarnessProtocol` from `@agentick/spec-next` and is the
runtime-root harness in every deployment tier — embedded library
(in-process), single-process server, multi-tenant cloud, clustered.

Gateway responsibilities:

- **Multi-app hosting** — `createApp(input)` instantiates an
  `AppHarness` that inherits the gateway's substrate by default, or
  takes a per-app substrate factory override.
- **Substrate inheritance** — apps see the gateway's journal / bus /
  inbox unless they explicitly override.
- **Lifecycle cascade** — `closeGateway()` shuts down every hosted
  app cleanly.
- **Cross-app observation** — `gateway.events(filter?)` returns an
  `AsyncIterable<ProtocolEvent>` fanned in from every hosted app.
- **Read-side protocol surface** — `gateway.app(id)`, `gateway.apps()`
  for protocol consumers; `createApp` is on the concrete impl
  (typed input opts in spec would force pulling app-next types into
  spec).

## Quick start

```ts
import { createGateway } from "@agentick/gateway-next";

const gateway = await createGateway();

const app = await gateway.createApp({
  appId: "my-app",
  rootElement: <MyAgent />,
  options: { executor, reconciler },
});

const session = await app.createSession({});
const result = await session.send({ messages: [...] }).result;

await gateway.closeGateway();
```

## API surface

### `createGateway(options?): Promise<GatewayHarness>`

```ts
interface GatewayHarnessOptions {
  gatewayId?: string;
  journal?: OperationJournal | OperationJournalFactory;
  bus?: EventBus | EventBusFactory;
  inbox?: MessageInbox | MessageInboxFactory;
  metadata?: Readonly<Record<string, unknown>>;
}
```

Substrate slots accept either an instance OR a factory function
(ADR 31 self-similar slottable pattern). Factories see the
positional defaults as the parent substrate.

### `GatewayHarness`

```ts
class GatewayHarness extends BaseHarness<"gateway"> implements GatewayHarnessProtocol {
  readonly id: string;
  app(id: string): AppHarnessProtocol | undefined;
  apps(): readonly AppHarnessProtocol[];
  createApp<P>(input: CreateGatewayAppInput<P>): Promise<AppHarnessProtocol<P>>;
  events(filter?: EventQuery, options?: SubscribeOptions): AsyncIterable<ProtocolEvent>;
  closeGateway(): Promise<void>;
  close(): Promise<void>;  // alias for closeGateway
}
```

## Patterns

### Multi-app cross-tenant hosting (single gateway, multi-app)

A gateway can host multiple `App` instances simultaneously, each
representing a tenant / customer / agent definition. Per-app
substrate factories let each app have its own journal / bus while
sharing the gateway's inbox for cross-app routing.

```ts
const gateway = await createGateway();

const tenantA = await gateway.createApp({
  appId: "tenant-a",
  rootElement: <AgentA />,
  options: makeOptions("tenant-a"),
});

const tenantB = await gateway.createApp({
  appId: "tenant-b",
  rootElement: <AgentB />,
  options: makeOptions("tenant-b"),
});

// gateway.events() fans events from both apps
for await (const ev of gateway.events()) {
  console.log(ev.scope.appId, ev.name);
}
```

### As a `ClientTransport` host

The WebSocket / HTTP / Unix-socket transports mount on a
`GatewayHarness`:

```ts
import { websocketServer } from "@agentick/transport-websocket-next/server";

const httpServer = createServer();
websocketServer({ httpServer, gateway });
httpServer.listen(8080);
```

The JSON-RPC dispatcher in `@agentick/transport-websocket-next/server`
calls into `GatewayHarnessProtocol` methods directly — no adapter
layer between wire and harness.

## Verified by

| Concern | Test file |
|---|---|
| Construction + default in-memory substrate | `src/__tests__/harness.spec.ts` |
| `createApp` with default gateway-substrate inheritance | `src/__tests__/harness.spec.ts` |
| `createApp` with per-app substrate factory override | `src/__tests__/harness.spec.ts` |
| `apps()` / `app(id)` read-side | `src/__tests__/harness.spec.ts` |
| `closeGateway()` cascades into app closes | `src/__tests__/harness.spec.ts` |
| `events()` observes app-level events via fan-in | `src/__tests__/harness.spec.ts` |
| Duplicate `appId` rejection | `src/__tests__/harness.spec.ts` |
| `GatewayClosedError` after close | `src/__tests__/harness.spec.ts` |

## Status

Phase 4 (gateway scaffold) and now consumed by Phase 33.C+
(transports). See `docs/proposals/v2/STATUS.md`.

## Roadmap & known gaps

- **No transports / plugins / auth in this package.** ADR 31 +
  ADR 32 land transports as separate `@agentick/transport-*-next`
  packages and plugins as extensions (shape-1 per ADR 32). This
  package only ships the runtime-root harness.
- **No cluster substrate.** ADR 29 Phase D substrate (Redis Streams /
  Kafka) lands in `@agentick/cluster-next`; this package's
  `GatewayHarness` accepts any `EventBus` impl so cluster mode is
  a substrate swap, not a gateway rewrite.
- **`GatewayHarnessProtocol.createApp` is on the concrete impl, not
  the protocol** — see comments in the implementation. Typing input
  opts in spec would force pulling `@agentick/app-next` types into
  spec. Concrete impls expose their typed `createApp`; protocol
  consumers can enumerate apps but not construct them.
- **`AppHarnessProtocol.id` / `SessionHarnessProtocol.id`** added in
  Phase 5 follow-up (2026-06-07). Gateway gains a public `id` too
  for cluster routing.
- **No `GatewayExtension` impls yet.** ADR 32 names the extension
  shape; the spec ships `GatewayExtension` / `GatewayInstaller`
  interfaces. Concrete extensions land per their owning scope
  (auth in ADR 34, mcp-surface in 33.I, transports as their own
  packages).

## Development plan

| Phase | What lands |
|---|---|
| Phase 4 (done) | This package — gateway scaffold |
| Phase 5 (done) | `AppHarnessProtocol.id` / `SessionHarnessProtocol.id` |
| Phase 33.C–E | Transports mount on `GatewayHarness` (no changes to this package) |
| Phase 33.D extraction | Shared `@agentick/gateway-rpc-adapter-next` extracted from `transport-websocket-next/server/dispatch.ts` — reusable across transports |
| ADR 34 | `@agentick/auth-next` adds a `GatewayExtension` for auth |
| Phase 33.I | `@agentick/mcp-surface-next` adds a `GatewayExtension` that mounts MCP method namespaces |
| ADR 29 Phase D | `@agentick/cluster-next` substrate impl — gateway gets a cluster journal/bus |
