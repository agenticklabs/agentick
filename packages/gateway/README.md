# @agentick/gateway

**One door.** A gateway is the deployment root: it hosts the apps, owns the substrate they inherit, owns the server transports, and is the single point every inbound request crosses — authenticated once at ingress, authorized once before any handler runs, dispatched through one registry.

That singularity is the bet. Because there is exactly one choke point, the security story lives in exactly one place and no harness beneath it contains a permission check. Because every method — framework or adopter — resolves through one registry, a new capability is a new _declaration_, never new plumbing. And because the wire crossing is one funnel, a policy like "bound oversized tool output sent to browsers" is configured once and cannot be bypassed by some other frame.

## Install

```bash
npm install @agentick/gateway
```

Subpaths: `/testing` (a call-recording `ServerTransport` double).

## Quick start

```ts
import { createGateway } from "@agentick/gateway";
import { reactCompiler } from "@agentick/compiler-react";

const gateway = await createGateway();
await gateway.listen(); // bind transports, flip ready — required before createApp

const app = await gateway.createApp(<Agent />, {
  appId: "support",
  options: { compiler: reactCompiler(), model },
});

const session = await app.createSession({});
const handle = await session.send({ messages: [{ role: "user", content: "hello" }] });
await handle.result;

await gateway.close(); // transports → apps → extensions → substrate
```

> [!IMPORTANT]
> `listen()` is required before `createApp`. Calling `createApp` first throws `GatewayNotStartedError` — the ordering guarantees the `gateway:start` seam has fired (and any extension has installed) before a single app mounts. `listen()` with zero transports is a clean no-op that just flips ready, so the rule costs an embedded deploy nothing.

## Hosting apps

`createApp` takes the same two-door shape as the top-level factory — element-plus-options, or one input object. Apps inherit the gateway's journal, bus, and inbox unless they pass their own:

```ts
const gateway = await createGateway();
await gateway.listen();

// Inherits the gateway substrate.
const tenantA = await gateway.createApp({ appId: "tenant-a", rootElement: <AgentA />, options });

// Own bus + journal, still reachable through the same gateway.
const tenantB = await gateway.createApp({
  appId: "tenant-b",
  rootElement: <AgentB />,
  options: { ...options, bus: new LocalEventBus(), journal: new MemoryJournal() },
});

gateway.apps(); // readonly AppHarnessProtocol[]
gateway.app("tenant-a"); // by id, or undefined
```

Duplicate `appId` is rejected, and `createApp` after `close()` is rejected. Substrate slots accept an instance **or** a factory; a factory receives the gateway's own substrate as its parent, which is how an app wraps rather than replaces what it inherits.

### What a client can see of an app

`gateway/list_apps` and `gateway/get_app` project each app as an `AppInfo` — the same `id` / `title` / `description` triple a tool or a prompt declares:

```ts
const { apps } = await client.gateway.listApps();
// [{ id: "tenant-a", title: "Ernesto", description: "Knowify's assistant" }]
```

`id` is what a client routes on; `title` is what it renders — and what it joins a session's owning app to in order to say who answered. Set them on the app:

```ts
await gateway.createApp({
  appId: "tenant-a",
  rootElement: <Root />,
  options: { ...options, title: "Ernesto", description: "Knowify's assistant" },
});
```

Both are omitted from the projection when unset rather than sent as `null`, so a client falls back to `id` on presence. An app that never faces a person needs neither.

### Reaching a session without naming its app

A client that listed threads across apps holds session ids, not app ids. `gateway/destroy_session` takes only the session id and resolves the owner itself — live registries first, then the apps' session stores, so a paged-out or closed session still resolves:

```ts
const { appId, live, record } = await client.gateway.destroySession("sess-123");
appId; // which app owned it — absent when nothing claimed the id
```

It is the same verb as [`app.destroySession`](../app#close-vs-destroy) with the same semantics and the same idempotency; only the addressing differs. Ownership is checked twice, as it is there: the dispatch gate on the live session's principal, the handler on the durable record's.

`gateway.appForSession(id)` is the resolution on its own, for when you want the app rather than the destruction.

### Every thread on the gateway, in one list

The enumeration half of that pair: a client that can delete a session without naming its app has to be able to **find** one the same way. `gateway/list_sessions` unions every mounted app's session store into one recency-ordered list, and every row names the app it came from — which is what you then address its app-scoped verbs with.

```ts
const { sessions, nextCursor } = await client.gateway.listSessions({ status: "active" }, { limit: 50 });
sessions[0].appId; // stamped from the app the row was READ from, never copied off the record
await client.gateway.app(sessions[0].appId).session(sessions[0].id).send({ ... });
```

**Scoped to the caller, and the only thing scoping it.** A cross-app list names no session, so the dispatch gate's same-principal target rule has nothing to resolve. Scoping rides the query (`principal`) so it reaches whichever source answers and is honored _inside_ the page — a filter applied after the page is cut returns short pages. Another principal's threads are absent, not an error.

### Gateway indexes — the cross-app query door

`gateway/list_sessions` has **two modes**, and which one you get is a deployment decision.

```ts
const gateway = await createGateway({ sessionIndex: myPostgresSessionIndex });
```

**Index mounted.** One query per page against a source that already holds every app's rows — in a real deployment, the one table with an `app_id` column that all your apps write to. The index owns its ordering and mints its own cursor; the gateway delegates and adds nothing, not even a re-sort.

**No index.** The gateway reads every mounted app's store and merges. Correct, and the honest default, but N reads per page — and the framework has to impose the merged ordering (`updatedAt` descending, ties by `id` then `appId`). This is the **degraded** mode. A failing app contributes nothing rather than failing the call, matching `appForSession`: one sick app must not blind the gateway to the rest.

A caller cannot tell which mode answered — same envelope, same opaque cursor. Only the cost differs.

The framework cannot mount an index for you, because it does not know whether two apps share a backend: an app on Postgres beside one on an in-memory store cannot be served by one query, and pretending otherwise would be a fast wrong answer.

**This is a pattern, not a one-off.** Agentick scopes a store where its records are _owned_ — sessions and tasks belong to an app, so those stores are app-scoped (ADR 68 made exactly this lift when it moved the task store from session scope to app scope, so "this app's tasks" became one query instead of a fan-out). A gateway index is that same lift one scope further up, and it always has this shape: an optional adopter-provided door, with a k-way merge fallback. `gateway/list_tasks` is the anticipated second tenant and gets a `taskIndex` slot beside this one, with nothing renamed.

**Ordering policy lives here too**, which is a reason to mount an index independent of scale. `SessionStore.page` must return the framework's canonical order — N of those get merged, so they have to agree. Nothing merges an index's output, so an index is free to order by whatever the product needs: pinned first, unread first, relevance. Unread counts and inbox projections are the natural things to join against this door next, which is why its rows are durable records rather than a wire shape.

**Why the fallback's cursor is the framework's rather than a bag of the stores' own.** A merged page of 50 rows might draw 48 from one app and 2 from another. Resuming means recording that 2 rows of the second stream were consumed — but that store's token is opaque and advances a whole page at a time, with no rewind. Recording a per-app _position_ instead requires a key the framework can compare, at which point the bag is exactly equivalent to one merged key (the session sort key is total across apps) and strictly more machinery. So the merge owns the ordering and therefore mints the cursor.

`gateway.listSessions(query, page)` is the same read in process, both modes included.

There is no `session.added` / `session.removed` notification on this namespace, and there should not be: `app:command:create-session`, `app:command:destroy-session`, and `session:command:close` all land on the app bus already, so a client subscribed to an app scope sees sessions appear and disappear. Enumeration plus the events that already exist is the collection contract.

### Gating and shaping the mount

`createApp` is itself a hookable operation, so the gateway is where a multi-tenant provisioning gate belongs — before the app is constructed:

```ts
gateway.hooks.onBeforeGatewayCreateApp((input) => {
  const tenant = input.metadata?.tenantId as string | undefined;
  if (!isProvisioned(tenant)) throw new Error("tenant not provisioned"); // veto the mount
  return { ...input, appId: `tenant:${tenant}` }; // or reshape it
});
```

A throwing before-hook vetoes the mount and nothing is registered. `onAfterGatewayCreateApp` observes the mounted app.

### Baseline tools for every agent in the process

`tools` at the gateway is the lowest rung of the tool precedence ladder: every session of every hosted app sees them, tagged with a gateway binding, and any app-, session-, or execution-scoped tool of the same name wins.

```ts
const gateway = await createGateway({ tools: [healthCheckDeclaration] });
```

Use it for the process-wide baseline — a health check, a telemetry probe — not for agent behavior.

> [!NOTE]
> If you replace an app's tool executor with your own `ToolExecutorFactory`, you bypass the bundled registry and must thread `inheritedTools` yourself.

### Hooks fold downward, live

A hook registered on the gateway reaches operations in sessions that **already exist** — the fold is live, not a snapshot taken at construction — and unsubscribing cascades back out:

```ts
const off = gateway.hook({
  onBeforeToolDispatch: (input) => ({ ...input, input: redact(input.input) }),
});
// every session's tool executor now sees the redacted input, including
// sessions created before this line ran
off(); // and now they see raw input again
```

## The lifecycle pair

The gateway is a server, so it takes the canonical pair — `listen()` to start, `close({ drain })` to stop. Graceful-versus-forced is a parameter, not a second terminal verb.

The gateway **owns** its transports. Each `ServerTransport` binds its own wire config (port, path, TLS) at its own construction, so the gateway only hands it the dispatch host:

```ts
import { webSocketServerTransport } from "@agentick/transport-websocket";
import { inProcessServerTransport } from "@agentick/transport-in-process";

const gateway = await createGateway({
  transports: [webSocketServerTransport({ port: 8080 }), inProcessServerTransport()],
});

await gateway.listen(); // fans out transport.listen(this) — `this` is the dispatch host
await gateway.close(); // transports FIRST, then apps, then extensions, then substrate
```

Transports close first because they are the ingress edge: stopping them before apps tear down prevents an inbound frame routing into a half-closed app. `listen()` is idempotent — a started-latch short-circuits before the operation fires, so a second call does not re-listen anything. A transport whose `close()` rejects never blocks the rest of teardown.

The concrete wrappers ship from their own packages — [@agentick/transport-websocket](../transport-websocket), [@agentick/transport-http](../transport-http), [@agentick/transport-unix-socket](../transport-unix-socket), [@agentick/transport-in-process](../transport-in-process). This package owns only the fan-out.

### Embedding in a server you already own

If you have an HTTP framework and your auth already ran, `fetchServerTransport` is the door: a web-standard handler for your route table, plus a `ServerTransport` you register here so `listen()`/`close()` govern it like every other edge.

```ts
import { fetchServerTransport } from "@agentick/transport-http/fetch";

const { transport, handler } = fetchServerTransport({
  identity: async (req) => {
    const user = await myAuth(req); // YOUR auth — hand us the result, never the token
    if (!user) return new Response(null, { status: 401 }); // returned verbatim
    return { principal: user.id, user: { tenantId: user.tenantId }, scopes: user.scopes };
  },
});

app.all("/agentick/*", (c) => handler(c.req.raw)); // Hono, at setup time

const gateway = await createGateway({ transports: [transport] });
await gateway.listen();
```

Embedding into a Node server (Express, Fastify, Nest) needs no fetch door at all: the websocket and HTTP transports both take `{ httpServer }` instead of `{ port }` and attach to yours without ever closing it.

### Admitting a connection

`accept(info)` fires once per newly-accepted persistent connection — after ingress authentication, before the connection is wired to receive frames. Throw to drop it:

```ts
gateway.hooks.onBeforeGatewayAccept((info) => {
  if (tooManyConnections(info.identity?.principal)) throw new Error("connection limit");
  return info; // admit
});
```

> [!IMPORTANT]
> `accept` is a **connection** concept; `authorize` is a **request** concept. Connection-oriented transports (WebSocket, Unix socket) fire `accept` once per connection and then `authorize` per request. Request-oriented HTTP has no persistent connection to admit, so it fires `authorize` and **never** `accept`. A per-request decision belongs in `authorize` regardless of transport.

## Authentication — identity at ingress

An `AuthSource` maps a presented credential to an `IngressIdentity` (`{ principal, scopes, user? }`) stamped on the connection once, at ingress. Everything downstream reads the stamp; it is never re-derived.

```ts
import { staticTokenAuthSource } from "@agentick/transport";

const authSource = staticTokenAuthSource({
  tokens: {
    "tok-alice": { principal: "alice", scopes: ["session:send", "knobs:set"] },
    "tok-root": { principal: "root", scopes: ["*"] },
  },
  // allowAnonymous: false (default) — a configured source REJECTS a missing token
});
```

Two poles, deliberately:

- **No** `AuthSource` → the local/trusted pole. No principal is stamped; only the anonymous path the authorizer permits passes.
- `AuthSource` **configured** → **fail-closed**. A missing or invalid credential is rejected at ingress, before dispatch runs at all.

### Acting on who is calling

Authorization decides _whether_ a call proceeds. When a handler must instead act on _who_ is calling — stamp the caller onto a record, branch on a tenant — the stamped identity rides every `wire:<method>` operation, so a before-hook reads it and reshapes the params. The caller cannot forge it, because it comes from the ingress stamp and never from the body:

```ts
gateway.hook({
  onBeforeWireAppCreateSession: (params, ctx) => ({
    ...params,
    metadata: { ...params.metadata, principal: ctx.identity?.principal },
  }),
});
```

`ctx.identity` is the full `IngressIdentity` — the structured twin of the `ctx.principal` string, carrying your `user` record and the credential's scopes. It is `undefined` on the unauthenticated pole, and it rides **only** the `wire:*` operation: an inner operation the handler triggers sees no identity, so request identity never leaks into ordinary command context.

Distinctly, `app/create_session` stamps the session's own **owning principal** from `ctx.principal` onto both the live session and the durable record. The wire params type carries no `principal` field, so a value smuggled into the request body is never read — ownership is the edge's to assert, not the caller's to claim. Children inherit it through `spawn` and `fork`, and the same-principal rule then forbids a caller reaching a session owned by someone else.

## Authorization — one gate, both lanes

```text
  client ──token──▶  AuthSource.authenticate  ──▶  IngressIdentity { principal, scopes }
                     (ingress · fail-closed)

  request ─────────▶  dispatch choke point
                       1. session requiredScopes ceiling   (un-waivable)
                       2. verb-derived scope                (session/send → session:send)
                       3. + declared role                   (additive)
                       ▼ allowed
                     handler runs
```

The framework owns the enforcement point. The `Authorizer` is the port. **The policy is yours.** Bundled implementations cover the poles:

```ts
import { createGateway, staticAuthorizer } from "@agentick/gateway";

const gateway = await createGateway({
  authorizer: staticAuthorizer({
    grants: { alice: ["session:*", "knobs:set"], root: ["*"] },
    // anonymous: [] (default) — unauthenticated callers are denied everything
  }),
});
```

| Authorizer                   | Policy                                                                      |
| ---------------------------- | --------------------------------------------------------------------------- |
| `staticAuthorizer({grants})` | Server-side table: principal → scope patterns. Cover-aware (`session:*`).   |
| `claimsAuthorizer()`         | Allow iff the credential's own scope claims cover the ask (OAuth-shaped).   |
| `permissiveAuthorizer()`     | Allow everything. Explicit opt-in for no-auth local deploys.                |
| `unconfiguredAuthorizer()`   | **The default.** Deny every authenticated principal; only anonymous passes. |

> [!WARNING]
> The default is deny-by-default on purpose: an authenticated principal against no policy is a misconfiguration, not an invitation. You never ship ungated by accident — but that also means adding an `AuthSource` without an `authorizer` locks everyone out.

Every authorizer enforces the same-principal target rule: a method aimed at a session owned by a different principal is denied.

### What scope a method requires

Every method is gated by default, and its scope **defaults to the verb name** — `crm/deleteContact` requires `crm:deleteContact`. Grants are therefore written once and cover both the named-method lane and the dynamic lane. Declare `auth` to change a method's requirement:

```ts
const crmExt = defineWireExtension({
  name: "@my-org/crm",
  namespace: "crm",
  methods: {
    /* … */
  },
  auth: {
    "crm/health": { required: false }, // OPEN — policy skipped
    "crm/deleteContact": { required: true, scope: "crm:admin" }, // verb scope AND role
    // unlisted → gated by verb scope
  },
});
```

- `required: false` → **open**: policy is skipped. The target session's `requiredScopes` ceiling still applies.
- `scope: "role"` → **additive**, never a replacement. A role can only tighten, so a method is never reachable under a label different from its verb. `crm/deleteContact` needs **both** `crm:deleteContact` and `crm:admin`.
- absent → verb scope, gated. The common case.

### Granting a client read

Reads are commands too, so exposing one to a browser is a grant — never a code change. The framework's worked example is timeline scroll-back: `@agentick/timeline` declares `timeline:history` with `exposure: "wire"`, the dynamic lane projects it as `timeline/history`, and the choke point derives the scope label `timeline:history`. Nothing else is needed server-side; what varies is who you grant it to:

```ts
const gateway = await createGateway({
  authorizer: staticAuthorizer({
    grants: {
      // A chat UI: read the conversation back, nothing else on the surface.
      "acme/viewer": ["timeline:history"],
      // An operator console: the whole surface — reads AND compaction.
      "acme/operator": ["timeline:*"],
    },
  }),
});
```

Then the client pages its own session's log — `client.session(id).timeline.history({ fromSeq, toSeq, limit })` or the tail-anchored `loadOlder()`:

- **`"acme/viewer"`** reads. `timeline:history` covers exactly the read.
- **A principal granted `timeline:compact`** does not. A sibling-verb grant never leaks the read.
- **An ungranted principal** gets `Forbidden`; an unauthenticated one gets nothing (no `anonymous` grants by default).
- **Any principal, calling `timeline/append`** gets `MethodNotFound`. The write verbs aren't wire-exposed, so no grant can reach them — exposure is the harness author's curation, and it comes first.

**Tenancy needs no work: it is already structural.** A read names a session, so the choke point resolves that session's owning principal and the same-principal target rule denies a caller who is not it — even one holding `*`. Two callers with identical `*` grants cannot read each other's history. You do not write a per-read tenancy guard, and there is no timeline-specific check to forget.

Write a guard only when your rule is **narrower** than "same principal" — a row-level policy, a page-size cap, a read window that closes after the tenant's retention period. That is the definition's `guards:` bag on the read verb, and it fires for in-process reads as well as wire ones:

```ts
// The definition, not the gateway: local policy lives with the namespace.
// App and gateway guards still wrap it — governance outranks local policy.
defineTimeline({
  store,
  guards: {
    history: (input, ctx) =>
      withinRetention(ctx.sessionId, input.fromSeq ?? input.toSeq)
        ? undefined // proceed
        : { kind: "veto", reason: "outside the retention window" },
    // Cap the page a client can demand, whatever it asks for.
    // history: (input) => ((input.limit ?? Infinity) > 500 ? { kind: "veto" } : undefined),
  },
});
```

A veto surfaces to the client as `Forbidden`, a `defer` as a rate-limit with `retryAfter`. And because the read is an operation like any other, `onBeforeTimelineHistory` / `onAfterTimelineHistory` fold down from the gateway for audit — while the read itself is journaled bus-only, so paging a long log does not grow the durable spine.

> [!NOTE]
> A namespace guard's `ctx` identifies the resource (`ctx.sessionId`), not the caller: bridge harnesses are not principal-stamped, so `ctx.principal` is undefined there. Key local rules on the resource and leave cross-principal admission to the choke point, which is the layer that has the caller's identity.

### The structural ceiling

A session may carry `requiredScopes`. The choke point checks it **first**, and **no authorizer can waive it** — not an absent one, not `permissiveAuthorizer()`, not a `required: false` method, not a hook. Hold the ceiling scopes or you never reach the session.

### The contextual layer

The policy call is itself a hookable operation, which gives auth two layers that must not be confused. The **floor** — the ceiling check — runs before the operation fires, so a hook granting `["*"]` still cannot save a caller who lacks the ceiling scope; the hook never even runs. The **fine layer** runs around each policy ask and can grant a contextual scope the static table could not know about, or throw to deny:

```ts
gateway.hooks.onBeforeAuthorizerAuthorize((input) =>
  tenantHasEntitlement(input.principal, input.scope)
    ? { ...input, tokenScopes: [...(input.tokenScopes ?? []), input.scope] }
    : input,
);
gateway.hooks.onAfterAuthorizerAuthorize((result) => {
  audit.record(result);
  return result;
});
```

For richer per-call admission — "deny this send while the tenant is over quota", "rate-limit per session" — use the interceptor seam. Wire dispatch routes through the gateway's operation spine, so a gateway hook or guard fires around dispatch, **after** the authorizer pre-gate:

```ts
// Per-verb typed veto. `session:send` folds live from the gateway down to
// every session and fires once per send — wire-originated or in-process.
gateway.hooks.onBeforeSessionSend((params, ctx) => {
  if (overQuota(ctx.principal)) throw new Error("quota exceeded"); // any throw vetoes
  return params;
});

// Wire-boundary only — fires just for dispatches arriving over a transport.
gateway.hooks.onBeforeWireSessionSend((params) => params);

// Richer verdict. `guard` is harness-scoped, so branch on ctx.op to target a verb.
gateway.guard((params, ctx) =>
  ctx.op === "SessionSend" && rateLimited(ctx.principal)
    ? { kind: "defer", retryAfter: 1000 } // client is told to retry
    : { kind: "proceed" },
);
```

The layers compose cleanly: **authorization decides reachability** (structural, un-waivable); **the hook or guard decides this specific call** (contextual), and only ever sees calls the authorizer already admitted. Your app's admission logic can be as bespoke as it needs without touching the framework's enforcement point — which is exactly why the `Authorizer` stays a structural pre-gate and does not itself become a hook.

> [!NOTE]
> Only this one layer carries the `Wire` qualifier, because the gateway's dispatch boundary is the single place where `wire:session/send` and the folded `session:send` operation coexist. Everywhere else the operation name is unqualified, and the client mirrors it — `client.hook({ onBeforeSessionSend })` and `session.hook({ onBeforeSessionSend })` share the name.

## Wire extensions — your own namespace

An adopter extension contributes a JSON-RPC namespace the gateway routes to, reachable from [@agentick/client](../client). It is the same mechanism the framework's own `gateway/*`, `app/*`, `session/*`, and `sub/*` methods use — there is no privileged path.

Declaring the namespace is **two** steps, and both are required. First widen the method registry by declaration merging, which is what buys you typed params and results on both sides of the wire; then define the extension against those types:

```ts
import { createGateway } from "@agentick/gateway";
import { defineWireExtension } from "@agentick/spec";

declare module "@agentick/spec" {
  interface WireMethods {
    "crm/listContacts": { params: object; result: { contacts: Contact[] } };
    "crm/deleteContact": { params: { id: string }; result: null };
  }
  interface WireNotifications {
    "crm/contactChanged": { readonly id: string };
  }
}

const crmExt = defineWireExtension({
  name: "@my-org/crm",
  namespace: "crm",
  methods: {
    "crm/listContacts": async () => ({ contacts: await loadContacts() }),
    "crm/deleteContact": async ({ id }) => {
      await removeContact(id);
      return null;
    },
  },
  notifications: ["crm/contactChanged"],
});

const gateway = await createGateway({ wireExtensions: [crmExt] });
```

> [!IMPORTANT]
> `methods` is keyed by `keyof WireMethods`, so **without the augmentation the method names do not typecheck.** That is deliberate: one registry is the single source of truth for params and results, which is what makes `client.request("crm/listContacts", {})` typed for free rather than `any`. Put the `declare module` block in a file with at least one top-level `import` or `export` — a file containing only `declare module` is a script, and it will _shadow_ `@agentick/spec` instead of augmenting it.

Streaming methods reach their verbs through `ctx.wire` on the handler context: `progress(...)` for progress frames, `registerCancel(...)` for the cancellation seam, `registerSubscription(subscriptionId, cleanup)` for subscription fan-out.

`registerSubscription` takes the id rather than minting one: on `sub/subscribe` the CLIENT allocates the `subscriptionId` and the server adopts it verbatim, echoing it back as confirmation. That is what lets `sub/subscribe` splice a session channel's snapshot in front of the live stream and have a late subscriber actually receive it — the client registered its stream under that id before it wrote the request, so the opening frame is routable whether it lands before or after the response. A duplicate id on one connection is refused with `InvalidParams`.

### The method is a command

A method entry is either a bare handler (above) or a flat config object. The config attaches define-time seams to _this method's_ operation, reusing the interceptor and span seams rather than inventing a tier:

```ts
const crmExt = defineWireExtension({
  name: "@my-org/crm",
  namespace: "crm",
  methods: {
    "crm/deleteContact": {
      handler: async ({ contactId }) => ({ deleted: await removeContact(contactId) }),
      // Admission verdict, honored at the JSON-RPC edge: veto → Forbidden,
      // defer → rate-limited with a retry-after, replace → success frame
      // carrying the supplied result.
      guard: ({ contactId }) => (locked(contactId) ? { kind: "veto" } : undefined),
      // Wraps THIS method's dispatch only — never the nested session or tool
      // operations the handler triggers.
      middleware: async (params, next) => next(params),
      spanAttributes: { "crm.tier": "premium" },
      // Merged into the extension `auth` map; declaring both is an error.
      auth: { required: true, scope: "crm:admin" },
    },
  },
});
```

Each row also mints typed gateway hooks: `gateway.hook({ onBeforeWireCrmDeleteContact })` is typed params-in, result-out, and a before-hook may reshape the params the handler receives.

### Advertising the namespace

`_extensions/list` returns every registered extension. It is one of only three methods that dispatch outside the registry — with `initialize` and `ping` — because they must resolve before the registry is queryable. It is one of [two discovery doors](#discovery--two-doors): the one that answers what this _server_ registered.

```ts
const { extensions } = await client.request("_extensions/list", {});
// [{ name: "@my-org/crm", namespace: "crm", methods: [...], notifications: [...] }]
```

**Constraints.** Namespaces beginning `_` are reserved. The framework namespaces (`gateway`, `app`, `session`, `sub`) are registered first, so an adopter attempt to claim one fails with `WireExtensionDefinitionError`. Namespaces and extension names must be unique, and duplicates throw at construction time rather than on first request. The registry **seals** once the gateway is ready — to layer more extensions, reconstruct the gateway.

## The dynamic command lane

Named methods are the porcelain. Beneath them, one generic resolver projects **every** command a harness declares with `exposure: "wire"` onto the wire: `timeline/compact` derives the verb `timeline:compact`, passes the authorization gate, and is asked of the owning harness through the inbox.

That is what makes new capability a declaration rather than a feature. A harness that declares a wire-exposed command is reachable from any JSON-RPC client immediately — no method to write, no route to register.

```ts
// Enumerate what THIS caller can reach across a session's surfaces.
const { commands } = await client.request("commands/list", { sessionId });
// [{ method: "timeline/compact", command: { name: "timeline:compact", exposure: "wire", … } }]

// And call one.
await client.request("timeline/compact", { sessionId });
```

Resolution is **exact-beats-dynamic**: the resolver is consulted only when no named method matches, so an earned porcelain method shadows the auto-route by construction.

> [!IMPORTANT]
> The lane never ships without the gate. A verb not declared `exposure: "wire"` is indistinguishable from an absent method — `MethodNotFound`, not `Forbidden`, so probing reveals nothing. An exposed verb still requires a grant. And `commands/list` filters by what the caller holds, so discovery itself leaks nothing: a denied caller sees an empty list rather than a list of things they cannot call.

## Discovery — two doors

Methods reach the wire through two lanes — exact routes registered as wire extensions, and commands a harness declares `exposure: "wire"` — so there are two doors to knock on. Which one answers your question depends on whether you are asking about the **server** or about a **session**.

**`_extensions/list` — what did this server register.** Every exact route, framework or adopter, with its version, methods, and notifications. Server-wide and per-connection: the same answer for every session on it. [@agentick/client-core](../client-core) folds the reply into capability predicates during `connect()`:

```ts
await client.connect();

client.capabilities.hasNamespace("completions"); // is the feature deployed at all?
client.capabilities.hasMethod("knobs/set");
```

**`<ns>/commands` — what can this namespace do on this session.** Every harness serves its own declared-command list as a meta-verb on the dynamic lane, so the reply describes the harness actually mounted on _that_ session, each row carrying its `exposure` — which is how a caller tells a wire-reachable verb from an in-process-only one. It is an ordinary wire row, so it needs no client code:

```ts
const { commands } = await client.session(sessionId).prompts.commands();
// [{ name: "prompts:list", exposure: "wire", hasInput: true, description: "…" }, …]
```

Seven namespaces serve the per-namespace door today — `gates`, `knobs`, `mcp`, `prompts`, `resources`, `skills`, `timeline` — and `commands/list` is the cross-surface form of the same read: one call, every wire-exposed command across a session's surfaces. Reach for it from a client with no augmented method registry to read, which is every non-TypeScript one.

Use the first door for the build-time question — is this capability deployed at all — and the second for the runtime one: what is mounted on this session, and what may I call on it.

## Extensions and bundles

`extensions` is the higher-level surface above raw wire extensions. It accepts a bare gateway, app, or session extension, or a bundle composing several, and distributes the parts by scope: gateway parts install during construction, wire parts register before the registry seals, and app or session parts become **cascaded defaults** for every app and session beneath this gateway — composed before any per-call extension.

```ts
const gateway = await createGateway({ extensions: [myBundle, someSessionExtension] });
gateway.bridges.myThing; // whatever the gateway part installed
```

A gateway extension's `install` may be async and is awaited before the gateway is ready. A throwing `install` rejects `createGateway` outright rather than leaving a half-built gateway, and the wire registry is never left half-sealed. Bridge slots are hard singletons — an occupied slot throws. Teardown fires `onClose` handlers in reverse install order, after the apps close.

## Progress on a running turn

A `session/send` that carries `_meta.progressToken` opens a progress stream for that turn, and the gateway fans **two** producers onto it: the execution's own event stream, and the `ctx.progress(...)` signals its tools emit. Every frame is a self-describing envelope — `name` says which producer, `scope` says which session and execution emitted it — so one stream carries both without a second channel.

By default the signal half is scoped to the turn's own execution. That is right for the turn's own tools and blind to everything below it: a sub-agent runs its **own** execution, so its progress matched nothing and a caller watching a fan-out saw silence for exactly the work slow enough to need a bar. `fanIn` fixes that:

```ts
const turn = client.session("sess-123").send({ messages, fanIn: true });

for await (const frame of client.transport.progress(token)) {
  const { name, scope, payload } = frame.envelope;
  if (name === "tool:signal:progress") {
    // `scope.sessionId` attributes the frame; `payload.token` is the tool call id
    bar(scope.sessionId, payload.progress, payload.total);
  }
}
```

A signal joins the stream when its execution **is** this turn, or when the emitting session's lineage reaches this turn — the child, the grandchild, and work a descendant started from a later turn of its own. Membership is the same origin edge [`abortExecutionTree`](../app#the-cancellation-ladder) fans out over, read from the other end: `app.executionTreeContains(executionId, sessionId)` climbs the `parentSessionId` chain and stops at the first ancestor stamped with that origin execution.

**Two turns never see each other.** A sibling execution satisfies neither arm — not on this session, not on another, and neither do its descendants, because their lineage reaches the sibling's execution instead. Turning `fanIn` on widens a turn's stream along exactly one axis, lineage, and no other.

Three things it deliberately is not:

- **Not execution events.** Only signals fan in. What a child surfaces to its parent's event stream is decided at the harness level (`TickEndForwardDecision`), and a second answer at the wire would be a competing one.
- **Not durable.** Membership reads the live session registry, so a descendant whose ancestor has been paged out is unreachable and its signals do not arrive — the same limitation `abortExecutionTree`'s walk has, for the same reason: a per-event predicate must not do store reads.
- **Not the default.** Omitting `fanIn` produces a byte-identical request and byte-identical behavior. A UI built against one turn's frames should not start seeing another's because a tool learned to spawn.

## Watching a session's living subtree

`fanIn` widens one **turn**. A subscription is the other question: what a client attached to a session should see for as long as it stays attached. Sub-agents are the gap — a channel event is scoped to the session that emitted it, so a client watching a root's `task-status` sees nothing from the sub-agents that root spawns, and that is exactly the work worth watching, because a detached task or a cross-turn sub-agent outlives the turn that started it and has no turn stream to ride.

`{ kind: "session-tree", id }` is that scope:

```ts
const stream = client.session("sess-123").treeEvents({
  name: { exact: "session:channel:task-status" },
});

for await (const frame of stream) {
  // Which member emitted rides the envelope, exactly as it always has.
  board(frame.envelope.scope.sessionId, frame.envelope.payload);
}
```

Membership is **lineage**: `app.sessionTreeContains(rootId, emitterId)` climbs the `parentSessionId` chain from the emitting session and answers `true` on reaching the root. A descendant belongs whichever turn spawned it and keeps belonging after that turn settles — the opposite of `fanIn`'s rule, and deliberately, because a subscription outlives any one turn. The root **is** a member of its own tree, where an execution's origin session is not a member of that turn's: a session id names the session, an execution id names a turn the session moves past.

**A late joiner opens with the boards that already exist.** When the query targets exactly one channel, every live member's current snapshot is spliced ahead of the live tail, root first then breadth-first. A member spawned _after_ you subscribe needs no retro-splice: its channel emits as it populates, and the arrival filter is a live registry read, so the frame is admitted the moment it exists.

**The scope ladder, end to end:**

| Scope                           | What it observes                       | Lifetime         |
| ------------------------------- | -------------------------------------- | ---------------- |
| `session/send` with `fanIn`     | one turn's interior, incl. descendants | that turn        |
| `{ kind: "session" }`           | one session's own events               | the subscription |
| `{ kind: "session-tree" }`      | that session **and its live subtree**  | the subscription |
| `{ kind: "app" }` / `"gateway"` | one app / the whole deployment         | the subscription |

Authorization does not change: every scope kind passes the same `sub:subscribe` gate, and admitting a root admits its tree because principal descends the spawn tree. A tree subscription reaches nothing a session subscription on the same root could not.

## Observing the whole deployment

`gateway.events(filter?)` is an async iterable fanned in from every hosted app — the one place to watch a multi-app process:

```ts
for await (const ev of gateway.events()) {
  console.log(ev.scope.appId, ev.name);
}
```

Two control-plane signals are emitted onto the substrate bus rather than through a bespoke connection registry, so delivery, replay, reconnect-resume, and per-tenant isolation are the bus's job:

**`emitCapabilitiesChanged()`** appends one `gateway:capabilities:changed` event scoped to the gateway. A gateway-scope subscriber (opened via `sub/subscribe` on `{ surface: "gateway" }`) receives it; a session- or app-scoped subscriber never matches, and a per-tenant child bus never sees another tenant's emit. Emitting with zero subscribers is safe.

**`emitAdmissionFailure(failure)`** appends a `gateway:admission:failed` event. An ingress crossing refused at admission runs no work, so there is no operation to journal — but the attempt must still be visible, or a client probing the edge leaves no trace. Every server transport calls this from its rejection path; adopters rarely call it directly.

```ts
import { GATEWAY_ADMISSION_FAILED, type IngressAdmissionFailure } from "@agentick/spec";

for await (const e of gateway.events({
  surface: "gateway",
  name: { exact: GATEWAY_ADMISSION_FAILED },
})) {
  const f = e.payload as IngressAdmissionFailure;
  metrics.count("ingress.refused", { transport: f.transportKind });
  log.warn({ from: f.remoteAddress, why: f.reason });
}
```

> [!IMPORTANT]
> The payload is **connection shape, never credential material** — `failureClass`, `transportKind`, and optionally `connectionId`, `remoteAddress`, `reason`. No token, no `Authorization` header, no header bag. The rule that credentials never cross the wire extends to the audit trail, which is precisely where a leaked bearer would be most durable.

## Telemetry

The gateway takes the same strictly-opt-in `telemetry` switch as an app, and plays two roles with it:

```ts
import { createTelemetry } from "@agentick/app";
import { otlpSink } from "@agentick/telemetry-otlp";

const gateway = await createGateway({
  telemetry: createTelemetry({ serviceName: "fleet" }, otlpSink()),
});
```

**Its own operations export.** Every gateway operation runs on a runtime built from the setting, so each span reaches your tracer: wire dispatch (`wire:<method>`), the authorize call, and the lifecycle operations. App-, session-, and tool-level spans do not run on the gateway runtime — they export through the app's own provider.

The wire-extension handler context carries the matching surface: `ctx.trace(...)` opens a child span parented under the `wire:<method>` operation, and `ctx.metrics.*` fans out to the gateway's meter with a low-cardinality `{ method }` label. Off the telemetry path both collapse to shared frozen no-ops.

**It cascades to every app beneath.** Every hosted app inherits the setting unless it supplies its own, in which case the app's wins — the same precedence as the substrate slots. One switch lights up the whole deployment:

```ts
// Inherits — app/session/tool spans export too.
const app = await gateway.createApp(<Agent />, { options });

// Overrides — this app's spans go to ITS provider.
const isolated = await gateway.createApp(<Agent />, {
  options: { ...options, telemetry: createTelemetry({}, myOwnSink()) },
});
```

The meter is shared and memoized. An OTel `MetricReader` binds to exactly one `MeterProvider`, so the gateway and every inheriting app resolve the **same** meter instance and no reader double-binds; two apps under one setting therefore both reach the sink, distinguishable by the `app` ambient label. A gateway hosting zero apps still exports its own wire metrics, and the last holder to close flushes and shuts the provider down.

The framework adds no proprietary layer between you and OpenTelemetry: `createTelemetry` merges your standard `SpanProcessor` and `MetricReader` sinks and hands the raw objects to the SDK. This package declares no exporter dependency; those live in [@agentick/telemetry-otlp](../telemetry-otlp).

### A client's trace, and whether you trust it

If your browser or mobile client also reports telemetry, it tags every request with the span it was made inside. The tag is a W3C `traceparent` value, carried in the request body as `_meta.traceparent` rather than as an HTTP header — so it works identically over a WebSocket or in-process, where there is no header to put it in.

What the gateway does with that tag is a setting, because the tag comes from a caller you may not control:

```ts
await createGateway({ telemetry, remoteParent: "parent" });
```

What you see in your tracing UI:

| Setting              | In your tracing UI                                                                                                                                        |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"link"` _(default)_ | Two traces — one for the client, one for the server — with a **link** between them. You can click from one to the other, but they are separate timelines. |
| `"parent"`           | **One** trace. The button click, the request, the model call and the tool call are all one tree you can read top to bottom.                               |
| `"ignore"`           | Two traces, unconnected.                                                                                                                                  |

`"parent"` is the nicer picture, so why is `"link"` the default?

Because the tag is just a string in a request body — anything that can reach your gateway can send whatever it likes. Part of that string is the **sampled bit**: a flag saying "record this one," which tracing systems use to keep only a fraction of traffic and hold costs down. Adopt a caller's tag as the parent and you adopt that flag too, so a client can switch your sampling off — or pin it on for every request and run up your telemetry bill. A caller can also aim its tag at a trace id it does not own, mixing its requests into someone else's timeline.

None of that matters when the caller is your own first-party app, which is why `"parent"` is a one-line opt-in. It matters a great deal when your gateway is on the public internet, which is why the default is the conservative one. (This is OpenTelemetry's own recommendation for public endpoints.)

Two details worth knowing:

- **Only the outermost server operation is affected.** A caller's tag can attach at `wire:<method>` and nowhere deeper — the operations beneath it always nest under the server's own span.
- **A malformed tag is ignored, not rejected.** A bad `traceparent` says something about the caller's telemetry setup, not about whether their request should run. It is dropped and the request proceeds normally.

## Bounding tool output sent to clients

A tool can return a multi-megabyte result. That payload **must** reach the model and **must** land in the durable timeline, but need not be shoved verbatim down a socket to a browser. The gateway is the client projection boundary, so it owns the policy — configured once, applied by the wire dispatch boundary to every client-facing frame, RPC results and notifications alike. There is no path that bounds one while leaking the other.

```ts
// OFF (default) — nothing sent to clients is truncated, and the wire
// boundary does zero projection work.
await createGateway();

// ON at the 32 KiB per-block default.
await createGateway({ truncateToolResults: true });

// ON, raised ceiling for a data-heavy deployment.
await createGateway({ truncateToolResults: { maxBytes: 256 * 1024 } });

// ON, domain override — keep the first rows of a CSV, delegate the rest.
await createGateway({
  truncateToolResults: {
    truncate: (block, ctx) => (block.type === "csv" ? headOnly(block) : ctx.bound(block)),
  },
});
```

**Opt-in, and that asymmetry is deliberate.** Security defaults protect the operator, so they ship on. How large a payload an app's transcript should carry is the app developer's call, so this ships off with a good default you opt into.

**Never the model path, never the store.** Truncation happens only on the copy heading to a client; the projector never mutates its input. A bounded block carries a machine-readable `block.metadata.bounded` marker (`{ truncated, originalBytes, retainedBytes, reason, hint }`) plus a human-readable suffix, both naming the durable store as where the full content survives — fetchable through the grant-gated `timeline/history` read.

## Security defaults

The gateway is the deployment root, so its serving posture is a security concern distinct from the authorization seams above. Two rules for any HTTP-facing deploy: **bind loopback by default**, and **never configure permissive CORS** — an exposed server plus a wildcard origin lets any page in a user's browser drive your gateway. The `Authorizer` and the scope ceiling gate who may call what; they are not a substitute for not being reachable.

These are enforced at the HTTP-facing transport bindings through a single shared policy in [@agentick/transport](../transport), and the unconfigured posture ships closed:

| Default                  | Behavior                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **Loopback bind**        | A port-owning transport binds `127.0.0.1`; a public interface is an explicit `host` opt-in.                |
| **Cross-site rejection** | Cross-site `Sec-Fetch-Site` and foreign `Origin` are rejected; a request carrying neither is admitted.     |
| **Non-permissive CORS**  | An allow-listed origin is echoed exactly. No code path emits `Access-Control-Allow-Origin: *`.             |
| **CSRF token**           | Issued on the bootstrap handshake, required on every mutation. The framework client handshakes it for you. |
| **Host allow-list**      | Loopback names plus configured hosts only. Forwarded headers are trusted only under `trustProxy`.          |

Each is overridable — `allowedOrigins`, `allowedHosts`, `trustProxy`, `csrf`, `host` — but ships safe.

## API

### `@agentick/gateway`

| Export                          | Purpose                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `createGateway(options?)`       | The factory. Resolves after the gateway is ready.         |
| `GatewayHarness`                | The implementation, for direct construction.              |
| `staticAuthorizer(options)`     | Server-side principal → scope-pattern table.              |
| `claimsAuthorizer()`            | Allow iff the credential's own claims cover the ask.      |
| `permissiveAuthorizer()`        | Allow everything. Explicit local opt-in.                  |
| `unconfiguredAuthorizer()`      | The deny-by-default default.                              |
| `createWireExtensionRegistry()` | The registry, for embedding the dispatch model elsewhere. |
| `createDynamicCommandResolver`  | The one generic `exposure: "wire"` fallthrough resolver.  |
| `createCommandsListHandler`     | The `commands/list` discovery handler.                    |

### `createGateway(options)`

| Option                  | Type                                  | Purpose                                              |
| ----------------------- | ------------------------------------- | ---------------------------------------------------- |
| `gatewayId`             | `string`                              | Stable id; defaults to a generated one.              |
| `journal` `bus` `inbox` | instance or factory                   | Substrate the hosted apps inherit.                   |
| `cluster`               | `ClusterFactory`                      | Wraps the substrate; every app inherits the wrap.    |
| `transports`            | `ServerTransport[]`                   | Owned by `listen()` / `close()`.                     |
| `authorizer`            | `Authorizer`                          | The authorization policy.                            |
| `tools`                 | `ToolDeclaration[]`                   | Baseline tools for every session of every app.       |
| `wireExtensions`        | `WireExtension[]`                     | Adopter JSON-RPC namespaces.                         |
| `extensions`            | gateway/app/session ext or bundle     | Installs and cascades by scope.                      |
| `truncateToolResults`   | `boolean \| { maxBytes?, truncate? }` | Bound client-facing tool output. Off by default.     |
| `telemetry`             | `TelemetrySetting`                    | Gateway spans, and the default for every hosted app. |

### `GatewayHarness`

| Member                           | Returns                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `id`                             | The gateway id.                                                  |
| `listen()`                       | Binds transports, flips ready. Idempotent.                       |
| `close({ drain? })`              | The sole terminal verb. Drains by default.                       |
| `createApp(element, input)`      | Mounts an app. Also takes one combined input object.             |
| `app(id)` / `apps()`             | Read-side enumeration.                                           |
| `appForSession(id)`              | Which mounted app owns a session — live registries, then stores. |
| `destroySession(id, opts?)`      | Destroy a session without naming its app.                        |
| `listSessions(query?, page?)`    | One page of every app's sessions; the mounted index, or a merge. |
| `events(filter?, options?)`      | `AsyncIterable<ProtocolEvent>` fanned in from every app.         |
| `authorize(input)`               | The hookable policy call.                                        |
| `accept(info)`                   | The hookable per-connection admission.                           |
| `wireExtensions()`               | The sealed registry.                                             |
| `emitCapabilitiesChanged()`      | Signal subscribers to refetch capabilities.                      |
| `emitAdmissionFailure(failure)`  | Record a refused ingress crossing on the bus.                    |
| `hook(config)` / `hooks.onX(fn)` | Register interceptors; both fold live to every app beneath.      |
| `guard(decide)`                  | Register a verdict-returning admission seam.                     |

### `@agentick/gateway/testing`

| Export                 | Purpose                                                         |
| ---------------------- | --------------------------------------------------------------- |
| `spyServerTransport()` | Call-recording `ServerTransport` double for fan-out assertions. |

## Patterns

**Clustered multi-app hosting.** Pass a `cluster` factory and the gateway's substrate is cluster-wrapped; every app spawned through `gateway.createApp` inherits the wrap through the ordinary default chain, so there is no per-app cluster wiring.

```ts
import { defineUnixCluster } from "@agentick/cluster-net";

const gateway = await createGateway({
  cluster: defineUnixCluster({ socketPath: "/tmp/cluster.sock" }),
});
await gateway.listen();
// close() closes apps first, then the cluster, then the substrate
```

This is the multi-app pattern to reach for. Apps that pass `cluster` independently through the top-level `createApp` each get their **own** cluster — extra connections and double delivery. The gateway-owned cluster is the cluster for every app it spawns.

> [!WARNING]
> `createGateway({ cluster, bus: instance })` is fine; `createGateway({ cluster, bus: someFactory })` throws. The cluster needs concrete instances to wrap, so resolve factories yourself if you need the combination.

**Transports.** [@agentick/transport](../transport) owns the shared dispatcher, the ingress authentication seam, and the web-security policy; the four concrete transports ship as their own packages.

**Clients.** [@agentick/client](../client) speaks to this gateway over any transport.

**Shapes.** [@agentick/spec](../spec) owns `Authorizer`, `WireExtension`, `defineWireExtension`, `IngressIdentity`, `ServerTransport`, and the error types.

**Apps.** [@agentick/app](../app) is what a gateway hosts, and its README covers the app-level halves of telemetry and tool layering.

## Roadmap & known gaps

- **No framework-supplied gateway extensions yet.** The install, bridge, cascade, and teardown machinery is complete and exercised, but every shipped extension today is either a wire extension or lives at app/session scope. An MCP control surface is the first intended gateway-scope consumer.
- **`bridges()` on the wire-extension context is empty.** No framework-supplied extension needs bridges yet, so nothing resolves them from a target session.
- **The wire registry seals at construction**, so `gateway:capabilities:changed` cannot fire during normal operation — the emit seam and its end-to-end delivery are proven, but dynamic extension registration is not built. Relatedly, a client does not yet re-sync its own `capabilities` when the event arrives.
- **`_extensions/list` is unauthenticated.** Discovery is intended to be open, since clients need it to know what they can reach. Gated discovery would need an auth entry on the method.
- **No verb answers "which namespaces does THIS session mount".** `_extensions/list` is server-wide and `<ns>/commands` presumes you already know the namespace to ask, so a client discovers an optional harness by calling into it and reading a `MethodNotFound` — inference from silence, not an enumeration.
- **`commands/list` walks a fixed surface list.** It enumerates the session-scoped surfaces the framework ships, so a namespace outside that list — `mcp`, or a harness you wrote — is absent from the cross-surface answer even though its own `<ns>/commands` door works.
- **`state` and `tasks` project wire verbs but no typed `commands` row.** Both answer the meta-verb at runtime, and `commands/list` includes them; what is missing is the `WireMethods` declaration, so `session.state.commands()` does not typecheck the way `session.prompts.commands()` does.
- **Nothing on the client consumes the per-namespace door yet.** Every shipped client handle polls its own reads instead of asking what the session can do, so `<ns>/commands` exists today for adopters and dynamic clients rather than for the framework's own UI.
- **`createApp` is on the concrete class, not the protocol interface.** Typing its input in the shapes package would drag app types into the protocol, so protocol consumers can enumerate apps but not construct them.
- **The dynamic lane costs two inbox asks per invocation** — one to enumerate the surface's commands, one to dispatch. Declarations are construction-stable, so a per-address cache with close-invalidation is the obvious follow-up.
- **`telemetryNamespace` does not cascade.** Each app whitelabels its own attribute prefix; set it per app if you need a non-default one.
- **No cluster substrate of its own.** `GatewayHarness` accepts any `EventBus`, so a Redis- or Kafka-backed deployment is a substrate swap rather than a gateway rewrite — but this package ships no such bus.
- **`fanIn` cannot tell two apps' identically-named sessions apart.** The lineage walk keys on a session id, which is unique within an app but not across apps on one gateway. The arrival filter checks `scope.appId` for exactly this, but no `appId` reaches a `tool:signal:progress` envelope today — the app stamps `{ sessionId }` on the per-session scope and nothing gap-fills the rest. Reaching the hole needs two apps, deliberate reuse of one explicit session id (spawn generates ULIDs), and concurrent `fanIn` turns; closing it belongs at the emitter, since every scope-filtered bus subscriber has the same blind spot.
- **There is no per-principal subscription scope.** The ladder tops out at `{ kind: "gateway" }`, which is the whole deployment — an operator's view, not a tenant's. The missing rung is a scope carved by principal rather than by spawn lineage; it would have `session-tree`'s shape (widen, then filter on arrival) with the identity axis, but the envelope scope carries no principal today, so the filter has nothing to read. `TODO(gateway-scope-subscription)` marks the spot.

## Verified by

- `src/__tests__/harness.spec.ts` — construction and default substrate, the `listen`/`close`/`create-app`/`accept` operations and their hooks, `createApp` before `listen()` throwing `GatewayNotStartedError` (and the pre-gate firing before the operation), duplicate `appId` rejection, the `gateway:app:created` emit, close cascading into apps, and rejection after close.
- `src/__tests__/server-transports.spec.ts` — `listen()` fanning out with the gateway as host, `close()` closing every owned transport, idempotent `listen()` not re-firing, the zero-transport no-op, and best-effort teardown when a transport's `close()` rejects.
- `src/__tests__/wire-registry.spec.ts` + `wire-framework-extensions.spec.ts` — register, resolve, enumerate in insertion order, duplicate namespace and name rejection, sealing, and adopter attempts on all four framework namespaces failing.
- `src/__tests__/dynamic-commands.spec.ts` — the bundled authorizers including glob cover and the same-principal rule, exact-beats-dynamic resolution, single pre-seal registration, a non-`wire` verb being indistinguishable from an absent method, an exposed-and-granted verb dispatching with `origin: "wire"`, and `commands/list` showing a denied caller nothing.
- `src/__tests__/gateway-extensions.spec.ts` — install during construction, the live installer host, async install awaited before ready, bridge-slot singleton enforcement, install failure rejecting `createGateway` without half-sealing the registry, bundle field distribution, bare app/session extensions cascading to every app and session, and LIFO `onClose` after apps close.
- `@agentick/transport`'s `src/__tests__/list-sessions-wire.spec.ts` — `gateway/list_sessions` against a real gateway in BOTH modes: a mounted index answering with its own rows, its own ordering (deliberately not the canonical one, so a re-sort would fail the test) and its own cursor handed back verbatim, one query per page, and the caller's principal reaching it; and the fallback merge over two apps' stores in the framework's canonical order with the right `appId` on every row. Plus one cursor paging the union across the app boundary, the caller-scoping filter that is the verb's only defense (it names no session, so the dispatch gate has nothing to resolve), the tree filter reaching the stores rather than post-filtering a fetched page, and an empty gateway's page shape. (Home is transport because this package does not depend on it.)
- `@agentick/transport`'s `src/__tests__/destroy-session-wire.spec.ts` — both destroy verbs against a real gateway and the real dispatch gate: `gateway/destroy_session` resolving the owner on a multi-app gateway, resolving a paged-out session through the session stores, denying another principal's thread on the record when no live target exists for the gate to read, and answering an unclaimed id with no `appId` instead of a fault. (Home is transport because this package does not depend on it.)
- `@agentick/transport-in-process`'s `src/__tests__/progress-fan-in-e2e.spec.ts` — `fanIn` over the full stack (real client, gateway, app, session, loop, tool executor, and real `spawn`): the default leaving a child's frames off the parent's stream while the fixture proves the child emitted; `fanIn` delivering them with the emitter's session, a distinct execution id, and the tool call id as correlation token; a grandchild arriving through the lineage walk; two concurrent turns in two apps sharing one gateway-wide subscription and each seeing only its own; a sibling turn's still-live child emitting DURING the next turn and staying off it; and no frame arriving after the send settles. (Home is transport-in-process because this package does not depend on it.)
- `@agentick/transport-in-process`'s `src/__tests__/session-tree-subscription-e2e.spec.ts` — the `session-tree` scope over a real gateway, app, sessions and `spawn`: a child's and a grandchild's channel frames arriving attributed to the emitter, a plain session subscription still seeing only itself, each live member's snapshot spliced at subscribe with the root's first, a session spawned AFTER subscribe joining live with no retro-splice, a foreign session excluded on both axes (another root in the same app, and another app on the same gateway) while publishing FIRST so its absence is the filter and not a race, and `close()` ending delivery. (Home is transport-in-process because this package does not depend on it.)
- `@agentick/app`'s `src/__tests__/cascading-abort.spec.tsx` — `executionTreeContains` on the same tree the fan-out test builds: child and grandchild in, a sibling turn's child out, the origin session itself out, and both unknowns quiet. Plus `sessionTreeContains` / `sessionTree` on that tree: both turns' children in (lineage, not turn), the root a member of its own tree where the origin session is not a member of its turn's, and the enumeration root-first then breadth-first.
- `src/__tests__/gateway-app-live-link.spec.ts` — a gateway hook registered **after** a session exists reaching that session's tool executor, and unsubscribe cascading back out.
- `src/__tests__/layered-tools.spec.ts` — gateway tools reaching every session of every hosted app, and app- and session-level tools overriding on name collision.
- `src/__tests__/emit-capabilities-changed.spec.ts` — event shape, per-call ordering, zero-subscriber safety, and scope-query plus child-bus isolation.
- `src/__tests__/telemetry-inheritance.spec.ts`, `telemetry-multi-app.spec.ts`, `telemetry-wire-ctx.spec.ts` — gateway-operation span export, app inheritance and app override precedence, two apps sharing one `MeterProvider` with metrics distinguished by the `app` label, and a handler's `ctx.trace` parenting under `wire:<method>` with `ctx.metrics` carrying `{ method }`. All against real OTel `SpanProcessor` and `MetricReader`s.
- `src/__tests__/remote-trace.spec.ts` + `remote-parent-wire.spec.ts` — the three policies mapped from a caller's `_meta.traceparent`, every unusable header (malformed, reserved version `ff`, all-zero ids) ignored rather than refused, and normalisation through the parser. Then the same three end to end through a real gateway against a real OTel `SpanProcessor`, discriminated by `traceId`: `link` leaving the `wire:<method>` span in its OWN trace with the caller's as a link, `parent` putting it IN the caller's trace, and `ignore` doing neither.
- `src/__tests__/create-gateway-cluster.spec.ts` — the substrate genuinely cluster-wrapped (membership shows the gateway, close removes it), and the factory-plus-cluster combination rejected.
- `src/wire/__tests__/session-timeline-history.spec.ts` + `subscriptions-channel-snapshot.spec.ts` — the cursored history read paging forward and the tail page carrying no cursor, and a channel subscription opening with a snapshot as its first frame under the client's own subscription id.
- `src/__tests__/timeline-history-grant.spec.ts` — the granted-read recipe above: the declared read resolving and dispatching with `origin: "wire"`, an unexposed timeline write staying `MethodNotFound` even for a `*` holder, `commands/list` advertising the read, the exact-verb grant working while a sibling-verb grant does not leak it, the read grant conferring no writes, and a `*` grant still losing to the same-principal target rule. The full client-to-store path (25-entry log, two pages, `Forbidden` without a grant, cross-principal denial) is [@agentick/transport-in-process](../transport-in-process)'s `timeline-history-e2e.spec.ts`.
- Authentication and authorization end-to-end live in [@agentick/transport](../transport): `wire-declarative-auth.spec.ts` (verb-scope default, open methods, additive roles, the un-waivable ceiling), `session-principal.spec.ts` (the owning principal stamped from the edge, a body-smuggled value ignored), `wire-identity-hook.spec.ts` (`ctx.identity` overriding a smuggled principal, absent when unauthenticated, invisible to inner operations), `authorize-seam.spec.ts` (a contextual scope flipping deny to allow, the ceiling denying regardless and the hook never firing), `wire-command-e2e.spec.ts` (journaled operation, typed hook transform, guard verdicts at the JSON-RPC edge, middleware and span attributes), and `client-projection.spec.ts` (bounding at the wire funnel across results and notifications). `runIngressAuthnConformance`, which every server transport runs against a real server, pins the admission-failure event and that its payload carries no credential.
