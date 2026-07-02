# ADR 50 — Gateway extensions: the formal `GatewayExtension` contract (#254)

**Status:** Draft · 2026-07-01
**Builds on:** ADR 26 (Harness API shape), ADR 27 (Modular built-ins),
ADR 31 (Harness hierarchy), ADR 32 (Extension shape spectrum), ADR 33
(Client + transports), ADR 40 (MCP server harness), ADR 45 (Runtime
context), ADR 46 (Wire extensions), ADR 48 (Layered isolation)
**Touches:** `@agentick/spec-next` (`GatewayExtension`,
`GatewayInstaller`, `GatewayBridges` seed, `ExtensionBundle`),
`@agentick/gateway-next` (installer impl, bundle distribution) +
`@agentick/transport-next` (ingress interceptor chain at the dispatch
edge), every `withX` composite factory (#297)
**Unblocks:** #283 (gateway-level `withCredentials`), #297 (composite
factories), #298 (`mcpControlWireExtension`), ADR 34/#302 (auth at the
edge), connectors (CUT-PLAN §C1), MCP server mode B (#171)

## TL;DR

**`GatewayExtension` completes the extension triad with the same
contract as `AppExtension`/`SessionExtension`: timing, not shape.**
`{ name, target: "gateway", install(installer) }`, fired during
`GatewayHarness` construction, before `ready`, before the wire-extension
registry seals.

The `GatewayInstaller` mirrors `AppInstaller` plus three gateway-only
capabilities:

1. **`registerWireExtension(ext)`** — the missing programmatic install
   path into the ADR 46 registry (today only `createGateway({
   wireExtensions })` and framework self-install exist).
2. **`interceptIngress(interceptor)`** — a chain-of-responsibility at
   the **transport ingress edge** (where a transport establishes a
   connection / builds the per-request `WireExtensionContext`), the seam
   ADR 34 needs to turn a transport token into `principal` +
   `RuntimeContextUser` on the runtime context. (Post-ADR-47 the gateway
   holds no connection registry — connection lifecycle is transport-layer;
   the interceptor runs there, not over a gateway `acceptConnection`.)
3. **`registerNamespace(name, value)`** into a new **`GatewayBridges`**
   empty-seed interface (the gateway-scope twin of `HookBridges`),
   with **occupied-slot ⇒ throw**.

**`ExtensionBundle` (#297) is resolved here:** a `withX()` composite
returns `{ gateway?, app?, session?, wire? }`; `createGateway({
extensions: [...] })` accepts bundles or bare extensions and distributes
the parts — gateway parts install now, wire parts register into the
registry, app/session parts become defaults for every `gateway.createApp`
/ `createSession` beneath it. One install site, correct scope for each
part.

Shape stays ADR 32's business: an extension *installs* a harness, a
namespace object, a bus subscriber, or nothing at all. This ADR adds no
shape taxonomy — it defines when gateway extensions run and what they
may touch.

## Problem

ADR 32 names `GatewayExtension` as if it exists; it doesn't — only
`AppExtension` and `SessionExtension` are declared
(`spec/src/protocol/app-extension.ts`). The gap is the recurring
blocker:

- #283: `withCredentials` can install at app scope but a gateway serving
  many apps wants ONE credentials harness at gateway scope.
- ADR 46 wire extensions have two install paths (framework self-install
  at construction; adopter array on `createGateway`) but **packages**
  that want to bring wire methods along with their harness (MCP control
  plane #298, tasks/elicitation projections) have no sanctioned hook.
- ADR 40's MCP server **mode B** ("gateway-extension mode") has no
  contract to be an extension *of*.
- Auth (#302/ADR 34) needs a place to turn a transport token into
  `principal` at the ingress edge, before the runtime context is built.
  (Historically a gateway `acceptConnection` carried
  `{ transport, connectionId }` metadata with reserved slots — that
  surface was removed wholesale in ADR 47; there is now no gateway
  connection registry to stamp onto, so the seam belongs at transport
  ingress.)
- v1 parity items headed for the gateway (connectors, openai-compat,
  logging) each need the same timing hook.

Six consumers, zero contract. That comfortably clears the
three-consumers rule.

## The contract

### `GatewayExtension`

```ts
export interface GatewayExtension extends ExtensionBase {
  readonly target: "gateway";
  install(installer: GatewayInstaller): void | Promise<void>;
}
```

Identical discipline to the existing pair: `install` runs once during
`GatewayHarness` construction, after the framework's own wire extensions
register and before the registry seals at `ready`. Async installs are
awaited; `ready` does not resolve until every extension has installed.
Extensions close in reverse install order during `closeGateway()` via
`onClose` registrations.

### `GatewayInstaller`

```ts
export interface GatewayInstaller extends BaseInstaller {
  readonly kind: "gateway";
  /** Gateway-scope substrate (journal / bus / inbox). */
  readonly substrate: AppSubstrate;
  /** Late-binding host handle. */
  readonly gateway: GatewayInstallerHost;

  /** Install a namespace into GatewayBridges. Occupied slot ⇒ throw. */
  registerNamespace<K extends keyof GatewayBridges>(
    name: K,
    value: GatewayBridges[K],
  ): Unsubscribe;

  /** Programmatic path into the ADR 46 wire-extension registry.
   *  Valid only before seal; throws after ready. */
  registerWireExtension(extension: WireExtension): void;

  /** Chain-of-responsibility at the transport INGRESS edge. Interceptors
   *  run in install order; each ENRICHES the ingress context (adds
   *  principal, RuntimeContextUser, adopter discriminators) or rejects
   *  the request by throwing a typed AgentickError. Enrichment only —
   *  see the contract note below. */
  interceptIngress(interceptor: IngressInterceptor): Unsubscribe;

  /** Same observer surface the other installers have. */
  subscribeBus(
    filter: EventQuery,
    listener: (event: ProtocolEvent) => void | Promise<void>,
  ): Unsubscribe;

  onClose(fn: () => void | Promise<void>): void;
}

export interface GatewayInstallerHost {
  readonly gatewayId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly apps: () => readonly AppHarnessProtocol[];
}

/** Runs where the transport builds the per-request/-connection runtime
 *  context (the same point `WireExtensionContext` is constructed).
 *  `ingress` carries the transport-supplied primitives (transport kind,
 *  auth material, connection id where the transport has one); the
 *  interceptor returns an enriched runtime context. */
export type IngressInterceptor = (
  ingress: IngressContext,
) => RuntimeContext | Promise<RuntimeContext>;
```

Notes:

- **`interceptIngress` is the whole auth seam this ADR provides, and it
  is ENRICHMENT-ONLY.** ADR 34 ships *as a gateway extension*: extract
  token per transport, verify, produce `principal` + `RuntimeContextUser`
  onto the runtime context. `principal` then feeds ADR 48's **structural
  identity** — per-principal child buses/instances at construction. The
  interceptor **must not** become a runtime authorization filter: gating
  requests by re-reading identity per call is exactly the `notify({to})`
  runtime-filter pattern ADR 47 killed. Its only job is to *stamp
  identity at the boundary*; isolation is structural downstream, never a
  predicate here. The framework never interprets `user` for authorization
  (ADR 45). Rejection is a typed error the transport maps to its wire
  (constraints live at the wire).
- **No per-socket dimension in v2.0.** The interceptor enriches the
  runtime context, not a connection registry (there is none post-ADR-47).
  If a genuinely per-socket need ever appears, ADR 47's rejected-for-now
  Alternative B — `connectionId` as an `EventScopeExtensions` dimension —
  is the designated escape hatch, to be taken with a concrete consumer,
  not speculatively.
- **No `createApp` on the installer.** Extensions do not spawn apps;
  they equip the gateway. Adopters own topology. (An extension that
  genuinely needs a companion app is a recipe/document pattern, not an
  installer capability — revisit only with a concrete consumer.)
- `registerWireExtension` after seal throws — same sealed-registry rule
  ADR 46 already established; no dynamic post-ready install in v2.0
  (#308 reactivity is about *capability signaling*, not late install).

### `GatewayBridges` (empty seed)

The gateway-scope twin of `HookBridges`, same module-augmentation
pattern (ADR 27):

```ts
// spec-next
export interface GatewayBridges {} // empty seed

// credentials package, augment.ts
declare module "@agentick/spec-next" {
  interface GatewayBridges {
    readonly credentials: CredentialsHarnessProtocol;
  }
}
```

Adopter access: `gateway.bridges.credentials`. Runtime registration via
`registerNamespace` throws on an occupied slot — the runtime mirror of
the type-level seam (prices the augmentation version-skew risk; same
guard lands on the app-side `extensionBridges` map in the same arc).

### `ExtensionBundle` — the #297 composite

```ts
export interface ExtensionBundle {
  readonly name: string;
  readonly gateway?: GatewayExtension;
  readonly app?: AppExtension;
  readonly session?: SessionExtension;
  readonly wire?: readonly WireExtension[];
}
export type AnyExtension =
  | GatewayExtension | AppExtension | SessionExtension | ExtensionBundle;
```

Distribution rules (`createGateway({ extensions: AnyExtension[] })`):

| Part       | When it runs                                                        |
| ---------- | ------------------------------------------------------------------- |
| `gateway`  | Now, during gateway construction                                     |
| `wire`     | Registered into the registry now (sugar for `registerWireExtension`) |
| `app`      | Cascaded default for every `gateway.createApp`                       |
| `session`  | Cascaded default for every session under those apps                  |

`createApp` / `createSession` continue to accept their own extension
arrays; cascaded defaults compose *before* per-call extensions
(mergeLayered semantics — outer scope first, inner scope may extend, no
silent replacement). A bare `GatewayExtension` in the array is treated
as `{ gateway }`. Packages keep self-installing their wire extensions
when their harness part installs — the bundle's `wire` field is for the
parts that must exist even when only the gateway part is adopted.

This kills the current three-site adoption problem: `withMCP(...)` (or
`withCredentials`, or a connector) is passed **once**, at the outermost
scope the adopter owns, and every part lands at its correct scope.

### Standalone (gateway-less) unchanged

Apps without a gateway keep taking `AppExtension`/`SessionExtension`
directly — `createApp({ extensions })` accepts the same `AnyExtension`
union minus `gateway` parts (a bundle with only a `gateway` part throws
a descriptive error naming the missing scope). Local-pole adopters who
*do* run a gateway (the expected default) get the identical mental
model at both poles.

## Consumers and their shapes (ADR 32 applied)

| Consumer                         | Extension part(s)            | Installed shape                                                   |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| Credentials at gateway (#283)    | `gateway`                    | Shape 1 harness → `GatewayBridges.credentials`                     |
| Auth (ADR 34 / #302)             | `gateway`                    | `interceptIngress` chain + optional wire methods (reauth)          |
| MCP server mode B (ADR 40 #171)  | `gateway` (+ `wire`)         | Shape 1 harness; serves MCP over gateway transports                |
| MCP control plane (#298)         | `wire` (via bundle)          | Wire extension only                                                |
| Connectors (CUT-PLAN §C1)        | `gateway` (+ `session`?)     | Shape 1 harness (platform ingress ↔ session routing); own ADR      |
| Logging / devtools tunnel        | `gateway`                    | Shape 3 bus subscriber (10-line extension)                         |
| openai-compat shim (v1 parity)   | `gateway` (+ `wire`)         | Shape 1 harness per ADR 32's reshape table                         |
| Transport servers (optional)     | `gateway`                    | Listener bind in `install`, unbind in `onClose` — lifecycle sugar; the transport protocol itself stays independent of this contract |

## Cluster note

Gateway extensions install on **every node** (the gateway harness is
per-process). Extensions whose work must be cluster-singleton (a
connector long-polling Telegram, a scheduler beat) do NOT get a new
mechanism here — they use the existing supervisor-singleton seam from
the cluster layer. This ADR's only obligation: the installer exposes
enough (`substrate.bus`, `gateway.gatewayId`) for an extension to
coordinate; singleton election is the cluster protocol's job. Flagged
per-consumer in their own ADRs (connectors especially).

## What this does NOT propose

- **No shape taxonomy changes.** ADR 32's spectrum governs what an
  extension installs; this ADR only defines when and where.
- **No dynamic post-ready extension install** (v2.0). Reconstruct the
  gateway to change its extension set.
- **No auth implementation.** Only the interceptor seam; ADR 34 owns
  token handling, and token material never crosses the wire.
- **No gateway-level tool registry changes** — `GatewayHarnessOptions.tools`
  is untouched.
- **No per-extension configuration schema.** Extensions are configured
  by their own `withX(options)` flat options at construction, as today.

## Open questions

1. **Interceptor ordering guarantees.** Install order is deterministic
   for framework-then-adopter, but two adopter extensions that both
   enrich metadata may care about order. Current answer: array order in
   `extensions: [...]` is the contract. Revisit if a real conflict
   appears (do not add priority numbers speculatively).
2. **`GatewayBridges` exposure on the wire.** Should `_extensions/list`
   advertise installed gateway namespaces? Leaning yes-but-names-only
   (capability discovery, ADR 46), never values.
3. **Bundle cascade vs. ADR 42 slots.** A bundle's `session` part that
   constructs per-session harnesses must respect the single-construction-
   site exemptions (`withTasks`). The bundle mechanism doesn't change
   those rules; the audit row per package should confirm.

## References

- `packages-next/spec/src/protocol/app-extension.ts` — the contract this
  mirrors (`AppExtension`, `SessionExtension`, installers, `AppSubstrate`)
- `packages-next/gateway/src/harness.ts` — construction order, wire
  registry (note: ADR 47 removed the gateway connection/`acceptConnection`
  surface — ingress is transport-layer)
- `packages-next/transport-next/src/server/dispatch.ts` — where the
  per-request `WireExtensionContext` is built (the ingress edge the
  interceptor runs at)
- ADR 46 §install paths — the two existing routes this adds a third to
- ADR 47 — the notify/connection rip-out that grounds `interceptIngress`
  at transport ingress (and Alternative B, the per-socket escape hatch)
- ADR 32 — shape spectrum + v1 plugin/transport reshape tables
- ADR 34 (forthcoming) — auth as the first `interceptIngress` consumer
- `docs/proposals/v2/CUT-PLAN.md` §4 (B1) — sequencing context
