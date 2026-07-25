# `@agentick/spec/wire`

Wire protocol types for the **Agentick client↔gateway** JSON-RPC
surface. Owned by spec-next; consumed by `@agentick/client`,
`@agentick/gateway`, every transport package, and every wire
extension package.

> Terminology: "wire" here means the **Agentick** client↔gateway wire.
> NOT to be confused with the **MCP protocol** (a separate layer that
> `McpClientHarness` speaks to external MCP servers). The two never mix.

---

## Naming convention

**snake_case for what you route on; camelCase for what you carry.**

| Token                     | Casing                                 | Examples                                                                    |
| ------------------------- | -------------------------------------- | --------------------------------------------------------------------------- |
| **Method names**          | `snake_case`, lowercase, `/`-segmented | `app/create_session`, `gateway/list_apps`, `session/respond_to_elicitation` |
| **Notification names**    | `snake_case`, lowercase, `/`-segmented | `notifications/subscription/event`, `notifications/auth/expired`            |
| **Param / result fields** | `camelCase`                            | `{ sessionId, appId, progressToken }`                                       |

Single-word verbs stay bare (`session/send`, `session/dispatch`, `knobs/set`,
`commands/list`) — snake_case only bites multi-word tokens. Namespaces (the
first segment) are lowercase, snake_case if multi-word (`mcp_clients/…`).

**Why the split** (it's one rule, not two): a method name is an **opaque routing
string** — never a program identifier — so `snake_case` there is language-neutral
and costs nothing in any client. A param field **becomes an identifier** in the
consuming code, and Agentick's reference stack has **no serialization boundary**:
the wire JSON object IS the TypeScript object (`client.request("app/create_session",
{ sessionId })` — the same `{ sessionId }` is the type, the handler arg, and the
wire payload). `snake_case` params would therefore pour `session_id` through the
whole `camelCase` TS codebase, with no serde layer to contain it. Non-JS clients
convert either casing via their own serde, so they don't tip the decision. See
the [ADR 51 discussion](../../../docs/proposals/v2/blueprint/51-invocation-and-authorization.md).

**External-protocol parity overrides this.** When a name mirrors an external
protocol verbatim, use its own spelling — e.g. `notifications/tools/list_changed`
is MCP's own wire name. (Conveniently, MCP uses this same split — `snake_case`
method/notification names, `camelCase` params — so alignment is free.)

---

## Status

Phase 33.A foundation shipped (#251-era — JSON-RPC envelope types,
method registry, notification registry, scope discriminator, frame
validator).

**Phase A of #280 (Wire extensions framework) — landed.** New
`WireExtension` primitive + `defineWireExtension` validator.

**Phase B of #280 (Wire dispatcher + registry) — landed (#295).**

- `WireExtensionRegistry` interface (this package) + concrete
  `createWireExtensionRegistry()` (`@agentick/gateway`).
- `GatewayHarnessOptions.wireExtensions?: WireExtension[]` opt-in.
- `GatewayHarness.wireExtensions()` publicly exposes the sealed
  registry.
- `@agentick/transport` dispatcher consults the registry
  BEFORE its hardcoded switch, so adopter extensions dispatch
  end-to-end.
- `_extensions/list` built-in wire method returns the enumerate
  view for capability discovery (Phase D wires this into
  `client.capabilities`).

**Phase C of #280 (Framework methods as wire extensions) — landed
(#295).**

- `gatewayWireExtension` (`gateway/list_apps`, `gateway/get_app`),
  `appWireExtension` (`app/create_session`, `app/get_session`,
  `app/list_sessions`), `sessionWireExtension`
  (`session/send`, `session/dispatch`, `session/abort`,
  `session/close`, `session/respond_to_elicitation`), and
  `subscriptionsWireExtension` (`sub/subscribe`,
  `sub/unsubscribe`) ship in `@agentick/gateway` and register
  as defaults on every `GatewayHarness`.
- Framework extensions register BEFORE adopter-supplied extensions.
  Adopter attempts to claim `gateway` / `app` / `session` / `sub`
  namespaces surface as `WireExtensionDefinitionError` at
  construction — no silent shadowing.
- Corresponding hardcoded cases deleted from the transport
  dispatcher.

**#303 (Streaming primitives on WireExtensionContext) — landed.**

`WireExtensionContext.transport` exposes typed streaming primitives:

- `progress(progressToken)` — returns a `ProgressReporter` that
  auto-tracks cursor ordering and emits
  `notifications/progress` frames.
- `registerCancel(abort)` — bridges to
  `sink.registerInFlight(reqId, abort)`; unregistered
  automatically when the RPC returns.
- `registerSubscription(cleanup)` — returns a
  `SubscriptionHandle` (`id`, `publish(envelope)`,
  `close(reason?)`); server-side allocates the id, cursor tracking
  is automatic, cleanup fires on client unsubscribe.
- `closeSubscription(id)` — client-initiated teardown seam.

`session/send`, `sub/subscribe`, `sub/unsubscribe` all use this
slot instead of poking at the sink directly — completing the ADR 46
eat-our-own-dogfood commitment.

**#300 (subscribe/unsubscribe rename) — landed.** Bare `subscribe`
/ `unsubscribe` renamed to `sub/subscribe` / `sub/unsubscribe` so
they fit under `subscriptionsWireExtension` per the wire-extension
namespace-prefix rule.

**Error surface — landed.** The dispatcher's `catch` maps
`AgentickError` subclasses to matching JSON-RPC error codes
(`AppNotFoundError` → `AppNotFound`, `SessionNotFoundError` →
`SessionNotFound`, validation errors → `InvalidParams`, etc.).
Falls back to `InternalError` for unmapped tags. Handler-thrown
errors reach the client with typed shape instead of a generic
"internal error" wrapper.

Capability discovery (#296), composite extension factories (#297),
the canonical `mcpControlWireExtension` first-user (#298), and the
conformance helper (#299) land in subsequent phases per ADR 46.

---

## Two ways to contribute to the wire

### Built-in methods

Live directly in `params.ts` (`WireMethods` interface) and
`notifications.ts` (`WireNotifications` interface). Framework-core
methods like `session/send`, `gateway/list_apps`, `subscribe`. Dispatch
is hardcoded into the gateway today.

### Wire extensions (ADR 46)

Adopters and framework packages add new JSON-RPC namespaces
without patching the framework. Each extension declares:

- A **namespace** prefix (`mcp_clients`, `credentials`, `crm`).
- **Methods** under that prefix — handler bodies, auth declarations,
  cluster-routing hints.
- **Notifications** the extension publishes.

Type-level extension is via TypeScript declaration merging into
`WireMethods` / `WireNotifications`. Runtime registration is via the
gateway's `wireExtensions: [...]` option (adopter ad-hoc) or via
package composite extension factories (`withX(...)` returning
`{ session?, wire?, ... }`).

See `docs/proposals/v2/blueprint/46-wire-extensions.md` for the
design rationale.

---

## Authoring a wire extension

```ts
// Step 1 — declare-merge type-level entries:
declare module "@agentick/spec" {
  interface WireMethods {
    "myext/do_thing": { params: DoThingParams; result: DoThingResult };
  }
  interface WireNotifications {
    "myext/thing_changed": ThingChangedParams;
  }
}

// Step 2 — author the extension value (validated at construction):
import { defineWireExtension, type WireExtension } from "@agentick/spec";

export const myWireExtension: WireExtension = defineWireExtension({
  name: "@my-org/my-extension",
  namespace: "myext",
  version: "1.0.0",
  methods: {
    "myext/do_thing": async (params, ctx) => {
      // ctx exposes:
      //   ctx.gateway   — GatewayHarnessProtocol (always present)
      //   ctx.app       — AppHarnessProtocol (when method is app-scoped)
      //   ctx.session   — SessionHarnessProtocol (when method is session-scoped)
      //   ctx.bridges() — HookBridges (thunk; lazy resolution post cluster route)
      //   ctx.publish(name, params) — fire a declared notification
      //
      // Handler is async — return Promise<DoThingResult>.
      // Throws AgentickError subclasses for typed wire-error responses.
      const result = await doSomething(params);
      ctx.publish("myext/thing_changed", { id: result.id });
      return result;
    },
  },
  notifications: ["myext/thing_changed"],
  auth: {
    "myext/do_thing": { required: true, scope: "session-user" },
  },
  clusterRoute: {
    "myext/do_thing": "session-local", // default for session-scoped; explicit here for clarity
  },
});

// Step 3 — install:
//   Package self-install (Phase E): withMyExt() returns
//     { session: ..., wire: myWireExtension } as a composite extension.
//   Adopter ad-hoc:
//     createGateway({ wireExtensions: [myWireExtension] });
```

### The method dichotomy — bare handler OR rich config (ADR 90)

A `methods` entry is a bare handler (above) OR a flat config object that attaches
define-time seams to the method's `wire:<method>` op. `defineWireExtension`
normalizes the config down to a bare handler + a merged `auth` entry + the op
config the gateway composes at dispatch — so the registry and dispatcher only
ever see bare handlers.

```ts
methods: {
  "myext/do_thing": {
    handler: async (params, ctx) => doSomething(params),
    // Admission guard — veto/defer/replace/proceed. Honored at the JSON-RPC edge:
    // veto → Forbidden, defer → RateLimited (retry-after), replace → success.
    guard: (params, ctx) => (blocked(params) ? { kind: "veto" } : undefined),
    // Middleware wraps this method's dispatch (timing/retry); scoped to the op.
    middleware: async (params, next, ctx) => next(params),
    spanAttributes: { "myext.tier": "premium" },  // static op-span attributes
    auth: { required: true, scope: "session-user" }, // merged into ext.auth
  },
},
```

Every `WireMethods` row also mints TYPED gateway hooks — `onBeforeWire<Ns><Method>`
/ `onAfterWire<Ns><Method>`, derived from the row (params → before-hook input,
result → after-hook output); a before-hook may reshape the params the handler
sees. `defineWireExtension` accepts a `WireExtensionInput` (the authoring type
with the method dichotomy) and returns a normalized `WireExtension`.

---

## Validation rules

`defineWireExtension(opts)` enforces all of these at definition
time. Violations throw `WireExtensionDefinitionError` (an
`AgentickError` subclass with `_tag: "WireExtensionDefinitionError"`):

| #   | Rule                                                            | Reason                                               |
| --- | --------------------------------------------------------------- | ---------------------------------------------------- |
| 1   | At least one method declared                                    | Empty extension does nothing                         |
| 2   | `namespace` non-empty                                           | Required for routing + enumeration                   |
| 3   | `namespace` doesn't contain `/`                                 | Namespaces are bare identifiers                      |
| 4   | `namespace` doesn't start with `_`                              | Reserved for framework-internal (`_extensions/list`) |
| 5   | Every method name starts with `${namespace}/`                   | Routing relies on the prefix                         |
| 6   | Every declared notification starts with `${namespace}/`         | Same as above                                        |
| 7   | Every `auth` entry references a declared method                 | Prevents orphan policies                             |
| 8   | Every `clusterRoute` entry references a declared method         | Prevents orphan policies                             |
| 9   | No method declares `auth` in BOTH its config and the `auth` map | One enforcement point — ambiguity is rejected        |

Validation order is intentional — empty-methods check fires first
because it's the most fundamental, then namespace shape, then per-method
constraints, then orphan-policy checks. The error a developer sees is
the most-load-bearing one first.

---

## Cluster routing

Each method declares (or defaults) one of three routes:

| Route             | Meaning                                         | When                                                                              |
| ----------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `"session-local"` | Route to the node owning the session            | Methods whose params include a sessionId. **Default** for session-scoped methods. |
| `"any"`           | Any node holding gateway-level state can answer | Gateway-scoped methods. **Default** for non-session methods.                      |
| `"leader"`        | Only the cluster's leader node may answer       | Admin operations, topology-mutating methods.                                      |

In single-node deployments all routes resolve to the local node;
the declaration is forward-compatible with cluster expansion.

---

## Auth

Per-method `WireMethodAuth`:

```ts
{ required: boolean; scope?: string }
```

`required: true` → only authenticated sessions may call. The `scope`
label is opaque to the framework — the gateway's `AuthSource` (per
ADR 33) decides what scopes mean. Adopters wire their authorization
model into the `AuthSource`; this declaration is the seam where
per-method policy plugs in.

Methods without an explicit entry inherit the gateway's default
policy (typically `{ required: true }` for production deployments).

---

## Capability discovery — `_extensions/list`

The gateway registers a built-in `_extensions/list` method (Phase B
implementation). It returns:

```ts
interface ExtensionsListResult {
  readonly extensions: readonly {
    readonly name: string;
    readonly namespace: string;
    readonly version?: string;
    readonly methods: readonly string[];
    readonly notifications: readonly string[];
  }[];
}
```

`@agentick/client` calls this immediately after the `initialize`
handshake and populates `client.capabilities`. UI code can gate
features on capability presence:

```ts
if (client.capabilities.has("mcpClients/reauthenticate")) {
  // Show the "Connect Linear" button.
}
```

`_extensions` is reserved as a framework-internal namespace — adopter
extensions can't claim it. The validator rejects.

---

## What's NOT in this README

- The full ADR 46 design rationale — see
  `docs/proposals/v2/blueprint/46-wire-extensions.md`.
- The composite extension factory pattern (`{ session?, app?, gateway?, wire? }`) —
  pending Phase E (#297).
- The client-side helpers / React hooks for consuming a wire
  extension — pending Phase F (#298). The package's `/client` subpath
  is the canonical home for those.
- The `runWireExtensionConformance` test helper — pending Phase G
  (#299).

---

## Verified by

- `__tests__/wire-extension.spec.ts` — 9 tests covering happy path +
  all 8 validation rules (Phase A).
- `__tests__/wire.spec.ts` — JSON-RPC envelope + validator coverage
  for the broader wire surface (Phase 33.A).
- `../../gateway/src/__tests__/wire-registry.spec.ts` — 7 tests for
  the concrete `WireExtensionRegistry` (register / resolve /
  enumerate / seal, duplicate-namespace + duplicate-name rejection)
  (Phase B).
- `../../transport/src/__tests__/wire-extension-dispatch.spec.ts` —
  11 tests for the dispatcher's registry lookup path: registered
  extensions dispatch, ctx duck-types session/app, `ctx.publish`
  validates against declared notifications (throws when undeclared),
  `_extensions/list` enumerates, MethodNotFound for unknown methods,
  handler exceptions surface as JSON-RPC errors (Phase B).

## Roadmap & known gaps

- ✅ #295 Phase B — dispatcher + registry (**landed**).
- ✅ #295 Phase C — non-streaming framework methods refactored into
  `WireExtension` values (**landed**).
- ✅ #300 — `subscribe`/`unsubscribe` → `sub/subscribe` /
  `sub/unsubscribe` rename (**landed**).
- ✅ #303 — `WireExtensionContext.transport` streaming primitives
  - `session/send` + `sub/subscribe` + `sub/unsubscribe` refactored
    into wire extensions (**landed**). Full ADR 46
    eat-our-own-dogfood commitment realized — the only remaining
    hardcoded methods are the three bootstrap builtins
    (`initialize`, `ping`, `_extensions/list`).
- ⏳ #296 — Capability discovery + `client.capabilities` (Phase D).
- ⏳ #297 — Composite extension factory shape — `withX` returns
  multi-scope objects (Phase E). Depends on #254 (Gateway extensions
  formal type, needs design).
- ⏳ #298 — `mcpControlWireExtension` (Phase F — the canonical first
  user; closes #279, unblocks #277d).
- ⏳ #299 — `runWireExtensionConformance` helper (Phase G — executable
  audit suite).
- ⏳ #300 — Rename `subscribe`/`unsubscribe` → `sub/subscribe` +
  `sub/unsubscribe` so they can move into a `subscriptionsWireExtension`
  (wire-namespace-prefix validator rejects bare names). Punted from
  #295 to isolate the wire-protocol-version bump.
- ⏳ #301 — Move dispatch logic from `@agentick/transport` to
  `@agentick/gateway` (transport keeps wire framing; gateway
  gains the logical dispatch entry point).
- ⏳ #302 — `authWireExtension` — builds alongside ADR 33 auth
  subsystem; today's `auth/*` methods are type-stubs only.
- ⚠ Phase B design items deferred to later phases:
  - `ctx.bridges()` returns `{}` for Phase B — no framework
    extension needs it yet. Phase F (mcpControlWireExtension) is
    the first consumer and will resolve bridges from the target
    session's session-extension registry.
  - Handler exceptions collapse to `ErrorCode.InternalError` on the
    wire. Typed AgentickError → JSON-RPC error code mapping is a
    broader dispatcher concern (see #301).
  - Cross-extension notification-name collision detection deferred
    (low-priority — declaration-merged `WireNotifications` types
    already provide compile-time signal).

## See also

- [ADR 46 — Wire extensions](../../../../../docs/proposals/v2/blueprint/46-wire-extensions.md)
- [ADR 33 — Client + transports](../../../../../docs/proposals/v2/blueprint/33-client-and-transports.md)
- [`@agentick/client`](../../../../client) — the Agentick client
  SDK that consumes wire methods + notifications
- [`@agentick/gateway`](../../../../gateway) — registers and
  dispatches wire extensions
