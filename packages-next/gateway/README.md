# @agentick/gateway-next

The `GatewayHarness` — runtime root of agentick's harness hierarchy.

A gateway hosts one or more `AppHarness` instances, owns the
substrate (journal + bus + inbox) they inherit by default, and
mediates cross-app event observation. It's the entry point for
embedded library deploys, single-process daemons, cloud multi-tenant
hosts, and fleet-clustered deployments (Phase 5 — cluster fusion
landed; pass `cluster: ClusterFactory` to `createGateway`).

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

## Cluster integration (Phase 5)

Pass `cluster: ClusterFactory` to wrap the gateway's substrate. Every
app spawned via `gateway.createApp(...)` automatically inherits the
cluster-wrapped substrate via the existing default chain — no per-app
cluster wiring needed.

```ts
import { createGateway } from "@agentick/gateway-next";
import { defineUnixCluster } from "@agentick/cluster-net-next";

const gateway = await createGateway({
  cluster: defineUnixCluster({ socketPath: "/tmp/cluster.sock" }),
});

const app1 = await gateway.createApp({
  rootElement: <Agent1 />,
  options: { executor: ... },
});
const app2 = await gateway.createApp({
  rootElement: <Agent2 />,
  options: { executor: ... },
});

// `closeGateway()` closes all apps first, then the cluster
// (transport / membership / locally-elected broker), then the substrate.
await gateway.closeGateway();
```

This is the **recommended multi-app deployment pattern.** Apps that
pass `cluster: ...` independently via top-level `createApp` each get
their own cluster (extra connections, double-delivery). The
gateway-owned cluster is THE cluster for every app it spawns.

See [ADR 38 — Cluster lifecycle + ownership](../../docs/proposals/v2/blueprint/38-cluster-lifecycle-and-ownership.md) for
the full ownership rules.

**Constraint.** `createGateway({cluster, bus: instance})` is fine.
`createGateway({cluster, bus: LocalEventBus.factory()})` throws — same
instance-vs-factory split as `createApp`. Resolve factories yourself
if you need the combination.

## API surface

### `createGateway(options?): Promise<GatewayHarness>`

```ts
interface CreateGatewayOptions {
  gatewayId?: string;
  journal?: OperationJournal | OperationJournalFactory;
  bus?: EventBus | EventBusFactory;
  inbox?: MessageInbox | MessageInboxFactory;
  cluster?: ClusterFactory; // Phase 5
  tools?: readonly ToolDeclaration[]; // gateway-scope tools (see below)
  wireExtensions?: readonly WireExtension[]; // ADR 46 — see below
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
  wireExtensions(): WireExtensionRegistry; // ADR 46 — see below
  closeGateway(): Promise<void>;
  close(): Promise<void>; // alias for closeGateway
}
```

## Wire extensions (ADR 46)

The gateway can host **wire extensions** — extensible JSON-RPC
namespaces reachable from `@agentick/client-next`. Adopters install
their own via `wireExtensions: [...]`; framework packages will
self-install via composite extension factories in Phase E (#297).

The `@agentick/transport-next` dispatcher routes EVERY framework
method (`gateway/*`, `app/*`, `session/*`, `sub/*`) through the
same registry adopter extensions use. Framework-supplied
`WireExtension` values are pre-registered on every `GatewayHarness`
at construction. Streaming methods (`session/send` with
`_meta.progressToken`, `sub/subscribe` with server-allocated ids)
consume the `ctx.transport` slot on `WireExtensionContext` —
`progress(...)` for progress frames, `registerCancel(...)` for
`notifications/cancelled` seam, `registerSubscription(...)` for
subscription fan-out.

Only three methods dispatch outside the extension registry —
`initialize`, `ping`, `_extensions/list` — because they need to
resolve BEFORE the registry itself is queryable.

### Installing an adopter extension

```ts
import { createGateway } from "@agentick/gateway-next";
import { defineWireExtension } from "@agentick/spec-next";

const crmExt = defineWireExtension({
  name: "@my-org/crm",
  namespace: "crm",
  methods: {
    "crm/listContacts": async (_, ctx) => ({ contacts: await loadContacts() }),
  },
  notifications: ["crm/contact-changed"],
});

const gateway = await createGateway({
  wireExtensions: [crmExt],
});
```

### Discovery

The gateway ships a built-in `_extensions/list` wire method that
returns every registered extension. `@agentick/client-next`
consumes this after `initialize` to populate `client.capabilities`
(landing in #296).

```ts
// From a client:
const { extensions } = await client.request("_extensions/list", {});
// -> [{ name: "@my-org/crm", namespace: "crm", methods: [...], notifications: [...] }]
```

### Constraints

- Namespaces reserved for framework-internal use (`_*`) can't be
  claimed by adopter extensions — the `defineWireExtension`
  validator rejects.
- Framework-supplied namespaces (`gateway`, `app`, `session`,
  `sub`) are registered by `GatewayHarness` construction. Adopter
  attempts to claim those namespaces fail with
  `WireExtensionDefinitionError` — the registry rejects duplicates
  and framework registration runs FIRST.
- Registered namespaces must be unique per gateway. Duplicate
  registration throws `WireExtensionDefinitionError` at construction
  time (not first-request time).
- The registry is sealed once `gateway.ready` resolves — extensions
  cannot be added post-hoc. To layer additional extensions,
  reconstruct the gateway.

See [ADR 46 — Wire extensions](../../docs/proposals/v2/blueprint/46-wire-extensions.md)
and [`@agentick/spec-next/wire`](../spec/src/wire/README.md) for the
extension authoring guide.

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

| Concern                                                | Test file                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| Construction + default in-memory substrate             | `src/__tests__/harness.spec.ts`                              |
| `createApp` with default gateway-substrate inheritance | `src/__tests__/harness.spec.ts`                              |
| `createApp` with per-app substrate factory override    | `src/__tests__/harness.spec.ts`                              |
| `apps()` / `app(id)` read-side                         | `src/__tests__/harness.spec.ts`                              |
| `closeGateway()` cascades into app closes              | `src/__tests__/harness.spec.ts`                              |
| `events()` observes app-level events via fan-in        | `src/__tests__/harness.spec.ts`                              |
| Duplicate `appId` rejection                            | `src/__tests__/harness.spec.ts`                              |
| `GatewayClosedError` after close                       | `src/__tests__/harness.spec.ts`                              |
| Wire extension registry — register / resolve / seal    | `src/__tests__/wire-registry.spec.ts`                        |
| Wire extension dispatch end-to-end                     | `../transport/src/__tests__/wire-extension-dispatch.spec.ts` |
| Framework wire extensions + namespace-conflict reject  | `src/__tests__/wire-framework-extensions.spec.ts`            |

## Status

Phase 4 (gateway scaffold) and now consumed by Phase 33.C+
(transports). Wire-extension registry + framework methods as wire
extensions + streaming primitives on `WireExtensionContext` all
landed (#295 Phase B/C, #300 subscribe rename, #303 streaming
primitives). ADR 46 eat-our-own-dogfood commitment is complete —
only three bootstrap builtins (`initialize`, `ping`,
`_extensions/list`) dispatch outside the wire extension registry.
See `docs/proposals/v2/STATUS.md`.

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
- **All framework methods dispatch through the wire extension
  registry.** #295 Phase B/C + #303 streaming primitives landed
  the full ADR 46 eat-our-own-dogfood commitment. Only bootstrap
  builtins (`initialize`, `ping`, `_extensions/list`) remain
  hardcoded — they run BEFORE the registry is queryable, which is
  intentional.
- **`bridges()` on wire-extension context is empty.** No
  framework-supplied extension needs bridges today. Phase F (#298 —
  `mcpControlWireExtension`) is the first consumer; it will resolve
  bridges from the target session's session-extension registry.
- **`_extensions/list` is unauthenticated for now.** Discovery is
  intended to be open — clients need it to know what they can
  reach. If future deployments want gated discovery, the wire method
  can grow an auth entry in Phase C.

## Development plan

| Phase                 | What lands                                                                                                                            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 4 (done)        | This package — gateway scaffold                                                                                                       |
| Phase 5 (done)        | `AppHarnessProtocol.id` / `SessionHarnessProtocol.id`                                                                                 |
| Phase 33.C–E          | Transports mount on `GatewayHarness` (no changes to this package)                                                                     |
| Phase 33.D extraction | Shared `@agentick/gateway-rpc-adapter-next` extracted from `transport-websocket-next/server/dispatch.ts` — reusable across transports |
| ADR 34                | `@agentick/auth-next` adds a `GatewayExtension` for auth                                                                              |
| Phase 33.I            | `@agentick/mcp-surface-next` adds a `GatewayExtension` that mounts MCP method namespaces                                              |
| ADR 29 Phase D        | `@agentick/cluster-next` substrate impl — gateway gets a cluster journal/bus                                                          |
