# ADR 46 — Wire extensions: extensible JSON-RPC namespaces on the Agentick client↔gateway wire

**Status:** Proposed — 2026-06-30.

**Touches:** `@agentick/spec/wire/extension.ts` (new — the
`WireExtension` interface + registry contract), `@agentick/spec/wire/params.ts`
(typed-method augmentation pattern already exists — this ADR
documents the runtime story), `@agentick/gateway` (registers
extensions at construction, dispatches RPCs to handlers, threads auth

- enumeration), `@agentick/client` (capability discovery at
  connect, typed `request` / `subscribe` already exist — this ADR
  defines how packages ship the typed helpers on top), every package
  that contributes methods to the wire (`@agentick/mcp`,
  `@agentick/credentials`, future adopter packages). Cross-references
  ADR 33 (Client + transports), ADR 32 (extension shape spectrum), ADR
  27 (modular built-ins), ADR 45 (runtime context model). Depends on
  the broader Gateway-extensions framework (#254) — the wire-extension
  install seam plugs into whatever shape gateway extensions ultimately
  take.

**Driver:** During #277b we shipped MCP credentials integration end-to-end
on the gateway side — connection-status FSM, credential
read-through, reauthenticate verb. To make this usable from the
browser UI (#277d, #279), the Agentick client SDK needs to call
`mcpClients/reauthenticate(serverId)` and subscribe to status
changes. Today's gateway has HARDCODED dispatch for the listed
methods in `WireMethods` (spec-next/wire/params.ts); adopter
declaration-merging into `WireMethods` types correctly but the
gateway has no runtime registry to dispatch to. Adding the methods
to the framework requires patching three files in two packages every
time. This ADR makes wire-method registration extensible the same
way harnesses, tools, and bridges are.

---

## Terminology — the two client↔server pairs

Before the design, a precision call-out that this ADR depends on:

- **MCP client ↔ MCP server.** `McpClientHarness` on the gateway
  (server-internal) talks Model Context Protocol to EXTERNAL MCP
  servers (Linear, GitHub, stdio binaries). End user never sees this
  layer directly. NOT what this ADR is about.

- **Agentick client ↔ Agentick gateway.** `@agentick/client` in
  the browser / TUI / native app talks Agentick's own JSON-RPC over
  the configured transport (WebSocket, HTTP, Unix socket). This is
  the end-user-facing layer. **This ADR extends THIS protocol.**

A wire extension may project MCP-client-HARNESS state onto the
Agentick wire so a browser UI can drive the gateway's MCP
connections. The projection lives at the Agentick-wire layer; the
MCP protocol stays gateway-internal. The two protocols never mix.

Throughout this ADR: "wire" means the Agentick client↔gateway wire.
"MCP" methods refer to BROWSER-CONTROL of MCP-client-harness state,
not to the MCP protocol.

---

## TL;DR

1. **`WireExtension` is the new primitive.** A bag of method handlers
   - notification name declarations + auth metadata + cluster
     routing hints, named under a namespace. Each extension contributes
     to the gateway's JSON-RPC dispatch registry.

2. **Two install paths to one registry.**
   - **Package self-install (the common case).** A package like
     `@agentick/mcp` ships its own `WireExtension` and installs
     it from inside `withMCP(...)`'s gateway-extension chain. Adopter
     never sees the wire extension — it Just Works when they install
     the package.
   - **Adopter ad-hoc (the escape hatch).** `createGateway({
wireExtensions: [adopterCustom1, adopterCustom2] })` accepts
     hand-authored extensions for custom RPC namespaces the framework
     doesn't ship. Same registry, same dispatch path.

3. **Adopter hooks on package config.** Packages that ship wire
   extensions expose adopter-configurable hooks on their `withX`
   factory options (e.g., `withMCP({ hooks: { beforeReauthenticate,
afterReauthenticate, filterClients } })`). The package's handlers
   call the hooks at the right lifecycle points. Adopter never
   authors raw wire handlers for built-in functionality — they
   author business logic at specific seams.

4. **Composite extension factories.** A package factory like `withMCP`
   returns an object with optional scoped pieces:

   ```ts
   { session?: SessionExtension; app?: AppExtension;
     gateway?: GatewayExtension; wire?: WireExtension }
   ```

   The framework introspects the composite at install time and
   dispatches each piece to its appropriate scope. One factory, one
   adopter import, multi-scope contributions.

5. **Type-level augmentation already exists.** `WireMethods` and
   `WireNotifications` in spec-next are declaration-merge-extensible
   today (see existing JSDoc). This ADR doesn't change the type
   story — it adds the runtime registry that makes the typed
   declarations dispatchable.

6. **Discovery via `_extensions/list`.** Built-in gateway method
   returns every registered extension's `{ namespace, methods,
notifications, version }`. Client SDK calls this at connect time,
   exposes the result as `client.capabilities`. UI gates feature
   availability ("this gateway doesn't have mcpClients/\* — don't
   render MCP UI").

7. **Three locations per wire-aware package:** (a) type augmentation
   shared between client + server builds, (b) server-side
   `WireExtension` value with handler bodies, (c) client-side helper
   library (React hooks / typed proxies) consumed by browser code.
   Same source package, three files.

---

## Use cases driving the design

### Use case 1: MCP client control from browser UI (#277d, #279)

End user clicks "Connect Linear" in the browser. Browser needs to:

- See the list of configured MCP servers + their connection status.
- Trigger `reauthenticate()` on a specific server.
- See status changes in real time.

Today's MCP work shipped `McpClientHarness` on the gateway with all
the verbs. To expose them to the browser:

```ts
// Browser (Agentick client):
const { status, clients, reauthenticate } = useMcpClients();
clients.map(c => (
  <Card>
    <h3>{c.serverId}</h3>
    <span>{c.status.kind}</span>
    {c.status.kind === "credentials-missing" && (
      <button onClick={() => reauthenticate(c.serverId)}>Connect</button>
    )}
  </Card>
));
```

The hook needs:

- `mcpClients/list` — returns `{ serverId, status }[]` from the gateway.
- `mcpClients/reauthenticate(serverId)` — calls into McpClientHarness
  on the gateway.
- `mcpClients/status-changed` — notification on every status
  transition.

These methods live in the **Agentick wire** (browser↔gateway), NOT in
MCP itself.

### Use case 2: Credentials store administration

Adopter admin UI lists configured OAuth providers, rotates tokens,
clears credentials. Needs `credentials/list-namespaces`,
`credentials/clear(namespace, key)` — but **never** transmits token
material across the wire. The handler reads/writes the credentials
store server-side; the wire surface exposes the management verbs
only.

### Use case 3: Adopter custom RPC

A SaaS adopter ships `crm/list-leads`, `crm/update-deal` — backed by
their internal SQL adapter. No agentick package owns this; the
adopter writes a `WireExtension` directly and passes it to
`createGateway({ wireExtensions: [crmWireExtension] })`.

---

## The `WireExtension` primitive

```ts
/**
 * A bag of wire methods + notifications + auth metadata under a
 * namespace. Registered with the gateway at construction; dispatched
 * when matching RPCs arrive over the Agentick wire.
 *
 * @see docs/proposals/v2/blueprint/46-wire-extensions.md
 */
export interface WireExtension {
  /** Package identifier — `"@agentick/mcp"`, adopter-supplied for ad-hoc. */
  readonly name: string;

  /**
   * Namespace prefix — `"mcpClients"`, `"credentials"`, `"crm"`. All
   * methods + notifications declared here MUST start with `namespace/`.
   * Used for enumeration grouping + conflict detection.
   */
  readonly namespace: string;

  /**
   * Optional version string for the extension's wire surface. Surfaced
   * via `_extensions/list`; clients can pin or gate behavior on it.
   */
  readonly version?: string;

  /**
   * Method handlers keyed by full method name. Each handler receives
   * the typed params + a context object (see {@link WireExtensionContext})
   * and returns the typed result.
   *
   * The method name MUST appear in `WireMethods` declaration-merged
   * by this package or some package it depends on — otherwise the
   * caller has no way to type-check the request.
   */
  readonly methods: {
    readonly [K in WireMethod]?: (
      params: WireParams<K>,
      ctx: WireExtensionContext,
    ) => Promise<WireResult<K>> | WireResult<K>;
  };

  /**
   * Notification names this extension may publish. The gateway uses
   * this to validate publishes (prevents typos / cross-namespace
   * pollution) and for `_extensions/list` enumeration.
   */
  readonly notifications?: readonly WireNotificationMethod[];

  /**
   * Per-method auth metadata. Plugs into the gateway's auth middleware.
   * Method without an entry inherits the gateway's default auth policy.
   */
  readonly auth?: {
    readonly [K in WireMethod]?: WireMethodAuth;
  };

  /**
   * Per-method cluster routing hint. Determines whether the request
   * is handled locally on the receiving node or routed to a specific
   * node owning the relevant scope (typically the session's owning
   * node).
   *
   * Defaults to `"session-local"` for session-scoped methods,
   * `"any"` for gateway-scoped methods.
   */
  readonly clusterRoute?: {
    readonly [K in WireMethod]?: "session-local" | "any" | "leader";
  };
}

/**
 * Auth declaration per method. Inherits gateway defaults if absent.
 */
export interface WireMethodAuth {
  /** `true` if any authenticated session can call; `false` for open methods (rare). */
  readonly required: boolean;
  /** Optional scope label — used for role-gated dispatch (e.g., `"admin"`). */
  readonly scope?: string;
}

/**
 * Context provided to wire-extension handlers. Resolves the active
 * session / app / gateway via id-based lookup, exposes bridges, and
 * carries `runtimeContext` for handlers that need it.
 */
export interface WireExtensionContext {
  /** The request's resolved session, if any (session-scoped methods). */
  readonly session?: SessionHandle;
  /** The request's resolved app, if any. */
  readonly app?: AppHandle;
  /** The gateway handle. */
  readonly gateway: GatewayHandle;
  /** Active bridges on the resolved session. Empty for gateway-scoped methods. */
  readonly bridges: () => HookBridges;
  /** Runtime context snapshot — sessionId / userId / correlationId. */
  readonly runtimeContext: RuntimeContext;
  /** Publish a notification declared in `extension.notifications`. */
  readonly publish: <K extends WireNotificationMethod>(
    name: K,
    params: WireNotificationParams<K>,
  ) => void;
}
```

### Method dispatch flow

```
Client                          Gateway
  │  request("mcpClients/reauthenticate", {serverId})
  │ ──────────────────────────►│
  │                            │
  │                            ├─ wireDispatcher.lookup("mcpClients/reauthenticate")
  │                            ├─ auth middleware (per-method policy)
  │                            ├─ cluster routing (session-local → resolve owning node)
  │                            ├─ context construction (session + bridges + runtimeCtx)
  │                            ├─ handler(params, ctx) — calls bridges.mcp.client(...).reauthenticate()
  │                            ├─ adopter hook execution at lifecycle points
  │                            └─ result → encode → respond
  │ ◄──────────────────────────│
```

### Conflict resolution at registration

Two extensions declaring the same method or notification name throw
at gateway construction. No first-wins, no last-wins — explicit
error pointing at both contributors:

```
GatewayWireConflictError: method "mcpClients/reauthenticate"
declared by both "@agentick/mcp" and "adopter-crm-extension".
Methods must be uniquely owned by exactly one extension. Rename one,
or have one extension extend the other's namespace.
```

The framework's own packages never conflict (they own distinct
namespaces). Adopter extensions can't accidentally clobber framework
methods (the namespace prefix scheme prevents collision unless the
adopter deliberately reuses a framework namespace, which the framework
catches).

---

## Composite extension factory shape

Packages that ship multi-scope extensions return a composite:

```ts
export type AgentickExtension = {
  /** Per-session install (existing — runs at session construction). */
  readonly session?: SessionExtension;
  /** Per-app install (existing — runs at app construction). */
  readonly app?: AppExtension;
  /** Per-gateway install (existing per #254). */
  readonly gateway?: GatewayExtension;
  /** Wire extension contribution (new — registers at gateway construction). */
  readonly wire?: WireExtension;
};
```

`withMCP(...)` returns this composite. `createApp(<Agent/>, {
extensions: [withMCP(...), withCredentials(...)] })` and `createGateway(...)`
receive the composite list. The framework destructures each entry,
dispatches the named pieces to their scopes:

```ts
function ingestExtensions(exts: readonly AgentickExtension[]): {
  sessionExts: SessionExtension[];
  appExts: AppExtension[];
  gatewayExts: GatewayExtension[];
  wireExts: WireExtension[];
} {
  // Split each composite into its scoped pieces. Order preserved
  // within each scope so install order is deterministic.
}
```

### Why composite over inline-on-existing

Considered: `SessionExtension.wire?: WireExtension` — let session
extensions inline their wire piece. Rejected because:

- Wire extensions are GATEWAY-scoped (one registry per gateway), not
  session-scoped. Coupling them to SessionExtension implies
  per-session wire registries, which they aren't.
- A package may have NO session piece but a gateway-level wire
  extension (e.g., credentials admin). Forcing a SessionExtension
  carrier is awkward.
- The composite scales to other scopes naturally (app, gateway, wire,
  future) without further inline knobs on each existing type.

The composite shape is also a clearer mental model for adopters:
"this `withX` factory contributes to N scopes; the framework
dispatches each contribution to the right place." Same shape
regardless of which scopes a particular extension uses.

---

## Adopter hooks on package config

Built-in packages expose hooks adopters configure to customize wire
behavior without authoring raw handlers. Pattern:

```ts
withMCP({
  servers: [...],
  hooks: {
    // Pre-handler hooks — observe + optionally reject.
    beforeReauthenticate: async (serverId, ctx) => {
      if (!ctx.runtimeContext.user?.roles.includes("admin")) {
        throw new UnauthorizedError({ reason: "admin only" });
      }
      await auditLog.write({ kind: "mcp.reauth", serverId, user: ctx.runtimeContext.user });
    },
    // Post-handler hooks — react to outcomes.
    afterReauthenticate: async (serverId, status, ctx) => {
      if (status.kind === "error") {
        await slack.post(`reauth failed: ${serverId}`);
      }
    },
    // Transformation hooks — modify what's returned.
    filterClients: (clients, ctx) =>
      clients.filter(c => userCanSeeServer(ctx.runtimeContext.user, c.serverId)),
  },
});
```

The package's wire handler internally invokes the configured hooks at
specific points:

```ts
// Inside @agentick/mcp/wire/server.ts:
const mcpControlWireExtension: WireExtension = {
  // ...
  methods: {
    "mcpClients/reauthenticate": async (params, ctx) => {
      const hooks = ctx.bridges().mcp?.hooks ?? {};
      await hooks.beforeReauthenticate?.(params.serverId, ctx);
      const client = ctx.bridges().mcp?.client(params.serverId);
      if (!client) throw new McpClientNotFoundError(...);
      await client.reauthenticate();
      const status = client.status;
      await hooks.afterReauthenticate?.(params.serverId, status, ctx);
      return { status };
    },
    "mcpClients/list": async (params, ctx) => {
      const hooks = ctx.bridges().mcp?.hooks ?? {};
      const all = (ctx.bridges().mcp?.clients ?? []).map(c => ({
        serverId: c.serverId,
        status: c.status,
      }));
      const filtered = hooks.filterClients ? hooks.filterClients(all, ctx) : all;
      return { clients: filtered };
    },
  },
};
```

The hooks are PART OF THE PACKAGE'S PUBLIC API. They're typed,
documented, and stable. The adopter never touches wire-handler
internals — they author business logic at the documented seams.

### Hook design discipline

For each wire method, the package decides:

- `beforeX(params, ctx)` — pre-handler, may throw to reject.
- `afterX(params, result, ctx)` — post-handler, observation only
  (return value ignored; throwing rolls up but doesn't undo).
- `filterX(items, ctx)` — transformation, must return a value of the
  same shape.

Hook authoring follows the existing lifecycle-handler convention from
`BaseHarness` (`onBeforeOp` / `onAfterOp` / `onVerdict`). Same mental
model.

### Why hooks instead of full middleware

Considered: full middleware (`(params, ctx, next) => result`). Lets
adopters wrap the entire call. Rejected for built-in package
extensions because:

- Adopters writing middleware on built-in methods is too much rope —
  they could break the handler's contract.
- Most use cases are pre-check or post-react — hooks cover those.
- Adopters writing full middleware = they should ship their own
  WireExtension. The adopter ad-hoc path is the right escape hatch
  for that level of customization.

Built-in packages = hooks. Adopter-authored extensions = full
control over the handler bodies.

---

## Self-installation pattern — how packages register

Within a package's `withX` factory composite return, the `wire` field
carries the `WireExtension`. The framework picks it up at
gateway-construction time. From the adopter perspective:

```ts
// Adopter writes:
const app = createApp(<Agent/>, {
  extensions: [
    withMCP({ servers: [...], hooks: { ... } }),
    withCredentials({ store }),
  ],
});
const gateway = await createGateway({ apps: [app] });

// Adopter never sees `wireExtensions: [...]` for built-in stuff.
```

The framework, on gateway construction:

1. Walks `apps[].extensions[]` collecting composite contributions.
2. Extracts `wire` pieces into a flat list.
3. Plus any adopter-supplied `createGateway({ wireExtensions: [...] })`.
4. Validates: no namespace conflicts, all method names match
   `WireMethods` declaration, all notifications match
   `WireNotifications`.
5. Registers handlers with the gateway's wire dispatcher.

### Ad-hoc extension path stays available

Adopters writing one-off RPC methods don't need to ship a package:

```ts
import { defineWireExtension } from "@agentick/spec/wire";

declare module "@agentick/spec" {
  interface WireMethods {
    "crm/listLeads": { params: { account: string }; result: { leads: Lead[] } };
  }
}

const crmWireExtension = defineWireExtension({
  name: "adopter:crm",
  namespace: "crm",
  methods: {
    "crm/listLeads": async (params, ctx) => {
      const leads = await db.query.leads({ account: params.account });
      return { leads };
    },
  },
});

const gateway = await createGateway({
  apps: [...],
  wireExtensions: [crmWireExtension],
});
```

Same registry, same dispatch path. No middleware needed because
adopter owns the handler.

---

## Client-side architecture — three locations per package

```
@agentick/mcp/
  src/
    augment.ts              ← type-level: declare module "@agentick/spec"
                              augments WireMethods + WireNotifications.
                              Imported by BOTH client + server builds.

    wire/
      methods.ts            ← shared method param + result types
                              (referenced by augment.ts)

      server.ts             ← WireExtension value with handler bodies.
                              Imported by Node bundles only.
                              Installed by withMCP at gateway scope.

      client.ts             ← React hooks, typed proxies, callback wrappers.
                              Imported by browser bundles.
                              Uses @agentick/client's typed
                              `client.request` / `client.subscribe`
                              under the hood.

    extension.ts            ← withMCP(...) — composite factory.
                              Bundles harness + wire + session pieces.

  package.json
    "exports":
      "."           → src/index.ts          (main — re-exports for Node)
      "./client"    → src/wire/client.ts    (browser-safe — UI helpers)
      "./server"    → src/server/index.ts   (existing — MCP server subpath)
```

Three subpath exports keep the bundler split honest:

- `import { withMCP } from "@agentick/mcp"` — Node, server-side.
- `import { useMcpClients } from "@agentick/mcp/client"` —
  browser-safe React hooks.
- `import { McpServerHarness } from "@agentick/mcp/server"` —
  existing MCP server inbound infrastructure.

### Type augmentation reaches both halves

```ts
// In @agentick/mcp/src/augment.ts:
declare module "@agentick/spec" {
  interface WireMethods {
    "mcpClients/list": {
      params: McpClientsListParams;
      result: McpClientsListResult;
    };
    "mcpClients/reauthenticate": {
      params: { serverId: string };
      result: { status: McpConnectionStatus };
    };
  }
  interface WireNotifications {
    "mcpClients/status-changed": {
      serverId: string;
      status: McpConnectionStatus;
    };
  }
}
```

This file is imported by `mcp-next`'s main barrel. Browser code
importing from `@agentick/mcp/client` transitively triggers the
augmentation. Server code importing `@agentick/mcp` triggers the
same augmentation. Both sides of the wire see the same typed shapes.

### Client-side helper shape

```ts
// In @agentick/mcp/src/wire/client.ts:

export function useMcpClients(): {
  readonly clients: ReadonlyArray<{ serverId: string; status: McpConnectionStatus }>;
  readonly loading: boolean;
  readonly reauthenticate: (serverId: string) => Promise<void>;
} {
  const client = useAgentickClient();
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Initial enumerate.
    client.request("mcpClients/list", {}).then(({ clients }) => {
      setClients(clients);
      setLoading(false);
    });
    // Live updates.
    const unsub = client.subscribe("mcpClients/status-changed", {}, (ev) => {
      setClients((prev) =>
        prev.map((c) => (c.serverId === ev.serverId ? { ...c, status: ev.status } : c)),
      );
    });
    return unsub;
  }, [client]);

  const reauthenticate = useCallback(
    async (serverId: string) => {
      await client.request("mcpClients/reauthenticate", { serverId });
    },
    [client],
  );

  return { clients, loading, reauthenticate };
}
```

The hook is the BROWSER-FACING API. It's typed via the module
augmentation, calls into `client.request` / `client.subscribe` (the
generic typed primitives from `@agentick/client`).

---

## The framework's own wire methods ARE wire extensions

**Eat-your-own-dogfood commitment.** The methods currently hardcoded
in `WireMethods` — `gateway/list_apps`, `gateway/get_app`,
`app/create_session`, `app/get_session`, `app/list_sessions`,
`app/run_once`, `app/close`, `session/send`, `session/dispatch`,
`session/abort`, `session/snapshot`, `session/rebind`,
`session/close`, `session/respond_to_elicitation`, `subscribe`,
`unsubscribe`, `auth/refresh`, `auth/completeChallenge`,
`auth/signOut`, `ping` — get reorganized into framework-supplied
`WireExtension` values during Phase B/C:

- `gatewayWireExtension` — namespace `gateway/*`.
- `appWireExtension` — namespace `app/*`.
- `sessionWireExtension` — namespace `session/*`.
- `subscriptionWireExtension` — `subscribe` + `unsubscribe`. (Special
  case: these are bare names, not namespaced. Either the validator
  carves an exception, or they get renamed to `subscriptions/*` —
  decision in Phase B/C.)
- `authWireExtension` — namespace `auth/*`.
- `pingWireExtension` — bare `ping`. (Same exception or rename
  question as subscribe/unsubscribe.)
- `frameworkInternalWireExtension` — `_extensions/list` (the
  capability discovery method, the only `_*` extension permitted).

These extensions are loaded INTO THE GATEWAY by default at
construction. Adopters writing `createGateway({ apps: [...] })` get
them automatically; they don't have to import or pass anything.
Adopters can in theory replace them by passing a `defaultWireExtensions:
false` option (Phase B/C exposes the seam for testing / non-standard
deployments), but the canonical case is "all framework methods
register via the same primitive adopter extensions use."

### What this gets us

1. **No hardcoded dispatch path.** The gateway has one dispatcher.
   Look up method name in the registered extensions; call handler;
   return result. No `if (method === "session/send") { ... }`
   special-case at the top of the dispatcher. Smaller surface, fewer
   places for bugs.

2. **First-class conformance.** The framework's own extensions go
   through `runWireExtensionConformance` (#299) just like adopter
   ones do. If the framework violates its own discipline, the
   conformance suite catches it.

3. **Documentation alignment.** When an adopter wants to learn how
   wire extensions work, they read `gatewayWireExtension` as the
   canonical example. It's not a teaching toy — it's the real
   implementation of the framework's core RPC surface.

4. **Test-doubles consistency.** The framework's testing helpers
   (`stubGateway`, `fakeSession`) can mock at the extension boundary
   by registering test versions of these extensions. Same hook
   adopters use for testing their own extensions.

5. **Discovery is uniform.** `_extensions/list` returns the
   framework's own extensions alongside adopter ones. Client SDK
   doesn't need a separate "is this a framework method or adopter
   method" branch.

### Special cases (subscribe / unsubscribe / ping)

Bare method names (no `namespace/` prefix) don't fit the validator
rule that every method starts with the declared namespace. Two
options for Phase B/C:

- **Carve an exception** — framework-supplied extensions may declare
  bare methods provided their namespace is the framework's reserved
  prefix (`_subscribe`, `_ping`). The validator allows underscore-
  prefixed namespaces ONLY for framework-supplied extensions.
- **Rename** — `subscribe` → `subscriptions/create`, `unsubscribe` →
  `subscriptions/cancel`, `ping` → `framework/ping`. Breaking change
  to existing clients (acceptable per the no-backcompat rule before
  v2.0).

Lean toward **rename** for cleanliness. The discriminator at the
adopter level becomes "every method has a namespace/" — no
exceptions, no special cases. Phase B/C decides definitively.

### Phase B/C scope amendment

The wire-dispatcher implementation needs to:

1. Define the framework's built-in `WireExtension` values
   (`gatewayWireExtension`, `appWireExtension`, etc.) that wrap the
   existing hardcoded handlers.
2. Load them into the gateway's wire registry at construction.
3. Drop the hardcoded dispatch path in favor of uniform
   extension-driven dispatch.

This is a meaningful refactor — every existing wire method's handler
moves from gateway internals into a framework-supplied extension
file. The behavior stays identical; the dispatch path collapses.

---

## Capability discovery — `_extensions/list`

Gateway registers a built-in method `_extensions/list` (the
underscore prefix marks it framework-internal):

```ts
// Built into the gateway, not an extension itself:
"_extensions/list": (_params, ctx) => ({
  extensions: ctx.gateway.wireExtensions.map(ext => ({
    name: ext.name,
    namespace: ext.namespace,
    version: ext.version,
    methods: Object.keys(ext.methods),
    notifications: ext.notifications ?? [],
  })),
});
```

The Agentick client SDK calls this immediately after `initialize` and
exposes the result as `client.capabilities`:

```ts
const client = await createClient({ transport: ... });
await client.connect();
// At this point client.capabilities is populated:

client.capabilities.has("mcpClients/reauthenticate");
// → true if @agentick/mcp is installed gateway-side

const mcpCaps = client.capabilities.namespace("mcpClients");
// → { name, version, methods, notifications } | undefined
```

### Why discovery is non-optional

Without discovery, the client SDK has no way to know if a method is
available without trying it and catching the error. This leaks
into:

- UI rendering — should the "Connect Linear" button appear at all?
- Feature gating — can we offer this functionality to the user?
- Graceful degradation — older gateway, newer client.

Capability discovery is the runtime confirmation that the static
type system can't provide (the gateway might not have the package
installed).

---

## Cluster routing

Most wire-extension methods are SESSION-SCOPED — they operate on a
specific session's bridges (the MCP harness lookup goes through
`bridges.mcp.client(serverId)`, which is per-session per ADR 23).
Cluster routing for these is "session-local" — the request gets
routed to the node owning the session.

A small set may be GATEWAY-SCOPED — they don't touch a session
(`credentials/list-namespaces` administering the gateway-level
credentials store). These can be handled by any node holding the
gateway-level state.

Rare future methods may be LEADER-SCOPED — only the cluster's leader
node can answer (admin operations, topology mutations).

Extensions declare per-method routing via `clusterRoute`:

```ts
clusterRoute: {
  "mcpClients/reauthenticate": "session-local",
  "mcpClients/list": "session-local",
  "credentials/list-namespaces": "any",
}
```

Default if absent: `"session-local"` if the method's params include a
sessionId (the gateway can infer); `"any"` otherwise.

---

## Auth integration

The gateway's existing auth middleware (per ADR 33's `AuthSource`)
runs against the method's `auth` declaration. Per-method override
wins over gateway-level default. Auth failures return a wire-level
JSON-RPC error with the canonical agentick auth error code.

```ts
auth: {
  "mcpClients/reauthenticate": { required: true, scope: "session-user" },
  "credentials/list-namespaces": { required: true, scope: "admin" },
}
```

`scope` is a STRING label — the gateway's auth middleware decides
what it means. The framework doesn't impose a role hierarchy; adopters
plug their authorization model into the gateway's `AuthSource` and
that flows through.

---

## Conformance + test discipline

A new `runWireExtensionConformance` helper in
`@agentick/spec-conformance` (sibling to `runHarnessSlotConformance`
from #267) drives the executable checklist for any extension:

```ts
runWireExtensionConformance({
  name: "@agentick/mcp mcpControlWireExtension",
  extension: mcpControlWireExtension,
  // declared methods all appear in WireMethods?
  // declared notifications all appear in WireNotifications?
  // all method names use the declared namespace prefix?
  // auth declarations reference valid methods?
  // clusterRoute declarations reference valid methods?
  // capability discovery returns correct payload?
});
```

This is the executable form of the audit. Every wire extension that
ships through the framework runs this in its package's test suite.

---

## Implementation plan

The ADR specifies the design; implementation lands as sub-tickets.

**Phase A — spec-next types + WireExtension interface. ✅ LANDED.**

- `WireExtension` / `WireExtensionContext` / `WireMethodAuth` types
  in `@agentick/spec/wire/extension.ts`.
- `defineWireExtension(opts)` helper that validates the extension at
  construction (namespace prefix, method-name alignment, etc.).
- No runtime behavior change in this phase.

**Phase B — dispatcher + registry plumbing. ✅ LANDED (#295 Phase B).**

Reversal from the original ADR sequencing: Phase B does NOT depend on
#254 (formal `GatewayExtension` factory type). Empirical validation
during #295 revealed the registry + dispatcher can land standalone,
and only the composite-extension shape (Phase E, #297) actually
needs #254 formalized. Phase C (framework methods refactor) also
unblocks independently. #254 slots in between Phase C and Phase E
with real evidence from Phase B/C code to inform the design.

Delivered:

- `WireExtensionRegistry` interface in spec + concrete
  `createWireExtensionRegistry()` in `@agentick/gateway`.
- `GatewayHarnessOptions.wireExtensions?: WireExtension[]` — adopter
  ad-hoc registration path.
- `GatewayHarness.wireExtensions()` publicly exposes the sealed
  registry.
- Optional `wireExtensions?()` on `GatewayHarnessProtocol` — bare
  test stubs still typecheck.
- `@agentick/transport` dispatcher checks the registry BEFORE
  its hardcoded switch.
- `_extensions/list` built-in wire method returns the enumerate
  view.
- Duck-typed session/app resolution from `params.sessionId` /
  `params.appId`.
- `ctx.publish` validates against declared notifications — throws
  when the extension didn't declare a notifications array at all,
  or when the requested name isn't in it.

**Phase C — framework methods refactor. ✅ LANDED (#295 Phase C).**

Non-streaming framework methods now flow through the same wire
extension registry adopters use:

- `gatewayWireExtension` — `gateway/list_apps`, `gateway/get_app`.
- `appWireExtension` — `app/create_session`, `app/get_session`,
  `app/list_sessions`.
- `sessionWireExtension` — `session/dispatch`, `session/abort`,
  `session/close`, `session/respond_to_elicitation`.

Registered as framework defaults on `GatewayHarness` construction,
BEFORE adopter-supplied extensions. Adopter attempts to claim
`gateway` / `app` / `session` namespaces surface as
`WireExtensionDefinitionError` at construction — no silent
shadowing.

`auth/*` remains type-stubs only — refactor lands with #302
alongside the ADR 33 auth subsystem.

**Post-Phase-C (streaming primitives + subscribe rename + full
dogfood) — ✅ LANDED (#300 + #303).**

Extended `WireExtensionContext` with a `transport` slot that
carries typed streaming primitives:

- `progress(progressToken)` returns a `ProgressReporter` with
  auto-cursor tracking + `notifications/progress` emit.
- `registerCancel(abort)` bridges to
  `sink.registerInFlight(reqId, abort)`; auto-cleared on RPC
  return.
- `registerSubscription(cleanup)` returns a
  `SubscriptionHandle` (`id`, `publish(envelope)`,
  `close(reason?)`) with server-allocated id + auto-cursor
  tracking + cleanup routing.
- `closeSubscription(id)` is the client-initiated teardown seam.

`session/send`, `sub/subscribe`, `sub/unsubscribe` all use this
slot — no direct sink access. The rename `subscribe` →
`sub/subscribe` + `unsubscribe` → `sub/unsubscribe` (#300) closed
concurrently so the methods fit the wire-extension namespace-prefix
validator.

The transport dispatcher's error handler also maps AgentickError
subclasses to matching JSON-RPC error codes so typed errors reach
the client with structured shape instead of a generic
"internal error" wrapper.

Result: only three methods dispatch outside the extension registry
— `initialize`, `ping`, `_extensions/list` — because they run
BEFORE the registry is queryable. Full dogfood: **every other
framework method is a `WireExtension`.**

**Phase D — capability discovery + client.capabilities.**

- Built-in `_extensions/list` method on the gateway.
- `@agentick/client` populates `client.capabilities` at
  connect time.

**Phase E — composite extension shape for existing factories.**

- Update `withMCP`, `withCredentials`, etc. to return composite
  objects. Existing single-scope returns continue to work (single
  field `session` instead of bare `SessionExtension`).

**Phase F — first canonical wire extension: mcpControlWireExtension.**

- `@agentick/mcp` ships `wire/server.ts` + `wire/client.ts` +
  augmentation. `withMCP` self-installs.
- Closes #279 (client MCP projection) + #277d (React useMcpClient).

**Phase G — conformance suite.**

- `runWireExtensionConformance` ships in spec-conformance-next.
- Existing extensions adopt it.

Each phase is one ticket. Estimated effort: 2-3 days per phase, ~2
weeks total. Some phases (B, C) need design pass when #254 lands.

---

## What this ADR does NOT settle

- **Streaming RPCs.** Long-running calls with intermediate progress
  (vs single-shot request/response). MCP's task model already handles
  this for tool calls; new extensions probably don't need it until a
  use case emerges. Deferred.
- **Bidirectional methods.** Client calling INTO the server is the
  default direction. Server-initiated requests TO the client
  (e.g., gateway pushing an elicit) flow over the existing
  notification + reply path. No new primitive needed here.
- **OpenRPC schema export.** Generating `_extensions/list` payloads
  as full OpenRPC schemas for tooling. Mentioned in the existing
  spec JSDoc; out of scope.
- **Hot reload / dynamic registration.** Extensions register at
  gateway construction; no mid-lifetime mutation. Conflicts with
  capability discovery and cluster consistency. Future ADR if
  demand emerges.

---

## What we considered and rejected

### Per-harness wire surface

Considered: each harness exposes its own `.wireMethods` getter that
the gateway aggregates. Rejected because:

- Couples harness implementation to wire concerns (auth, cluster,
  enumeration) the harness shouldn't know about.
- Not every harness has wire-exposed methods (CredentialsHarness
  deliberately doesn't).
- Adopter-authored RPC (the CRM example) isn't backed by a harness.

The wire-extension primitive is properly separate from harness
internals. Wire extensions PROJECT harness state — they don't IS
harness state.

### Single global method registry without namespaces

Considered: drop the `namespace` field, just key by full method
name. Rejected:

- Easier accidental conflicts.
- Capability discovery groups poorly without namespaces.
- Auth policies often group naturally by namespace ("everything under
  `credentials/*` requires admin").
- Cluster routing decisions often group by namespace.

Namespaces are organizational + enforcement glue. Cheap to require.

### Wire extensions installed at SESSION level (not gateway)

Considered: per-session wire registries. Each session has its own
methods. Rejected:

- Sessions don't have their own RPC surfaces — they're routed via the
  gateway's single RPC channel.
- Session-scoped methods are still gateway-dispatched; they just take
  a sessionId param.
- Adopter mental model breaks if "what RPCs can I call" varies per
  session.

Wire surface is gateway-level. Methods may be session-scoped via
their params, but the registry is one per gateway.

---

## Cross-references

- ADR 33 — Client + transports (the wire protocol foundation this ADR
  extends)
- ADR 32 — Extension shape spectrum (this ADR adds a fifth shape:
  wire extension; or refines shape 1 to acknowledge multi-scope
  composites)
- ADR 27 — Modular built-ins (the empty-seed augmentation pattern
  WireMethods uses is the same one HookBridges / RuntimeContextUser
  use)
- ADR 45 — Runtime context model (the RuntimeContext threaded through
  `WireExtensionContext`)
- #254 — Gateway extensions framework (prerequisite; ADR 46 depends
  on #254's design)
- #277 — MCP connection-status + credentials (driver use case)
- #279 — Project MCP client surface over the wire (canonical first
  user of this framework)
- #277d — React useMcpClient (consumes the wire extension via the
  client subpath)
- `credentials-never-cross-wire` memory — wire extensions for
  credentials administration must respect the rule (admin verbs only;
  token material stays server-resident)
- `enumeration-is-foundational` memory — every collection surface
  exposed via a wire extension ships `enumerate` + `added`/`removed`
  notifications by convention
- `wire-constraints-at-the-wire` memory — wire-shape concerns
  (flatness, MCP compat, JSON-RPC error codes) live at the wire
  layer, not at substrate primitives
