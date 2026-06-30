# `@agentick/spec-next/wire`

Wire protocol types for the **Agentick client↔gateway** JSON-RPC
surface. Owned by spec-next; consumed by `@agentick/client-next`,
`@agentick/gateway-next`, every transport package, and every wire
extension package.

> Terminology: "wire" here means the **Agentick** client↔gateway wire.
> NOT to be confused with the **MCP protocol** (a separate layer that
> `McpClientHarness` speaks to external MCP servers). The two never mix.

---

## Status

Phase 33.A foundation shipped (#251-era — JSON-RPC envelope types,
method registry, notification registry, scope discriminator, frame
validator).

**Phase A of #280 (Wire extensions framework) — landed.** New
`WireExtension` primitive + `defineWireExtension` validator. Runtime
dispatcher, capability discovery, composite extension factories, and
the canonical first user (`mcpControlWireExtension`) land in Phases
B–F per ADR 46.

---

## Two ways to contribute to the wire

### Built-in methods

Live directly in `params.ts` (`WireMethods` interface) and
`notifications.ts` (`WireNotifications` interface). Framework-core
methods like `session/send`, `gateway/listApps`, `subscribe`. Dispatch
is hardcoded into the gateway today.

### Wire extensions (ADR 46)

Adopters and framework packages add new JSON-RPC namespaces
without patching the framework. Each extension declares:

- A **namespace** prefix (`mcpClients`, `credentials`, `crm`).
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
declare module "@agentick/spec-next" {
  interface WireMethods {
    "myExt/doThing": { params: DoThingParams; result: DoThingResult };
  }
  interface WireNotifications {
    "myExt/thing-changed": ThingChangedParams;
  }
}

// Step 2 — author the extension value (validated at construction):
import { defineWireExtension, type WireExtension } from "@agentick/spec-next";

export const myWireExtension: WireExtension = defineWireExtension({
  name: "@my-org/my-extension",
  namespace: "myExt",
  version: "1.0.0",
  methods: {
    "myExt/doThing": async (params, ctx) => {
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
      ctx.publish("myExt/thing-changed", { id: result.id });
      return result;
    },
  },
  notifications: ["myExt/thing-changed"],
  auth: {
    "myExt/doThing": { required: true, scope: "session-user" },
  },
  clusterRoute: {
    "myExt/doThing": "session-local", // default for session-scoped; explicit here for clarity
  },
});

// Step 3 — install:
//   Package self-install (Phase E): withMyExt() returns
//     { session: ..., wire: myWireExtension } as a composite extension.
//   Adopter ad-hoc:
//     createGateway({ wireExtensions: [myWireExtension] });
```

---

## Validation rules

`defineWireExtension(opts)` enforces all of these at definition
time. Violations throw `WireExtensionDefinitionError` (an
`AgentickError` subclass with `_tag: "WireExtensionDefinitionError"`):

| #   | Rule                                                    | Reason                                               |
| --- | ------------------------------------------------------- | ---------------------------------------------------- |
| 1   | At least one method declared                            | Empty extension does nothing                         |
| 2   | `namespace` non-empty                                   | Required for routing + enumeration                   |
| 3   | `namespace` doesn't contain `/`                         | Namespaces are bare identifiers                      |
| 4   | `namespace` doesn't start with `_`                      | Reserved for framework-internal (`_extensions/list`) |
| 5   | Every method name starts with `${namespace}/`           | Routing relies on the prefix                         |
| 6   | Every declared notification starts with `${namespace}/` | Same as above                                        |
| 7   | Every `auth` entry references a declared method         | Prevents orphan policies                             |
| 8   | Every `clusterRoute` entry references a declared method | Prevents orphan policies                             |

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

`@agentick/client-next` calls this immediately after the `initialize`
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
  all 8 validation rules.
- `__tests__/wire.spec.ts` — JSON-RPC envelope + validator coverage
  for the broader wire surface (Phase 33.A).

## Roadmap & known gaps

- ⏳ #295 — Gateway wire dispatcher + extension registration (Phase B/C).
- ⏳ #296 — Capability discovery + `client.capabilities` (Phase D).
- ⏳ #297 — Composite extension factory shape — `withX` returns
  multi-scope objects (Phase E). Depends on #254 (Gateway extensions
  formal type, needs design).
- ⏳ #298 — `mcpControlWireExtension` (Phase F — the canonical first
  user; closes #279, unblocks #277d).
- ⏳ #299 — `runWireExtensionConformance` helper (Phase G — executable
  audit suite).
- ⚠ Phase A design items deferred to later phases: `bridges()` thunk
  vs value (load-bearing for cluster routing?), publish failure
  semantics, generic `SessionHarnessProtocol<unknown>` shape,
  extension-level `defaultAuth` / `defaultClusterRoute`, `dispose`
  hook, runtime `publish` validation. See ADR 46 §"What we considered
  and rejected" + the Phase A retro discussion.

## See also

- [ADR 46 — Wire extensions](../../../../../docs/proposals/v2/blueprint/46-wire-extensions.md)
- [ADR 33 — Client + transports](../../../../../docs/proposals/v2/blueprint/33-client-and-transports.md)
- [`@agentick/client-next`](../../../../client) — the Agentick client
  SDK that consumes wire methods + notifications
- [`@agentick/gateway-next`](../../../../gateway) — registers and
  dispatches wire extensions
