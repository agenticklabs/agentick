# @agentick/gateway

The `GatewayHarness` — runtime root of agentick's harness hierarchy.

A gateway hosts one or more `AppHarness` instances, owns the
substrate (journal + bus + inbox) they inherit by default, and
mediates cross-app event observation. It's the entry point for
embedded library deploys, single-process daemons, cloud multi-tenant
hosts, and fleet-clustered deployments (Phase 5 — cluster fusion
landed; pass `cluster: ClusterFactory` to `createGateway`).

## What this package is

Phase 4 of the v2 implementation plan landed the thin
`GatewayHarness` scaffold. It implements `GatewayHarnessProtocol` from `@agentick/spec` and is the
runtime-root harness in every deployment tier — embedded library
(in-process), single-process server, multi-tenant cloud, clustered.

Gateway responsibilities:

- **Multi-app hosting** — `createApp(input)` instantiates an
  `AppHarness` that inherits the gateway's substrate by default, or
  takes a per-app substrate factory override.
- **Substrate inheritance** — apps see the gateway's journal / bus /
  inbox unless they explicitly override.
- **Lifecycle cascade** — `close()` shuts down every hosted app
  cleanly. `listen()` is REQUIRED before hosting apps: `createApp`
  throws `GatewayNotStartedError` until `listen()` has run, guaranteeing
  the `gateway:start` seam fires before any app mounts (ADR 84 §1).
- **Cross-app observation** — `gateway.events(filter?)` returns an
  `AsyncIterable<ProtocolEvent>` fanned in from every hosted app.
- **Read-side protocol surface** — `gateway.app(id)`, `gateway.apps()`
  for protocol consumers; `createApp` is on the concrete impl
  (typed input opts in spec would force pulling app-next types into
  spec).

## Quick start

```ts
import { createGateway } from "@agentick/gateway";

const gateway = await createGateway();
await gateway.listen(); // REQUIRED before createApp — fires the gateway:start seam

const app = await gateway.createApp(<MyAgent />, {
  appId: "my-app",
  options: { modelExecutor, compiler },
});

const session = await app.createSession({});
const result = await session.send({ messages: [...] }).result;

await gateway.close();
```

## Cluster integration (Phase 5)

Pass `cluster: ClusterFactory` to wrap the gateway's substrate. Every
app spawned via `gateway.createApp(...)` automatically inherits the
cluster-wrapped substrate via the existing default chain — no per-app
cluster wiring needed.

```ts
import { createGateway } from "@agentick/gateway";
import { defineUnixCluster } from "@agentick/cluster-net";

const gateway = await createGateway({
  cluster: defineUnixCluster({ socketPath: "/tmp/cluster.sock" }),
});
await gateway.listen();

const app1 = await gateway.createApp({
  rootElement: <Agent1 />,
  options: { modelExecutor: ... },
});
const app2 = await gateway.createApp({
  rootElement: <Agent2 />,
  options: { modelExecutor: ... },
});

// `close()` closes all apps first, then the cluster
// (transport / membership / locally-elected broker), then the substrate.
await gateway.close();
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
  transports?: readonly ServerTransport[]; // ADR 84 — see "Lifecycle & transports"
  authorizer?: Authorizer; // authz policy — see "Authentication & authorization"
  truncateToolResults?: boolean | { maxBytes?: number; truncate?: (block, ctx) => ContentBlock }; // OPT-IN — see below
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
  // Two-door signature, mirroring the top-level createApp(rootElement, options):
  createApp<P>(
    rootElement: unknown,
    input: Omit<CreateGatewayAppInput<P>, "rootElement">,
  ): Promise<AppHarnessProtocol<P>>;
  createApp<P>(input: CreateGatewayAppInput<P>): Promise<AppHarnessProtocol<P>>;
  events(filter?: EventQuery, options?: SubscribeOptions): AsyncIterable<ProtocolEvent>;
  wireExtensions(): WireExtensionRegistry; // ADR 46 — see below
  emitCapabilitiesChanged(): void; // ADR 47 — see "Server-initiated notifications"
  listen(): Promise<void>; // ADR 84 — bind transports, flip ready; REQUIRED before createApp
  close(opts?: { drain?: boolean }): Promise<void>; // sole terminal verb; drain-by-default
}
```

## Lifecycle & transports (ADR 84)

The gateway is a server, so it takes the canonical server lifecycle pair —
`listen()` to start, `close({ drain })` to stop (graceful-vs-forced is a
parameter, not a second `destroy()` verb).

The gateway **owns** its server transports. Pass them flat via the
`transports` option (the `withX` convention — no `config: {}` nest); each
`ServerTransport` has its wire config (port/path/tls) bound at its own
construction, so the gateway only needs to hand it the dispatch host:

```ts
const gateway = await createGateway({
  transports: [
    webSocketServerTransport({ port: 8080 }), // config bound at construction
    inProcessServerTransport(),
  ],
});

await gateway.listen(); // → await Promise.all(transports.map(t => t.listen(this)))
// ... serve ...
await gateway.close(); // → closes transports FIRST, then apps, then substrate
```

- **`listen()`** runs the hookable `gateway:start` op, awaits gateway-ready
  (so the wire registry has sealed before any frame arrives), then fans out
  `transport.listen(this)` — injecting the gateway itself as each transport's
  dispatch host. It is **idempotent**: a started-latch short-circuits before
  the op fires, so a second `listen()` does NOT re-listen the transports. Zero
  transports → a clean no-op that just flips ready.
- **`close()`** runs the hookable `gateway:close` op and closes transports
  **first** in the LIFO teardown (`transports → apps → extensions →
substrate`). Transports are the ingress edge: stopping them before apps tear
  down prevents an inbound frame from routing into a half-closed app. Transport
  close failures are best-effort — one failing transport never blocks the rest
  of teardown.

The concrete transport wrappers (`webSocket` / `http` / `unixSocket` /
`inProcess`) ship from the `@agentick/transport-*-next` packages; this package
owns only the fan-out. `spyServerTransport()` (`@agentick/gateway/testing`)
is a call-recording double for asserting the fan-out in tests.

**Embedding in an existing HTTP framework** (Hono, Nitro, Next.js route
handlers, Bun/Deno — you own the routes, your auth already ran):
`fetchServerTransport()` from `@agentick/transport-http/fetch` is the
transport for that deployment mode — a web-standard handler for your route
table, plus the `ServerTransport` you register here so `listen()`/`close()`
govern it like every other edge:

```ts
import { fetchServerTransport } from "@agentick/transport-http/fetch";

const { transport, handler } = fetchServerTransport({
  identity: async (req) => {
    const user = await myAuth(req); // YOUR auth — hand us the result, never tokens
    if (!user) return new Response(null, { status: 401 }); // short-circuits verbatim
    return { principal: user.id, user: { tenantId: user.tenantId }, scopes: user.scopes };
  },
});

app.all("/agentick/*", (c) => handler(c.req.raw)); // Hono — mount at setup time

const gateway = await createGateway({ transports: [transport] });
await gateway.listen(); // binds the door; close() sweeps its open streams
```

Embedding into an existing **Node** server (Express, Nest, Fastify — anything
with an `http.Server`) doesn't need the fetch door at all: the websocket and
http transports both take `{ httpServer }` instead of `{ port }` and attach to
YOUR server (never closing it). Full fetch example (identity seam, fail-closed
defaults, 503 semantics): `@agentick/transport-http` README
§`fetchServerTransport`.

## Telemetry & observability (ADR 78)

The gateway takes the same strictly-opt-in `telemetry` switch as `createApp`
(see the app-next README's "Observability & telemetry" for the full form). It
plays **two** roles at the runtime root:

```ts
import { createGateway } from "@agentick/gateway";
import { createTelemetry } from "@agentick/app";
import { otlpSink } from "@agentick/telemetry-otlp";

const gateway = await createGateway({
  telemetry: createTelemetry({ serviceName: "fleet" }, otlpSink()),
});
```

**1. The gateway's OWN ops export.** The gateway builds an app-scoped Effect
`ManagedRuntime` from the setting and runs every gateway operation on it, so each
op's `Effect.withSpan` span exports to your tracer. That covers the gateway's own
seams: **wire dispatch** (`wire:<method>`), **`authorizer:command:authorize`**,
and the **lifecycle** ops (`gateway:command:start` / `close` / `create-app` /
`accept`). App-, session-, and tool-level spans do NOT run on the gateway runtime
— they export through the app's provider (role 2).

The gateway also owns a **`ctx.metrics` / `ctx.trace` surface**: the
wire-extension handler ctx (ADR 64/78). `runWireDispatch` attaches the flat
Observability + Ops facets to a handler's `ctx` IN-FIBER, so `ctx.trace(...)`
opens a child span parented under the `wire:<method>` op and `ctx.metrics.*` fans
out to the gateway's meter with the low-cardinality **`{ method }`** ambient
label. Off the telemetry path they collapse to shared frozen no-ops (zero-cost).

**2. Substrate inheritance — it default-chains to every app beneath.** Every
`createApp` the gateway hosts inherits this setting **unless** the app supplies
its own `telemetry`; an app-supplied switch always wins (the app override is
authoritative, exactly like the substrate `bus`/`inbox`/`journal` inheritance).
One gateway-level switch therefore lights up the whole deployment:

```ts
// Inherits the gateway's telemetry → app/session/tool spans export too.
const app = await gateway.createApp(<Agent />, { options: { compiler, modelExecutor } });

// Overrides — this app's spans go to ITS provider, never the gateway's.
const isolated = await gateway.createApp(<Agent />, {
  options: { compiler, modelExecutor, telemetry: createTelemetry({}, myOwnSink()) },
});
```

**The gateway meter is the SHARED, memoized one.** An OTel `MetricReader` binds
to exactly one `MeterProvider`. The gateway acquires the meter through the same
`buildTelemetryExport` path the apps use, which **materializes one `MeterProvider`
per reader set and shares the `MetricSink`** (refcounted). So the gateway's
wire-ctx metrics and every inheriting app's `ctx.metrics` resolve the SAME meter
instance — no reader double-binds. A gateway hosting **zero apps** still exports
its own wire-dispatch metrics through that meter; the last holder (gateway or
app) to close flushes + shuts the provider down.

**Multi-app metric sharing (the recommended pattern).** Two apps inheriting one
gateway setting share the SAME `MetricReader` instances, so the memoized
`MeterProvider` above serves the gateway AND both apps without crashing on the
second `createApp`. Every app's metrics reach the sink; because the sink is
shared, per-app metrics stay distinguishable by the low-cardinality **`app`
ambient label** (the app's `name`) the tool executor stamps on every
`ctx.metrics.*` emission alongside `{ tool, op }`, while the gateway's own
wire-ctx metrics carry `{ method }`.

**Known gap — `telemetryNamespace` does not cascade.** The gateway does NOT
propagate `telemetryNamespace` to inherited apps; each app whitelabels its own
framework-attribute prefix (default `agentick`). A whole-deployment namespace
whitelabel is a fiber-context concern (ADR 78 brick #2), not built this slice —
set `telemetryNamespace` per app if you need a non-default prefix.

**The never-wrap guardrail** is identical to app-next: the framework adds no
proprietary layer between you and OpenTelemetry — `createTelemetry` merges your
standard `SpanProcessor` / `MetricReader` sinks and hands the raw objects to the
SDK. This package declares no OTel exporter deps; those live in
`@agentick/telemetry-otlp`.

> Verified by `src/__tests__/telemetry-inheritance.spec.ts` — gateway-op span
> export (Half A), app inheritance of the gateway setting, and app-override
> precedence (Half B); `src/__tests__/telemetry-multi-app.spec.ts` — two
> hosted apps sharing one `MeterProvider` without crashing, both apps' metrics
> reaching the sink distinguished by the `app` label; and
> `src/__tests__/telemetry-wire-ctx.spec.ts` — a wire handler's `ctx.trace` span
> parenting under the `wire:<method>` op and `ctx.metrics` reaching the gateway
> meter with the `{ method }` label. All end-to-end against real OTel
> `SpanProcessor` / `MetricReader`s.

## Wire extensions (ADR 46)

The gateway can host **wire extensions** — extensible JSON-RPC
namespaces reachable from `@agentick/client`. Adopters install
their own via `wireExtensions: [...]`; framework packages will
self-install via composite extension factories in Phase E (#297).

The `@agentick/transport` dispatcher routes EVERY framework
method (`gateway/*`, `app/*`, `session/*`, `sub/*`) through the
same registry adopter extensions use. Framework-supplied
`WireExtension` values are pre-registered on every `GatewayHarness`
at construction. Streaming methods (`session/send` with
`_meta.progressToken`, `sub/subscribe` with server-allocated ids)
consume the `ctx.wire` slot on `WireExtensionContext` (renamed from
`ctx.transport` — ADR 91; it is the wire-crossing's verbs, and the old
name collided with `ToolHandlerCtx.transport`) —
`progress(...)` for progress frames, `registerCancel(...)` for
`notifications/cancelled` seam, `registerSubscription(...)` for
subscription fan-out.

`session/send` fans TWO sources onto the caller's `_meta.progressToken`
(ADR 64 / #19-progress-wire): (1) the handle's execution-event stream,
and (2) `ctx.progress` SIGNALS — a tool (or any harness) emitting
`<surface>:signal:progress` bus events scoped to the in-flight
execution. The gateway bus is the fan-in root, so the send handler
observes a tool's `ctx.progress` via `ctx.gateway.events(...)` scoped to
`{ executionId }` and forwards each onto the reporter — the agentick
client receives it on `client.transport.progress(token)`, exactly as an
MCP client would receive `notifications/progress`. Verified end-to-end
by `@agentick/transport-in-process`'s
`src/__tests__/progress-signal-e2e.spec.ts`.

Only three methods dispatch outside the extension registry —
`initialize`, `ping`, `_extensions/list` — because they need to
resolve BEFORE the registry itself is queryable.

### Installing an adopter extension

```ts
import { createGateway } from "@agentick/gateway";
import { defineWireExtension } from "@agentick/spec";

const crmExt = defineWireExtension({
  name: "@my-org/crm",
  namespace: "crm",
  methods: {
    "crm/listContacts": async (_, ctx) => ({ contacts: await loadContacts() }),
    "crm/deleteContact": async ({ id }) => {
      await removeContact(id);
      return null;
    },
  },
  // Per-method authorization (see "Authentication & authorization").
  // A method with no entry is gated by its verb scope (`crm:listContacts`).
  auth: {
    "crm/deleteContact": { required: true, scope: "crm:admin" }, // crm:deleteContact AND crm:admin
  },
  notifications: ["crm/contactChanged"], // camelCase, matching the methods above
});

const gateway = await createGateway({
  wireExtensions: [crmExt],
});
```

### Per-method op config — the method is a command (ADR 90)

A method entry follows the ADR-42 dichotomy: a bare handler (shorthand, above)
OR a flat config object. The config attaches define-time seams to THIS method's
`wire:<method>` op — reusing the existing interceptor + span seams, no new tier:

```ts
const crmExt = defineWireExtension({
  name: "@my-org/crm",
  namespace: "crm",
  methods: {
    "crm/deleteContact": {
      handler: async ({ contactId }, ctx) => ({ deleted: await removeContact(contactId) }),
      // Admission guard (veto/defer/replace/proceed) — honored at the JSON-RPC
      // edge: veto → Forbidden, defer → RateLimited (retry-after), replace →
      // success frame with the supplied result.
      guard: ({ contactId }) => (locked(contactId) ? { kind: "veto" } : undefined),
      // Middleware wraps THIS method's dispatch (timing / retry / logging); it
      // never leaks to the nested session/tool ops the handler triggers.
      middleware: async (params, next) => next(params),
      // Static attributes on the `wire:crm/deleteContact` op span.
      spanAttributes: { "crm.tier": "premium" },
      // Per-method authz — merged into the extension `auth` map (declaring the
      // same method's auth in both places is a define-time error).
      auth: { required: true, scope: "crm:admin" },
    },
  },
});
```

Every `WireMethods` row also mints TYPED gateway hooks off the row —
`gateway.hook({ onBeforeWireCrmDeleteContact })` is typed (params → before-hook
input, result → after-hook output), and a before-hook may RESHAPE the params
the handler receives. See ADR 90 for the one-row → four-surfaces story.

> **Verified by** `../transport/src/__tests__/wire-command-e2e.spec.ts`
> (journaled op + typed hook transform + guard veto→Forbidden / defer→RateLimited
>
> - middleware + span attrs + live ctx facets) and the type-level
>   `../runtime/src/__tests__/wire-command-hooks.type.spec.ts`.

### Discovery

The gateway ships a built-in `_extensions/list` wire method that
returns every registered extension. `@agentick/client`
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
and `[@agentick/spec/wire](../spec/src/wire/README.md)` for the
extension authoring guide.

## Authentication & authorization

Two edges, each crossed exactly once (ADR 51). **Authentication** turns a
credential into an identity at ingress; **authorization** decides — at a single
choke point, before any handler runs — whether that identity may call the method.
Harnesses are authz-unaware: there are no in-handler permission checks.

```text
  client ──token──▶  AuthSource.authenticate  ──▶  IngressIdentity { principal, scopes }
                     (ingress · fail-closed)

  request ─────────▶  dispatch choke point  (@agentick/transport)
                       1. session requiredScopes ceiling   (#199 — un-waivable)
                       2. verb-derived scope                (session/send → session:send)
                       3. + declared role                   (WireExtension.auth — additive)
                       ▼ allowed
                     handler runs
```

### 1. Authentication — the `AuthSource`

An `AuthSource` maps a presented credential (bearer token) to an
`IngressIdentity` (`{ principal, scopes, user? }`), stamped on the connection at
ingress. `staticTokenAuthSource` (from `@agentick/transport`) is the bundled
table form; OAuth/JWT sources produce the same shape from token claims.

```ts
import { staticTokenAuthSource } from "@agentick/transport";

const authSource = staticTokenAuthSource({
  tokens: {
    "tok-alice": { principal: "alice", scopes: ["session:send", "knobs:set"] },
    "tok-root": { principal: "root", scopes: ["*"] },
  },
  // allowAnonymous: false (default) — a configured source REJECTS a missing token.
});
```

Two poles, by design:

- **No** `AuthSource` → local/trusted pole: no principal is stamped; only the
  anonymous-local path the authorizer permits passes.
- `AuthSource` **configured** → **fail-closed**: a missing or invalid credential is
  rejected at ingress, before dispatch ever runs.

The source runs at the transport server via `authenticateIngress` (the ADR 50
`GatewayInstaller.interceptIngress` seam generalizes where it's wired). Identity
is stamped once; everything downstream reads the stamp — it is never re-derived.

#### Reading the caller's identity in a wire hook

Authorization (§2–§4) is coarse and structural — it decides _whether_ a call
proceeds. When a handler must instead **act on** who is calling — stamp the
authenticated principal onto a record, branch on a tenant — the stamped
`IngressIdentity` is threaded onto every `wire:<method>` op, so a gateway
`onBeforeWire<...>` hook reads it from its ctx and reshapes params. The recipe
for the multi-tenant case (the caller cannot forge identity — it comes from the
ingress stamp, never from params, so the hook can clobber a smuggled value):

```ts
// Stamp the AUTHENTICATED caller onto the new session's metadata, OVERRIDING
// anything the client put in the request body. The hook is the authority.
gateway.hook({
  onBeforeWireAppCreateSession: (params, ctx) => ({
    ...params,
    metadata: { ...params.metadata, principal: ctx.identity?.principal },
  }),
});
```

`ctx.identity` is the full `IngressIdentity` (`{ principal, user?, scopes? }`) —
the structured twin of the `ctx.principal` string, carrying the adopter-shaped
`user` record and the credential's scopes. It is `undefined` on the
unauthenticated local pole, and rides ONLY the `wire:*` op: an inner non-wire op
the handler triggers (`app:create-session`) sees no identity, so request identity
never leaks into ordinary command ctx.

The hook above stamps identity into the adopter's own `metadata` bag. Distinctly,
the framework's `app/create_session` method ALSO stamps the session's
construction-bound **owning principal** (ADR 48) from `ctx.principal` onto the
new session's `SessionHarness.principal` + durable `SessionRecord.principal` —
the framework's own field feeding the framework's own dispatch gate (the
same-principal target rule). The wire params type carries no `principal` field,
so a value smuggled in the request body is never read (ownership is the edge's to
assert, not the caller's to claim); an unauthenticated create leaves the session
unstamped. Children inherit it (`session.spawn` / `fork`), and the same-principal
rule then Forbids a caller reaching a session owned by a different principal.

> **Verified by** `@agentick/transport` — `session-principal.spec.ts` (the method
> stamps `ctx.principal` onto the harness + record; a body-smuggled principal is
> ignored; unauthenticated → unstamped; the same-principal gate engages on the
> stamped value).

> **Verified by** `@agentick/transport` — `wire-identity-hook.spec.ts` (the hook
> stamps identity over a client-smuggled principal; unauthenticated → `ctx.identity`
> undefined + params pass through untouched; a wire-extension handler reads the
> full structured `ctx.identity` alongside `ctx.principal`; a non-wire op sees
> none). The carrier is `EventScope.identity` (`@agentick/spec`), threaded onto
> the wire op in `runWireDispatch`. See
> [ADR 51 §4.1](../../docs/proposals/v2/blueprint/51-invocation-and-authorization.md).

### 2. Authorization — the `Authorizer` (your policy)

`createGateway({ authorizer })` sets the policy. The triad (ADR 51 §4.2): the
framework owns the enforcement point (the dispatch choke point), the `Authorizer`
is the port, the **policy is yours**. Bundled authorizers cover the poles:

```ts
import { createGateway, staticAuthorizer } from "@agentick/gateway";

const gateway = await createGateway({
  authorizer: staticAuthorizer({
    grants: {
      alice: ["session:*", "knobs:set"], // principal → allowed scope patterns
      root: ["*"],
    },
    // anonymous: [] (default) — unauthenticated callers are denied everything.
  }),
});
```

- `staticAuthorizer({ grants })` — a server-side table: principal → scope
  patterns. Cover-aware (`session:*` satisfies `session:send`).
- `claimsAuthorizer()` — allow iff the credential's OWN scope claims cover the
  requested scope (OAuth-shaped; grants ride the token, no server table).
- `permissiveAuthorizer()` — allow everything. Explicit opt-in for no-auth
  local deployments.
- **Default when unset:** `unconfiguredAuthorizer` **— deny-by-default.** An
  authenticated principal against no policy is DENIED (auth-without-policy is a
  misconfiguration); only the anonymous-local pole passes. You never ship ungated
  by accident.

The same-principal rule (ADR 48): a method targeting a session whose owning
principal differs from the caller's is denied unless a grant explicitly elevates.

### 3. Authorizing a specific action — `WireExtension.auth`

Every method is gated by default: its authz scope **defaults to the verb name**
(`crm/deleteContact` → `crm:deleteContact`), so grants are written once and cover
both the porcelain and dynamic-command lanes (ADR 51 §3.3 anti-bypass). Declare
`auth` on the extension to change a method's requirement:

```ts
const crmExt = defineWireExtension({
  name: "@my-org/crm",
  namespace: "crm",
  methods: {
    /* … */
  },
  auth: {
    "crm/health": { required: false }, // OPEN — policy skipped (rare)
    "crm/deleteContact": { required: true, scope: "crm:admin" }, // verb scope AND role
    // unlisted methods → gated by their verb scope
  },
});
```

- `required: false` → **open**: the authorizer policy is skipped. The target
  session's structural `requiredScopes` ceiling still applies — open does not waive
  the resource ceiling. Reserve for methods with no gated dynamic-lane counterpart.
- `scope: "role"` → **additive**: required ON TOP of the verb scope, never in
  place of it. A role can only _tighten_, so a method is never reachable under a
  label different from its verb (§3.3 anti-bypass). `crm/deleteContact` requires
  BOTH `crm:deleteContact` AND `crm:admin`.
- **absent** → verb scope, gated (the default; the common case).

### The structural ceiling (`requiredScopes`)

A session may carry `requiredScopes` (resource-declared identity, ADR 48/#199).
The choke point checks it **first** and **no authorizer can waive it** — not an
absent one, not a `permissiveAuthorizer`, not a `required: false` method. It's the
floor beneath policy: hold the ceiling scopes, or you never reach the session at
all.

> **Verified by** `@agentick/transport` — `wire-declarative-auth.spec.ts`
> (verb-scope default, `required:false` open, additive role, §3.3 anti-bypass,
> ceiling-un-waivable) and the framework `wire-framework-extensions` /
> `wire-lane-e2e` suites. See [ADR 51 — invocation & authorization](../../docs/proposals/v2/blueprint/51-invocation-and-authorization.md).

### The fine contextual auth layer — `onBeforeAuthorizerAuthorize` (ADR 84 §5)

The authorizer POLICY call (§2/§3) itself routes through a hookable op —
`gateway.authorize(input)`, the `authorizer:authorize` op. This gives auth **two
layers**, and they must not be confused:

- **The floor (un-waivable, OUTSIDE the seam).** The structural `requiredScopes`
  ceiling is checked _before_ the op ever fires. No hook can widen it — a hook
  that grants `["*"]` still cannot save a caller who lacks the ceiling scope,
  because the ceiling denied before the op ran (so the hook never even fires).
- **The fine layer (contextual, ON TOP of the floor).** `onBeforeAuthorizerAuthorize`
  runs around each policy ask. It can augment the `AuthorizeInput` from request
  context — grant a **contextual scope** the static grants table couldn't know
  about (a per-request entitlement, a just-in-time elevation) — or throw to deny.
  `onAfterAuthorizerAuthorize` observes/audits the `AuthorizeResult`. It can make
  auth stricter or grant contextually; it can NEVER waive the ceiling.

```ts
// Grant a per-request contextual scope (e.g. derived from a feature flag or
// a downstream entitlement check) on TOP of the static policy:
gateway.hooks.onBeforeAuthorizerAuthorize((input) =>
  tenantHasEntitlement(input.principal, input.scope)
    ? { ...input, tokenScopes: [...(input.tokenScopes ?? []), input.scope] }
    : input,
);
// Audit every decision:
gateway.hooks.onAfterAuthorizerAuthorize((result) => {
  audit.record(result);
  return result;
});
```

This is the ADR 84 §5 refinement of "the authorizer needs no hooks": the
**structural** pre-gate needs none (it is the security floor), but the **policy**
op is exactly the seam where contextual, application-specific auth belongs.

> **Verified by** `@agentick/transport` — `authorize-seam.spec.ts`
> (contextual scope flips a policy deny→allow around a live dispatch;
> `onAfterAuthorizerAuthorize` observes; the `requiredScopes` ceiling denies
> regardless and the hook never fires). Name-locked in
> `@agentick/runtime` `hook-lifecycle-names.spec.ts`. See
> [ADR 84 §5](../../docs/proposals/v2/blueprint/84-gateway-lifecycle-and-transports.md).

### Multi-tenant app-mount gating — `onBeforeGatewayCreateApp` (ADR 84 §4)

`gateway.createApp(...)` is itself a hookable op (`gateway:create-app`). The
before-hook receives the normalized `CreateGatewayAppInput` and can **veto** an
app mount (throw) or **transform** it (stamp a tenant-scoped `appId`, inject
tenant metadata) before the app is constructed; `onAfterGatewayCreateApp`
observes the mounted `AppHarnessProtocol`. This is the seam for multi-tenant
provisioning gates that must run at the deployment root.

```ts
gateway.hooks.onBeforeGatewayCreateApp((input) => {
  if (!isProvisioned(input.metadata?.tenantId)) throw new Error("tenant not provisioned");
  return { ...input, appId: `tenant:${input.metadata?.tenantId}` };
});
```

> **Verified by** `src/__tests__/harness.spec.ts` (before-hook transforms the
> mount input and after-hook sees the app; a throwing before-hook vetoes the
> mount and nothing is registered). Name-locked in `@agentick/runtime`
> `hook-lifecycle-names.spec.ts`.

### Per-connection admission — `onBeforeGatewayAccept` (ADR 84 §4)

`gateway.accept(info)` is the hookable op (`gateway:accept`) fired **once per
newly-accepted persistent connection** — after ingress-authn, before the
connection is wired to receive frames. The before-hook receives a
`ConnectionInfo` (`{ transportId, identity?, remoteAddress? }`) and can **reject**
the connection (throw — the transport drops it), **rate-limit**, or simply
**observe**; `onAfterGatewayAccept` observes the admission.

```ts
gateway.hooks.onBeforeGatewayAccept((info) => {
  if (tooManyConnections(info.identity?.principal)) throw new Error("connection limit");
  return info; // admit
});
```

**`accept` is a CONNECTION concept — `authorize` is a REQUEST concept.** They are
deliberately distinct seams:

- **`accept`** fires per persistent connection on **connection-oriented**
  transports (WebSocket, Unix socket). One connection carries many requests; the
  admission runs once, at connection time. Use it for connection-count limits,
  per-peer rate-limiting, connection-level observability.
- **`authorize`** (§2/§3, and the `onBeforeAuthorizerAuthorize` layer above)
  fires per **request**. Request-oriented **HTTP** has no persistent connection to
  admit — each request authenticates its own header — so HTTP fires `authorize`
  and **never** `accept`. A per-request admission decision belongs in `authorize`,
  not `accept`, regardless of transport.

> **Verified by** `src/__tests__/harness.spec.ts` (`gateway.accept` fires the op
> with the `ConnectionInfo`; a throwing before-hook rejects; the after-hook
> observes). Real-loopback: `@agentick/transport-websocket` and
> `@agentick/transport-unix-socket` `server-transport.spec.ts` prove a
> throwing `onBeforeGatewayAccept` DROPS a client connection while a permitting
> hook lets a request round-trip and fires exactly once. Name-locked in
> `@agentick/runtime` `hook-lifecycle-names.spec.ts`.

### 4. Contextual policy — guards on the seam (ADR 83)

The `Authorizer` (§2) and the structural ceiling are **coarse, structural, and
un-waivable** — the security boundary. They answer "may this principal call this
verb at all," from the credential + scopes, _before_ the handler runs. They are
deliberately **not hooks** — a security boundary must not be a waivable,
reorderable userland transform.

For **fine-grained, contextual, application-specific** admission — "deny this
send while the tenant is over quota," "require a second factor for high-value
tool calls," "rate-limit per session" — use the interceptor seam. Since wire
dispatch now routes through the gateway's `runOperation` (ADR 83 §wire), a
gateway hook/guard fires AROUND the dispatch, AFTER the authorizer pre-gate. Two
forms, by how rich a decision you need:

```ts
const gateway = await createGateway({
  // (1) STRUCTURAL — coarse scope authz, un-waivable pre-gate:
  authorizer: staticAuthorizer({ grants: { alice: ["session:*"] } }),
});

// (2a) CONTEXTUAL DENY on EVERY send, per-verb typed — a before-hook throws
// to veto. `onBeforeSessionSend` (op `session:send`) folds LIVE from the
// gateway down to every session (ADR 83 §4) and fires once per send —
// wire-originated OR in-process. Register it here for deployment-wide quota.
gateway.hooks.onBeforeSessionSend((params, ctx) => {
  if (overQuota(ctx.principal)) throw new Error("quota exceeded"); // any throw → terminal:failed = the call is vetoed
  return params; // (or return a reshaped params to transform the request)
});

// (2a') WIRE-BOUNDARY only — the `wire:`-prefixed op fires just for dispatches
// arriving over a transport (not in-process sends). Use for wire-specific
// concerns (payload shape, per-connection rate-limit).
gateway.hooks.onBeforeWireSessionSend((params, ctx) => {
  /* ... */ return params;
});

// (2b) RICHER VERDICT (veto / replace / defer) — a guard returns the DSL.
// `guard` is harness-scoped, so branch on ctx.op to target one verb. A gateway
// guard folds live to sessions, so `ctx.op === "SessionSend"` targets every
// send; use `"WireSessionSend"` to target only the wire boundary.
gateway.guard((params, ctx) =>
  ctx.op === "SessionSend" && rateLimited(ctx.principal)
    ? { kind: "defer", retryAfter: 1000 } // → JSON-RPC deferred, client retries
    : { kind: "proceed" },
);
```

The two layers compose cleanly: **authz decides _reachability_ (structural,
un-waivable); the hook/guard decides _this specific call_ (contextual)** — and
the guard only ever sees calls the authorizer already admitted. A guard can
`veto`, `replace` (serve a cached result), `defer` (rate-limit → retry-later), or
observe (audit). This is the whole point of routing wire dispatch through the
seam: your app's auth/authz can be as bespoke as it needs, **without touching the
framework's enforcement point** — which is exactly why the `Authorizer` stays a
structural pre-gate and does NOT itself become a hook.

> The `wire:` prefix keeps the seams distinct (ADR 83 wire section). The
> `session:send` **op** is `onBeforeSessionSend` — and the **client** mirrors it
> (its send is the op it initiates), so `client.hook({ onBeforeSessionSend })`
> and `session.hook({ onBeforeSessionSend })` share the name. Only **this**
> layer — the gateway's wire-dispatch boundary — carries the qualifier
> (`onBeforeWireSessionSend`), because it's the one place `wire:session/send` and
> the folded `session:send` op coexist. A gateway `onBeforeSessionSend` still
> folds down live to the session op. See
> [`docs/proposals/v2/HOOK-LIFECYCLE.md`](../../docs/proposals/v2/HOOK-LIFECYCLE.md).

## Security defaults

The gateway is the deployment root, so its serving posture is a security concern
distinct from the authz seams above. Two rules for any HTTP-facing deploy: **bind
loopback (`127.0.0.1`) by default** — expose a public interface only deliberately,
behind a reviewed auth story (see
[Authentication & authorization](#authentication--authorization)) — and **never
configure permissive CORS** (`Access-Control-Allow-Origin: *`): an exposed server
plus wildcard CORS lets any web page in a user's browser drive the gateway. Never
accept exec-from-URL or curl-pipe-to-shell patterns in adopter code; a URL is not a
trust boundary. The `Authorizer` and the `requiredScopes` ceiling gate _who may
call what_ — they are not a substitute for not being reachable in the first place.
These defaults are **enforced at the HTTP-facing transport bindings**
(`@agentick/transport-http`, `@agentick/transport-websocket`) via a
shared, single-sourced policy in `@agentick/transport`
(`resolveWebSecurity`). The unconfigured posture ships closed (STATUS A2 §4c):

- **Loopback bind default** — a port-owning transport binds `127.0.0.1`;
  widening to a public interface is an explicit `host` opt-in (the boundary).
- **Cross-site rejection** — `Sec-Fetch-Site: cross-site` and a foreign
  `Origin` are rejected; a request carrying neither (a non-browser caller) is
  admitted. Cross-origin requires an explicit `allowedOrigins` allow-list.
- **Non-permissive CORS** — an allowlisted origin is echoed exactly; there is
  no code path that emits `Access-Control-Allow-Origin: *`.
- **CSRF token** — a per-process token issued on the bootstrap handshake (the
  GET notification stream) and required in the `x-agentick-csrf` header on
  every mutation (the framework client handshakes it transparently).
- **Host allow-list** — loopback names + explicitly configured hosts only
  (DNS-rebinding defense); forwarded `Host`/`Proto` headers are trusted ONLY
  when `trustProxy` is set AND the immediate peer is loopback.

Each is overridable (`allowedOrigins`, `allowedHosts`, `trustProxy`, `csrf`,
`host`) but ships safe. See the transport package READMEs for the option
surface.

## Truncating tool results sent to clients (ROADMAP A3)

A tool can return a multi-megabyte result — a whole file read, a verbose
command dump, an inline base64 image. That full payload MUST reach the model
(it may need it) and MUST land in the durable timeline store (the source of
truth), but need NOT be shoved verbatim down the wire to a browser.

The gateway is the client projection boundary, so it owns the bounding policy.
`createGateway({ truncateToolResults })` configures ONE policy that the wire
dispatch boundary (`dispatchRequest` in `@agentick/transport`) applies to
**every** client-facing frame — RPC results (`session/send`, `session/dispatch`)
AND every notification (progress + subscription). Configured once, inherited by
every attached transport, so there is no path that bounds while another leaks.

**Opt-in — OFF by default.** This is a deliberate split from the framework's
security defaults. Security defaults protect the **operator** — that is the
framework's duty, so they ship default-ON. Truncating tool output is an app-UX
**policy**: how large a payload a given app's transcript should carry is the app
developer's domain, not the framework's. So the framework ships the capability
**off**, with a good overridable default the adopter opts into. When off, the
wire boundary does zero projection work (frames pass through by reference — zero
overhead, the twin of the `telemetry` switch's off-path).

```ts
// The switch (the `createApp({ telemetry })` twin — boolean | options):
type TruncateToolResultsSetting =
  | boolean
  | { maxBytes?: number; truncate?: (block, ctx) => ContentBlock };

// OFF (default) — nothing sent to clients is truncated.
await createGateway();

// ON at the 32 KiB per-block default.
await createGateway({ truncateToolResults: true });

// ON, raised ceiling for a data-heavy deployment.
await createGateway({ truncateToolResults: { maxBytes: 256 * 1024 } });

// ON, domain override — keep the first rows of a CSV, delegate everything else.
await createGateway({
  truncateToolResults: {
    truncate: (block, ctx) => (block.type === "csv" ? headOnly(block) : ctx.bound(block)), // ctx.bound = the default
  },
});
```

**Capability, not opinion.** Once enabled, the whole thing is a typed seam an
adopter raises, lowers, or replaces. **Never the model path, never the store.**
Truncation happens ONLY on the copy heading to a client — the projector never
mutates its input, so the durable log and the model-facing timeline projection
keep the full bytes.

**Honest truncation.** A bounded block carries a machine-readable marker under
`block.metadata.bounded` (`{ truncated: true, originalBytes, retainedBytes,
reason, hint }`) plus a human suffix on the preview, both naming the durable
store as where the full content survives — fetchable via the `session/timeline_history`
wire read (the cursored page over `TimelineStore.history`; handler in
`sessionWireExtension`).

## Server-initiated notifications — the control-plane bus (ADR 47)

The gateway signals control-plane changes to connected clients over
the **substrate bus**, not a bespoke connection registry. There is one
primitive:

### `gateway.emitCapabilitiesChanged(): void`

Appends a single `gateway:capabilities:changed` event
(`GATEWAY_CAPABILITIES_CHANGED`) to the gateway bus on the gateway
surface, scoped to `{ gatewayId }`. This is the bus-native replacement
for the ripped-out `notify` / `acceptConnection` fan-out — delivery,
replay, reconnect-resume, and per-instance (per-tenant / per-principal
child bus) isolation are the bus's job, not a runtime connection filter.

```ts
// After mutating the wire-extension set (e.g. #308 dynamic
// extensions), signal every gateway-scope subscriber to refetch.
gateway.emitCapabilitiesChanged();
```

**How it reaches a client.** A gateway-scope subscriber (opened via
`sub/subscribe` on `{ surface: "gateway" }`) receives it. The event
flows:

```text
gateway.emitCapabilitiesChanged()
  → bus.append(gateway:capabilities:changed, surface "gateway")
  → subscriptionsWireExtension drain (a gateway-scope subscription)
  → notifications/subscription/event over the transport
  → subscriber receives the frame
```

Isolation is structural, not a filter argument: a session- or
app-scoped subscriber never matches the event (different surface / no
`sessionId` in scope), and a per-tenant child bus wrapping the gateway
bus never sees another tenant's emit. Emitting with zero subscribers
is safe.

**Client does not auto-react yet.** The runtime capability re-sync —
the client keeping its own `capabilities` fresh when the extension set
mutates — is deferred to #308. The wire-extension registry is sealed
at gateway construction today, so `gateway:capabilities:changed` cannot
fire in normal operation until dynamic extensions land; the emit seam
and its end-to-end delivery are proven now. See the e2e coverage below.

> **Verified by** `src/__tests__/emit-capabilities-changed.spec.ts`
> (event shape, scope-query + child-bus isolation, per-call ordering,
> zero-subscriber safety, and rip-out completeness — `notify` /
> `acceptConnection` / `onDeliveryError` are absent) and
> `@agentick/transport-in-process`'s
> `src/__tests__/capabilities-changed-e2e.spec.ts` (full emit → bus →
> `sub/subscribe` → subscriber delivery, fan-out to every gateway-scope
> subscriber). See [ADR 47](../../docs/proposals/v2/blueprint/47-reactive-signals-ride-the-bus.md).

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
import { websocketServer } from "@agentick/transport-websocket/server";

const httpServer = createServer();
websocketServer({ httpServer, gateway });
httpServer.listen(8080);
```

Every transport routes wire frames through the one shared dispatcher —
`dispatchRequest` in `@agentick/transport` — which calls into
`GatewayHarnessProtocol` methods directly. `websocketServer` is a thin
socket adapter over it; there is no bespoke per-transport wire logic.

## Verified by

| Concern                                                            | Test file                                                    |
| ------------------------------------------------------------------ | ------------------------------------------------------------ |
| Construction + default in-memory substrate                         | `src/__tests__/harness.spec.ts`                              |
| `createApp` with default gateway-substrate inheritance             | `src/__tests__/harness.spec.ts`                              |
| `createApp` with per-app substrate factory override                | `src/__tests__/harness.spec.ts`                              |
| `apps()` / `app(id)` read-side                                     | `src/__tests__/harness.spec.ts`                              |
| `close()` cascades into app closes                                 | `src/__tests__/harness.spec.ts`                              |
| `createApp` before `listen()` throws `GatewayNotStartedError`      | `src/__tests__/harness.spec.ts`                              |
| `events()` observes app-level events via fan-in                    | `src/__tests__/harness.spec.ts`                              |
| Duplicate `appId` rejection                                        | `src/__tests__/harness.spec.ts`                              |
| `GatewayClosedError` after close                                   | `src/__tests__/harness.spec.ts`                              |
| Wire extension registry — register / resolve / seal                | `src/__tests__/wire-registry.spec.ts`                        |
| Wire extension dispatch end-to-end                                 | `../transport/src/__tests__/wire-extension-dispatch.spec.ts` |
| Framework wire extensions + namespace-conflict reject              | `src/__tests__/wire-framework-extensions.spec.ts`            |
| `listen()` fans out to `transport.listen(this)` (host === gateway) | `src/__tests__/server-transports.spec.ts`                    |
| `close()` closes every owned transport (transports-first LIFO)     | `src/__tests__/server-transports.spec.ts`                    |
| `listen()` idempotency does not re-fire `transport.listen`         | `src/__tests__/server-transports.spec.ts`                    |
| Zero-transport `listen()` no-op fan-out                            | `src/__tests__/server-transports.spec.ts`                    |
| `ServerTransport` conformance (spy double)                         | `src/__tests__/server-transports.spec.ts`                    |
| Client tool-output bounding (block bounder + marker + seam)        | `../spec/src/__tests__/tool-output-bound.spec.ts`            |
| Bounding at the wire funnel — result + notifications, no straddle  | `../transport/src/__tests__/client-projection.spec.ts`       |
| Telemetry — gateway-op span export + app inheritance + override    | `src/__tests__/telemetry-inheritance.spec.ts`                |

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

- **The gateway OWNS the transport fan-out, not the concrete
  transports.** ADR 84 §2 landed `transports?: ServerTransport[]` +
  the `listen()`/`close()` fan-out here (see "Lifecycle &
  transports"). All five concrete wrappers ship from their
  `@agentick/transport-*-next` packages: `webSocketServerTransport` /
  `httpServerTransport` / `unixSocketServerTransport` /
  `inProcessServerTransport` / `fetchServerTransport` (the embedded
  door). Plugins/auth remain extensions (shape-1 per ADR 32).
- **No cluster substrate.** ADR 29 Phase D substrate (Redis Streams /
  Kafka) lands in `@agentick/cluster`; this package's
  `GatewayHarness` accepts any `EventBus` impl so cluster mode is
  a substrate swap, not a gateway rewrite.
- `GatewayHarnessProtocol.createApp` **is on the concrete impl, not
  the protocol** — see comments in the implementation. Typing input
  opts in spec would force pulling `@agentick/app` types into
  spec. Concrete impls expose their typed `createApp`; protocol
  consumers can enumerate apps but not construct them.
- `AppHarnessProtocol.id` **/** `SessionHarnessProtocol.id` added in
  Phase 5 follow-up (2026-06-07). Gateway gains a public `id` too
  for cluster routing.
- **No** `GatewayExtension` **impls yet.** ADR 32 names the extension
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
- `bridges()` **on wire-extension context is empty.** No
  framework-supplied extension needs bridges today. Phase F (#298 —
  `mcpControlWireExtension`) is the first consumer; it will resolve
  bridges from the target session's session-extension registry.
- `_extensions/list` **is unauthenticated for now.** Discovery is
  intended to be open — clients need it to know what they can
  reach. If future deployments want gated discovery, the wire method
  can grow an auth entry in Phase C.

## Development plan

| Phase             | What lands                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Phase 4 (done)    | This package — gateway scaffold                                                                                     |
| Phase 5 (done)    | `AppHarnessProtocol.id` / `SessionHarnessProtocol.id`                                                               |
| Phase 33.C–E      | Transports mount on `GatewayHarness` (no changes to this package)                                                   |
| Phase 33.D (done) | Shared dispatcher `dispatchRequest` landed in `@agentick/transport` — every transport routes wire frames through it |
| ADR 34            | `@agentick/auth` adds a `GatewayExtension` for auth                                                                 |
| Phase 33.I        | `@agentick/mcp-surface` adds a `GatewayExtension` that mounts MCP method namespaces                                 |
| ADR 29 Phase D    | `@agentick/cluster` substrate impl — gateway gets a cluster journal/bus                                             |
