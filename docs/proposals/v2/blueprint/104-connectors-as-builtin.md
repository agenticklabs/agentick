# ADR 104 — Connectors as a gateway built-in (`gateway.connectors`)

**Status:** DRAFT 2026-08-26 (Fable, for Ryan — direction ratified in design conversation; NOT yet
built). **Amends:** ADR 50 (gateway extensions — connectors leave the bridges namespace; §"Built-ins
are not third parties" below), ADR 58 (connectors — the spec shape survives, the install mechanism
is replaced). **Builds on:** ADR 26 (harness as the single shape), ADR 27 (modular built-ins), ADR
31 (substrate threading, parent-flows-by-default), ADR 42 (the `withX` trichotomy), ADR 78/79
(telemetry via runtime substrate; explicit span propagation), ADR 81 (construction-parent
invariant), ADR 83 (one interceptor primitive; §4 live inheritance), ADR 91 (ctx spine), ADR 100
(identity-scoped dispatch — the `as()` door connectors ride).

## TL;DR

1. **Connectors are promoted from extension to built-in.** `gateway.connectors` is a
   `ConnectorsHarness` — a first-class field, constructed by `GatewayHarness` as its own child on
   the gateway's substrate, exactly as `SessionHarness` constructs `knobs`/`elicitation`/`tasks`.
2. **`defineConnector(spec)` returns a validated `ConnectorSpec`** — data + closures — **not a
   `GatewayExtension`.** Specs register into the harness:
   `createGateway({ connectors: [slack(...), telegram(...)] })`, or dynamically via
   `gateway.connectors.register(spec)`.
3. **The ingress hop joins the op spine.** `inbound` and `deliver` become commands
   (`connectors:inbound`, `connectors:deliver`): journaled operations with phase contract, spans,
   bus envelopes — and the gateway's interceptor cascade, inherited live through the construction
   tree (ADR 83 §4). Rate limits, allowlists, dedupe become adopter `guard()`/`use()` middleware,
   which is why they are deliberately not spec surface.
4. **`ConnectorContext` gains the tool-handler facets** — `log`/`trace`/`metrics` (Observability)
   and `run` (Ops) — minted by the harness from real operation context instead of being a bag of
   bare closures.
5. **Deleted:** the `GatewayBridges.connectors` slot, `ConnectorsBridge`, the `connectors(gateway)`
   accessor, and the never-shipped `withConnectors()`. Next-lane only; break clean, no shim.
6. **Gateway-only.** App-level mounting is explicitly deferred; the spec-level protocol keeps that
   door open without paying for it now.

## Context

### What exists (post-rewrite, `1.0.0-next.161`)

`defineConnector` produces a `GatewayExtension`. `install(installer)` wires source → session
through the ADR 100 `as()` door, maintains a `managedSessions` set, subscribes the bus for
turn-completion delivery, and self-registers a handle into a `ConnectorsBridge` facade living at
`gateway.bridges.connectors` (first connector to install creates the bridge — a quiet ordering
wart). Everything **session-side** of the seam is fully on the op spine: `as()` runs the real wire
seam (authorizer, `onBeforeWire*`, ADR-48 principal stamp) and `createSession`/`send`/`runOnce` are
journaled commands with spans.

### The gap: the ingress hop itself is dark

The connector's own work — routing an external event, resolving the door, the `deliver` send — runs
outside any operation context. Side by side:

| Capability                   | `ToolHandlerCtx` (ADR 43/64/78/91) | `ConnectorContext` today        |
| ---------------------------- | ---------------------------------- | ------------------------------- |
| Runtime context (op coords)  | ✅ `RuntimeContext` trunk          | ❌ none                         |
| `log` / `trace` / `metrics`  | ✅ Observability facet             | ❌ none                         |
| `run` (journaled ad-hoc op)  | ✅ Ops facet                       | ❌ none                         |
| Spans / journal on the hop   | ✅ command machinery               | ❌ raw closures                 |
| Interceptor cascade          | ✅ (dispatch is a command)         | ❌ unreachable                  |
| Trace stitches source → turn | ✅                                 | ❌ correlation dies at the edge |

`status()` is a diagnostics enum, not telemetry. Failures in `deliver` are whatever the adopter's
closure does with them.

### Why the built-in beats the extension route

**Correction over the design conversation:** the extension route is not structurally impossible —
`GatewayInstaller` DOES forward `substrate` and the interceptor snapshot
(`inheritedInterceptors` + `interceptorParent`, the ADR 93 "cascade is total at every host tier"
landmine-11 fix), so a sufficiently careful extension could construct a harness with both the audit
trail and the policy seam. The built-in wins on ownership and shape, not on possibility:

1. **One construction owner.** Self-registration had a real ordering wart (first connector to
   install creates the bridge); an extension-built harness would inherit it. The gateway
   constructing its own child at a fixed point in its constructor deletes the whole class of
   ordering questions.
2. **Lifecycle is the gateway's to pin.** Start-at-`listen()` / stop-first-at-`close()` is a
   gateway-lifecycle decision. An extension installs at construction and learns about `listen` only
   indirectly; the owner of `listenBody`/`closeBody` places those calls exactly.
3. **The first-class idiom.** A `connectors:` option (ADR 42 slot) + a `gateway.connectors` field
   with a spec protocol is how every other built-in reads. Extension + bridge + accessor is three
   pieces of ceremony for the same thing, reachable only through `gateway.bridges`.
4. **The ctx facets need the harness anyway.** `log`/`trace`/`metrics`/`run` on
   `ConnectorContext` are minted from a live harness's operation machinery
   (`defineOperationFacets`); once the machinery is a harness, the gateway constructing it is the
   smallest correct shape.

### Built-ins are not third parties (the ADR 50 amendment)

ADR 50's "no bare `gateway.<name>`" rule protects the gateway's surface from **third-party**
colonization — that is what the bridges namespace is for, and it stays. It was never a rule against
the framework's own nouns: `session.knobs`, `session.state`, `session.tasks`, `session.elicitation`
are first-class fields with spec protocols, and the session package takes **direct dependencies** on
nine built-in packages it constructs as children. Built-in-as-direct-dep-child is the established
pattern.

Connectors are ingress. Ingress is to the gateway what tools are to the session — peers of
`transports:`/`wireExtensions:`, not add-ons. They earn built-in status; `gateway.connectors` is
the framework claiming its own noun, not an extension claiming one.

## Decision

### 1. `ConnectorsHarness`, constructed by the gateway

```ts
// gateway/harness.ts (constructor)
this.connectors = new ConnectorsHarness(this.journal, this.bus, this.inbox, {
  gateway: installerHostSelf, // apps(), as(), metadata — the existing host shape
  parentScope: { gatewayId: this.scopeId },
});
```

Substrate flows parent → child positionally (ADR 31), so connector ops land in the gateway's
journal and surface on `gateway.events(...)`; interceptors registered on the gateway cascade in
live (ADR 83 §4). The harness is **always present** — an empty one is a map and a command table —
so `gateway.connectors` needs no existence checks. Kind string: `"connectors"` (the collection is
the harness; individual connectors are entries, exactly as tools are entries in the ToolExecutor —
they are NOT harnesses).

Protocol: `spec/protocol/connectors-harness.ts` (`ConnectorsHarnessProtocol`). Data shapes
(`ConnectorSpec`, `InboundMessage`, `OutboundDelivery`, `StreamingTurn`, `ConnectorStatus`) move to
`spec/data/connector.ts` — closures in spec data has exact precedent in
`spec/data/tool-handler.ts`.

### 2. Commands and reads

Declared with the base `this.command({...})` grammar:

| Surface                 | Kind    | Exposure | Notes                                                       |
| ----------------------- | ------- | -------- | ----------------------------------------------------------- |
| `connectors:register`   | command | local    | Validate + store handle; if gateway is listening, start it. |
| `connectors:unregister` | command | local    | Stop + teardown + remove.                                   |
| `connectors:start`      | command | local    | Per-connector `spec.start(ctx)`; failures journaled.        |
| `connectors:stop`       | command | local    | Teardown, `useEffect`-style.                                |
| `connectors:inbound`    | command | local    | The routing hop — see below.                                |
| `connectors:deliver`    | command | local    | Wraps `spec.deliver` / per-event `deliver` reply-to.        |
| `get(name)` / `list()`  | read    | —        | Map lookups. Not operations. No `search()` — YAGNI.         |
| `status(name)`          | read    | —        | Last reported `ConnectorStatus` + error.                    |

`connectors:inbound` body = today's `resolveDoor` path verbatim: normalize messages
(string → one user message; per-message `source` stamp), open `gateway.as(identity)` when the event
carries one, `createSession`-or-resume vs `runOnce` (ephemeral), dispatch the send. The session op
receives the inbound op's span context via the ADR 78 explicit-propagation channel
(`spanContext` beside `parentOpId` on the op scope) — **the trace finally stitches
webhook → turn → delivery.** `spanAttributes` override stamps `<ns>.connector.name` per ADR 78's
"harness owns identity" rule.

Phase envelopes come free from the operation runner (`connectors:command:inbound` etc., matching
`session:command:close` naming). `status()` reports ride the light path (`emit`) as
`connector:status`.

### 3. `createGateway({ connectors })`

The slot follows the ADR 42 trichotomy — shorthand first, the other two cases for completeness:

```ts
export interface GatewayHarnessOptions {
  // ...
  /**
   * ADR 42 slot: Decl[] shorthand (the advertised form) | Config | Instance.
   * Specs register at construction and start at listen().
   */
  readonly connectors?:
    | readonly ConnectorSpec[] // shorthand — the dominant collection
    | ConnectorsConfig // { connectors: [...], ...future shared knobs }
    | Connectors; // pre-built instance (noun alias, ADR 42 §3 — never "Harness")
}
```

There is **no `withConnectors()` and no `defineConnectors()`**. ADR 42 §6 defines `withX(...)` as
the slot trichotomy in extension clothing — the form a capability wears when it has no first-class
option. Connectors now have one, so the extension form would be a second door to the same room.
`defineConnector()` (singular) remains the only definition function: one spec per connector, per
the one-`define`-per-thing convention (ADR 36); the plural is just an array literal.

Lifecycle pins to the gateway's own: **register at construction, start at `listen()`, stop first at
`close()`** — ingress opens when the gateway opens and shuts before apps drain, so shutdown never
races new inbounds against closing sessions. This is a deliberate behavior change from today
(extensions start at install, i.e. potentially before `listen()`); called out in Migration.

Package layout: `@agentick/connector` keeps the harness implementation, `defineConnector`
(validation/branding sugar over a raw spec literal — both are accepted by `connectors:`),
`textStream`, and `connectorProbe`. The gateway package takes a **direct dependency** on
`@agentick/connector` — the same relationship session has to `@agentick/knobs`. Dependency
direction stays acyclic: `gateway → connector → spec`.

### 4. `ConnectorContext` v2

Keeps `inbound` / `writable` / `confirmed` / `status` / `gateway` unchanged in shape. `inbound()`
now dispatches the `connectors:inbound` command instead of running a bare closure. Added, matching
`ToolHandlerCtx`:

- `log` / `trace` / `metrics` — the Observability facet (no-ops when telemetry is off);
- `run` — the Ops facet's ad-hoc journaled operation, for connector-internal work that deserves an
  audit line (a bindings write, a claim-check fetch).

`ephemeral`, `stream`, `confirm`, `deliver`, per-event `deliver` reply-to, and the streaming
surfaces (`StreamingTurn`, `textStream`, `ctx.writable`) are **unchanged** — this ADR moves the
machinery under them, not the API over them.

### 5. Policy is middleware, not spec surface (closing the `senderId` loop)

The connector rewrite deliberately cut `senderId`/allowlist from the API on the grounds that sender
gating is adopter policy. This ADR supplies the principled home that cut was pointing at:

```ts
gateway.guard((op) => {
  if (op.name !== "connectors:inbound") return "allow";
  const { connector, message } = op.input as ConnectorsInboundInput;
  return allowlist.permits(connector, message.identity) ? "allow" : "veto";
});
```

Rate limiting, dedup, and quota are `use()` middleware on the same seam. No spec field will be
added for any of these.

### 6. What dies

- `GatewayBridges.connectors` module augmentation, `ConnectorsBridge`, `connectors(gateway)`.
- `defineConnector`-returns-`GatewayExtension` (and its first-installer-creates-the-bridge
  ordering wart).
- `withConnectors()` — never shipped; the `connectors:` option is the API.

### 7. Explicitly deferred

- **App-level mounting.** Three reasons to hold at gateway: connectors are transport-shaped
  (authorizer, `as()`, multi-app routing, session index are gateway vocabulary); two mount points
  cost two ctx variants + lifecycle orderings + an ownership ambiguity from day one; the
  gateway-less case has a cheap answer (a one-app `createGateway`). The protocol being spec-level
  and specs targeting apps by id keeps the app mount additive if a real adopter demands it.
- **Cluster.** Connectors remain per-process ingress; singleton election stays the cluster
  protocol's job (ADR 50 stance unchanged). The `connectors:inbound` op's idempotency key is the
  natural dedupe seam for multi-node sources when that work lands.
- **Cross-node delivery.** `managedSessions` is in-memory; delivery for turns driven from another
  node is out of scope here.

## Migration

Next-lane only; we are the only adopter. Clean break:

- `createGateway({ extensions: [smsConnector(deps)] })` →
  `createGateway({ connectors: [smsConnector(deps)] })`.
- Adopter connector factories (`slack(...)`, knowify's `smsConnector`/`emailClassifierConnector`)
  keep their signatures — they return specs instead of extensions, which for a
  `defineConnector`-wrapped factory is a re-export-level change.
- Behavior change to verify in adopter tests: sources start at `listen()`, not install.

## Open questions

1. Per-connector eager-start knob (start before `listen()` for purely in-process sources)? Leaning
   no until a case appears — `listen()` is cheap to call early.
2. Should the confirmation flow (`spec.confirm` / `ctx.confirmed`) become a command pair too, or
   stay on the elicitation event subscription? Leaning command-ize `confirmed` (it mutates
   in-flight state) in a follow-up, not this slice.
3. `unregister` semantics with turns in flight: veto, drain, or abandon? Proposal: stop the source
   immediately, let in-flight `connectors:inbound` ops complete, drop delivery routes on
   completion.
