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
`GatewayHarness` scaffold. It implements `GatewayHarnessProtocol` from `@agentick/spec-next` and is the
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

const app = await gateway.createApp(<MyAgent />, {
  appId: "my-app",
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
  transports?: readonly ServerTransport[]; // ADR 84 — see "Lifecycle & transports"
  authorizer?: Authorizer; // authz policy — see "Authentication & authorization"
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
  createApp<P>(rootElement: unknown, input: Omit<CreateGatewayAppInput<P>, "rootElement">): Promise<AppHarnessProtocol<P>>;
  createApp<P>(input: CreateGatewayAppInput<P>): Promise<AppHarnessProtocol<P>>;
  events(filter?: EventQuery, options?: SubscribeOptions): AsyncIterable<ProtocolEvent>;
  wireExtensions(): WireExtensionRegistry; // ADR 46 — see below
  emitCapabilitiesChanged(): void; // ADR 47 — see "Server-initiated notifications"
  listen(): Promise<void>; // ADR 84 — bind transports, flip ready
  closeGateway(opts?: { drain?: boolean }): Promise<void>;
  close(opts?: { drain?: boolean }): Promise<void>; // alias for closeGateway
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
owns only the fan-out. `spyServerTransport()` (`@agentick/gateway-next/testing`)
is a call-recording double for asserting the fan-out in tests.



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

`session/send` fans TWO sources onto the caller's `_meta.progressToken`
(ADR 64 / #19-progress-wire): (1) the handle's execution-event stream,
and (2) `ctx.progress` SIGNALS — a tool (or any harness) emitting
`<surface>:signal:progress` bus events scoped to the in-flight
execution. The gateway bus is the fan-in root, so the send handler
observes a tool's `ctx.progress` via `ctx.gateway.events(...)` scoped to
`{ executionId }` and forwards each onto the reporter — the agentick
client receives it on `client.transport.progress(token)`, exactly as an
MCP client would receive `notifications/progress`. Verified end-to-end
by `@agentick/transport-in-process-next`'s
`src/__tests__/progress-signal-e2e.spec.ts`.

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
and `[@agentick/spec-next/wire](../spec/src/wire/README.md)` for the
extension authoring guide.

## Authentication & authorization

Two edges, each crossed exactly once (ADR 51). **Authentication** turns a
credential into an identity at ingress; **authorization** decides — at a single
choke point, before any handler runs — whether that identity may call the method.
Harnesses are authz-unaware: there are no in-handler permission checks.

```text
  client ──token──▶  AuthSource.authenticate  ──▶  IngressIdentity { principal, scopes }
                     (ingress · fail-closed)

  request ─────────▶  dispatch choke point  (@agentick/transport-next)
                       1. session requiredScopes ceiling   (#199 — un-waivable)
                       2. verb-derived scope                (session/send → session:send)
                       3. + declared role                   (WireExtension.auth — additive)
                       ▼ allowed
                     handler runs
```



### 1. Authentication — the `AuthSource`

An `AuthSource` maps a presented credential (bearer token) to an
`IngressIdentity` (`{ principal, scopes, user? }`), stamped on the connection at
ingress. `staticTokenAuthSource` (from `@agentick/transport-next`) is the bundled
table form; OAuth/JWT sources produce the same shape from token claims.

```ts
import { staticTokenAuthSource } from "@agentick/transport-next";

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

### 2. Authorization — the `Authorizer` (your policy)

`createGateway({ authorizer })` sets the policy. The triad (ADR 51 §4.2): the
framework owns the enforcement point (the dispatch choke point), the `Authorizer`
is the port, the **policy is yours**. Bundled authorizers cover the poles:

```ts
import { createGateway, staticAuthorizer } from "@agentick/gateway-next";

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
place of it. A role can only *tighten*, so a method is never reachable under a
label different from its verb (§3.3 anti-bypass). `crm/deleteContact` requires
BOTH `crm:deleteContact` AND `crm:admin`.
- **absent** → verb scope, gated (the default; the common case).



### The structural ceiling (`requiredScopes`)

A session may carry `requiredScopes` (resource-declared identity, ADR 48/#199).
The choke point checks it **first** and **no authorizer can waive it** — not an
absent one, not a `permissiveAuthorizer`, not a `required: false` method. It's the
floor beneath policy: hold the ceiling scopes, or you never reach the session at
all.

> **Verified by** `@agentick/transport-next` — `wire-declarative-auth.spec.ts`
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

> **Verified by** `@agentick/transport-next` — `authorize-seam.spec.ts`
> (contextual scope flips a policy deny→allow around a live dispatch;
> `onAfterAuthorizerAuthorize` observes; the `requiredScopes` ceiling denies
> regardless and the hook never fires). Name-locked in
> `@agentick/runtime-next` `hook-lifecycle-names.spec.ts`. See
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
> mount and nothing is registered). Name-locked in `@agentick/runtime-next`
> `hook-lifecycle-names.spec.ts`.

### 4. Contextual policy — guards on the seam (ADR 83)

The `Authorizer` (§2) and the structural ceiling are **coarse, structural, and
un-waivable** — the security boundary. They answer "may this principal call this
verb at all," from the credential + scopes, *before* the handler runs. They are
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

The two layers compose cleanly: **authz decides *reachability* (structural,
un-waivable); the hook/guard decides *this specific call* (contextual)** — and
the guard only ever sees calls the authorizer already admitted. A guard can
`veto`, `replace` (serve a cached result), `defer` (rate-limit → retry-later), or
observe (audit). This is the whole point of routing wire dispatch through the
seam: your app's auth/authz can be as bespoke as it needs, **without touching the
framework's enforcement point** — which is exactly why the `Authorizer` stays a
structural pre-gate and does NOT itself become a hook.

> The `wire:` prefix keeps the two seams distinct (ADR 83 wire section): the
> WIRE hops — `client` (request leaving, keyed off `WireMethods`) and `gateway`
> (wire dispatch arriving) — share `onBeforeWireSessionSend`; the `session:send`
> **op** is `onBeforeSessionSend`, which a gateway registration folds down to
> live. Distinct names, one fire each. See
> [`docs/proposals/v2/HOOK-LIFECYCLE.md`](../../docs/proposals/v2/HOOK-LIFECYCLE.md).

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
> `@agentick/transport-in-process-next`'s
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
import { websocketServer } from "@agentick/transport-websocket-next/server";

const httpServer = createServer();
websocketServer({ httpServer, gateway });
httpServer.listen(8080);
```

Every transport routes wire frames through the one shared dispatcher —
`dispatchRequest` in `@agentick/transport-next` — which calls into
`GatewayHarnessProtocol` methods directly. `websocketServer` is a thin
socket adapter over it; there is no bespoke per-transport wire logic.

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
| `listen()` fans out to `transport.listen(this)` (host === gateway) | `src/__tests__/server-transports.spec.ts`         |
| `close()` closes every owned transport (transports-first LIFO) | `src/__tests__/server-transports.spec.ts`             |
| `listen()` idempotency does not re-fire `transport.listen` | `src/__tests__/server-transports.spec.ts`                |
| Zero-transport `listen()` no-op fan-out                | `src/__tests__/server-transports.spec.ts`                    |
| `ServerTransport` conformance (spy double)             | `src/__tests__/server-transports.spec.ts`                    |




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
transports"). The concrete wrappers (`webSocket` / `http` /
`unixSocket` / `inProcess`) still ship as separate
`@agentick/transport-*-next` packages (ADR 31 + ADR 32) — the
follow-on task. Plugins/auth remain extensions (shape-1 per ADR 32).
- **No cluster substrate.** ADR 29 Phase D substrate (Redis Streams /
Kafka) lands in `@agentick/cluster-next`; this package's
`GatewayHarness` accepts any `EventBus` impl so cluster mode is
a substrate swap, not a gateway rewrite.
- `GatewayHarnessProtocol.createApp` **is on the concrete impl, not
the protocol** — see comments in the implementation. Typing input
opts in spec would force pulling `@agentick/app-next` types into
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


| Phase             | What lands                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Phase 4 (done)    | This package — gateway scaffold                                                                                          |
| Phase 5 (done)    | `AppHarnessProtocol.id` / `SessionHarnessProtocol.id`                                                                    |
| Phase 33.C–E      | Transports mount on `GatewayHarness` (no changes to this package)                                                        |
| Phase 33.D (done) | Shared dispatcher `dispatchRequest` landed in `@agentick/transport-next` — every transport routes wire frames through it |
| ADR 34            | `@agentick/auth-next` adds a `GatewayExtension` for auth                                                                 |
| Phase 33.I        | `@agentick/mcp-surface-next` adds a `GatewayExtension` that mounts MCP method namespaces                                 |
| ADR 29 Phase D    | `@agentick/cluster-next` substrate impl — gateway gets a cluster journal/bus                                             |


