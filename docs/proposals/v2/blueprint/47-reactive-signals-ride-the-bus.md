# ADR 47 — Server→client reactive signals ride the bus; `gateway.notify` is ripped out

**Status:** Proposed
**Date:** 2026-07-01
**Supersedes:** the `gateway.notify` / `acceptConnection` / `ClientConnection` surface introduced in #311 + #311.1
**Related:** ADR 29 (bus overhaul — cursor log), ADR 45 (structural identity), ADR 46 (wire extensions), #279 (MCP connection status), #308 (dynamic wire extensions), #309/#310 (MCP list_changed), #313/#314 (notify replay — dissolved by this ADR)

---

## TL;DR

`gateway.notify()` is the only server→client change-fan-out in the framework that (a) reinvents a fan-out mechanism instead of using the bus or `@agentick/pubsub`, and (b) isolates by **runtime filter** (`to: (meta) => boolean`) instead of **by instance**. Every other reactive signal path in the codebase uses one of the two foundational primitives, and every other isolation boundary (app, session, MCP connection, credential namespace, outbound principal) is **per-instance / structural**, per ADR 45.

**Decision:** server→client reactive signals are modeled as `ProtocolEvent`s on the bus and delivered over the existing `sub/subscribe` wire extension. The gateway gets an `emitCapabilitiesChanged()` seam (bus append) now; the client's _unconditional, client-owned_ self-maintenance of `client.capabilities` is deferred to #308 (the trigger event can't fire until dynamic extensions exist). `gateway.notify` / `acceptConnection` / `ClientConnection` / `ClientConnectionMetadata` / `onDeliveryError` / the per-transport sink registration / `serverNotifier` are **deleted**. Multi-tenant and principal isolation are per-instance child buses — the composition that already isolates app and session substrate — not a `notify({to})` predicate.

This is not a shrink. It is a total removal. The residual "per-connection control frame" case that motivated keeping a slimmed `notify` **does not exist**: every application signal we can name is scope-expressible (auth notifications already carry `affectedSessions`), and the remaining per-socket concerns (WS close, heartbeat, `notifications/cancelled`) are transport-layer, never `notify`'s job.

---

## Context — what's actually in the tree

### Two foundational fan-out primitives, used consistently

1. **`LocalEventBus`** (`runtime-next/substrate/local-event-bus.ts`) — a cursor log (ring buffer + per-subscriber cursor pull), scoped by `EventScope`, replayable with `CursorEvictedError` on retention overrun, lazily fanned via a surface index, journal- and wire-projectable. The domain-event substrate. Its defining composition (doc comment, `local-event-bus.ts:50`): **"Fan-in writes, isolated reads. Tenant-scoped composition."**

2. **`@agentick/pubsub`** — `createNotifier` (one topic), `createKeyedNotifier`, `createLocalPubSub`. Synchronous, local, no replay, no scope. The "my harness state changed, tell in-process subscribers" primitive.

Harnesses use them **without divergence**:

- `credentials/src/harness.ts:68` — `createNotifier<CredentialsChangeEvent>()`, forwarding the store's `onChange` (`:77`)
- `tasks/src/harness.ts:235` — `createLocalPubSub<TaskEvent>()`
- knobs / skills / prompts / state / timeline — same `pubsub-next` family

### The wire already projects the bus to clients

`subscriptionsWireExtension` (`gateway/src/wire/subscriptions-extension.ts`) exposes `sub/subscribe` / `sub/unsubscribe`. It opens a cursor-aware, scope-filtered, reconnect-safe stream over the bus and fans `notifications/subscription/event` frames to the client. The client transport (`transport-next/client/base-transport.ts`) already tracks `lastCursor` per subscription and resubscribes on reconnect. `sub` is registered **first** in gateway construction (`gateway/src/harness.ts:241-247`), so it is guaranteed present on every real gateway — no capability-discovery chicken-and-egg.

**A cursor-replayable, scope-isolated, reconnect-safe server→client channel already exists and is already tested.**

### Where #311 diverged

`gateway.notify` / `connectedClients` (`gateway/src/harness.ts:177,314`):

```ts
private readonly connectedClients = new Map<string, ClientConnection>();

notify(notification, options?) {
  const to = options?.to;
  for (const [id, conn] of this.connectedClients) {
    if (to && !to(conn.metadata)) continue;   // ← runtime-filter isolation
    conn.deliver(notification);
  }
}
```

This is a **third** fan-out mechanism — neither the bus nor `pubsub-next` — and a **flat global registry with a runtime filter**. Runtime-filter isolation is the confused-deputy shape ADR 45's per-instance rule exists to eliminate: correctness depends on "remember to write the right predicate at every call site." A capability change in a multi-tenant deployment reaches every tenant unless the predicate is present and correct. That is the exact landmine flagged in the #311 retro.

A second, minor divergence: `ToolCatalog.subscribeAll` (`tool/src/catalog.ts:110`) hand-rolls `new Set<() => void>()` with its own snapshot-on-fire safety — a reimplementation of `createNotifier`. Cosmetic, but the same "reinvented a foundational bit" pattern.

### Why this matters for the concern that started the thread

Multi-tenant isolation felt like unbuilt infrastructure with significant edge cases. It is not. **A multi-tenant bus is one child-bus instance per tenant** — the same `LocalEventBus.factory({ parent })` composition (`local-event-bus.ts:256`) that already gives every App a child bus wrapping the gateway's, and every Session a child wrapping its App's. Tenant A's events fan **up** to the gateway (global telemetry / cluster) but tenant A's subscribers read **only** A's ring buffer. Tenant B is a sibling instance. They cannot observe each other because they are different ring buffers — isolation by construction, identical to how sessions are already isolated. Tested, shipped, boring.

"Principal" is the same move. Per-principal MCP `serverId` (`linear:user-42`), per-principal credential namespace (`mcp:linear:user-42`), and a per-principal child bus are **one pattern**: identity in the instance, isolation by construction (ADR 45). `notify({to: principal})` was the single place that reached for runtime-filter isolation instead — which is precisely why it read as divergent slop.

---

## Decision

1. **Model server→client reactive signals as `ProtocolEvent`s on the bus.** Capability changes get a control-plane surface (proposed: `surface: "gateway"`, name `gateway:capabilities:changed`, `phase: "terminal"`, no `opId`). Future signals (MCP connection status #279, dynamic-extension install/uninstall #308, any Agentick-wire list-changed) get their own surfaces/scopes the same way.

2. **Deliver them over `sub/subscribe`.** No new wire mechanism.

3. **The client self-maintains its capability snapshot — and this is deferred to #308.** Keeping `client.capabilities` fresh is the **client's own** concern (the client and framework machinery read it — `hasMethod`, feature-gating, routing), so the maintenance must be **unconditional** when connected: the client opens a gateway-scope control-plane subscription for _its own_ correctness, **not** gated on whether an adopter registered an `onCapabilitiesChange` listener. `onCapabilitiesChange` is an observation layer _on top_ of the fresh snapshot, never the _trigger_ for freshness.

   **Timing:** the wire-extension registry is **sealed at gateway construction** (`gateway/harness.ts` — `this._wireExtensions.seal()`), so `gateway:capabilities:changed` **cannot fire until #308** (dynamic wire extensions). Building the client's unconditional self-maintenance now would be inert machinery reacting to an impossible event, and would add a `sub/subscribe` to every `connect()` (forcing every stub-server test double to model it). So: **the principle is settled here (unconditional, client-owned, not adopter-gated); the implementation lands in #308**, where the trigger event exists and a real consumer shapes it. Today the client's snapshot is refreshed on handshake / reconnect (real events), which `onCapabilitiesChange` already reflects.

   **Rejected alternative — lazy, adopter-callback-gated subscription.** An earlier iteration opened the subscription only when an `onCapabilitiesChange` listener existed. That is **wrong**: it couples the client's own capability-freshness to whether the adopter happened to care, so `hasMethod` could silently go stale for a non-listening adopter. Capability-freshness is not an adopter-opt-in feature; it is the client's baseline correctness.

4. **Delete the bespoke surface entirely:**
   - `gateway`: `acceptConnection`, `notify`, `connectedClients`, `onDeliveryError`, `nextClientNumber`
   - `spec`: `ClientConnection`, `ClientConnectionMetadata`, the protocol-method declarations
   - transports: sink registration in `transport-websocket`, `transport-unix-socket`, and the `serverNotifier` option + `AcceptingServer` / `InProcessServerNotifier*` in `transport-in-process`
   - the `notifications/capabilities/changed` bare-notification declaration (replaced by the bus event + subscription frame)

5. **Fix the minor divergence:** `ToolCatalog.subscribeAll` uses `createNotifier` instead of a hand-rolled `Set`.

6. **Multi-tenant and principal isolation are per-instance child substrate**, never a `notify` filter. A tenant is a child bus (and child app/journal/inbox as needed). A principal is an instance identity (harness, credential namespace, and — where events are principal-private — a child bus). No principal/tenant field is added to `EventScope`; isolation is by instance, matching every other boundary in the framework.

---

## Why this is the right move (not just the tidy one)

- **It deletes net-new surface, it does not add machinery.** #311 + #311.1 added ~200 lines across gateway + 3 transports + spec for a fan-out the framework already had twice over. The bus/subscription path is _reuse of the mechanism already running for every other server event_. The simplicity argument favors removal: fewer mechanisms, all routed through the primitive already trusted and tested.
- **Isolation becomes structural.** The multi-tenant leak stops being "checked" and becomes "impossible" — the wrong events never enter the tenant's ring. This is the ADR 45 stance applied to eventing, consistent with app/session/MCP/credential isolation.
- **Three open problems dissolve.** #313 (HTTP replay) and #314 (cursor-tracked notify) are asking for cursor/replay/eviction the bus already implements; both close. The multi-tenant `notify({to})` landmine closes.
- **It is maximal dogfooding**, which was the stated goal of the #311 wire-extensions arc: framework control-plane signals travel the same wire, the same way, as adopter signals.

**Confidence: high.** This is read off the instantiation sites (`local-event-bus.ts:256`, app/session factory threading), the primitive-usage grep (credentials/tasks/knobs/…), the scope-expressibility of every named signal (auth's `affectedSessions`), and the guaranteed presence of `sub` (`harness.ts:241`). It is not extrapolation.

---

## Consequences

### Dissolved

- **#313** (HTTP transport notification sink) — closed. HTTP's subscription channel already needs cursor / `Last-Event-ID` handling; control-plane events ride that, not a parallel buffer.
- **#314** (cursor-tracked notify across transports) — closed. That is the bus.
- The multi-tenant `notify` cross-tenant leak — closed by construction.

### New / changed

- `gateway` gains `emitCapabilitiesChanged()` — a bus append on `surface: "gateway"`. The client's unconditional self-maintenance that _consumes_ it is deferred to #308 (see Decision §3).
- A control-plane event surface + naming convention must be defined in spec (`gateway:capabilities:changed`, and the pattern for #279/#308 to follow).
- `#302` (auth wire extension) no longer needs a `notify` auth filter; principal-private events are delivered on a per-principal-scoped subscription, isolation by instance.

### Migration

No backwards-compat shims (per project philosophy). The wire method `notifications/capabilities/changed` is removed and replaced by the subscription-delivered bus event. Other-language SDKs (Go/Python) implement the subscription path they already need for every other event; there is no separate capability-notification code path for them to maintain — a net reduction in the cross-SDK surface.

---

## Alternatives considered

**A. Keep `notify` for "per-connection control frames."** Rejected: no such frame exists in the application layer. Auth notifications are session-scoped (`affectedSessions`); `notifications/cancelled` is request-correlated and handled by the transport `inFlight` registry; WS close / heartbeat are transport-layer. If a genuinely-per-connection, non-scope-expressible application signal ever emerges, a minimal per-connection push is re-added **then**, with a concrete consumer — the same "don't build ahead of demand" discipline that (correctly) deferred the `ClientConnectionMetadata` empty-seed. Speculatively retaining `notify` for a case that does not exist is the over-engineering.

**B. Model connection-id as an `EventScopeExtensions` dimension** so even per-socket frames ride the bus. Rejected for now: stretches `EventScope` toward transport identity for no current consumer. Available later if Alternative-A's hypothetical materializes.

**C. Keep `notify` and layer replay onto it (#314).** Rejected: reimplements the bus's cursor log on a flat registry. Strictly worse than reusing the bus.

---

## Risks & open questions

- **The client's unconditional self-maintenance (deferred to #308) is the one genuinely-new behavior.** When built, it must be unconditional (client-owned), not adopter-callback-gated (see Decision §3, rejected alternative). Risk at that point: a client that fails to establish the subscription silently misses capability updates — mitigated by making it framework-managed inside `connect()` and observable via `whenReady()`. **Confidence low-risk: high** — composition of the already-proven subscription + reconnect-resume primitives.
- **Surface/scope taxonomy for control-plane events** needs a deliberate choice (one `gateway` surface with control-plane phases, vs. a dedicated `control` surface). Minor spec work; decide in the implementing slice.
- **`EventScope` has no tenant/principal field today** (it has app/session/execution/gateway/node + `EventScopeExtensions`). Per-tenant isolation therefore comes from **child-bus instances**, not a scope predicate. Confirmed sufficient for isolation; a tenant/principal scope _field_ is only needed if we later want same-bus multiplexing, which this ADR explicitly avoids in favor of per-instance composition.
- **One thing to verify in the implementing slice:** that no current bus subscriber assumes a single flat gateway-global bus. The app/session factory threading says the child-bus tree is already the norm, so this is expected-clean, but it is the migration's one checkpoint.

---

## Rollout

**Recommendation: do the rip-out now, as a dedicated slice, before `notify` accretes a second consumer.** `notify` is one commit old with exactly one caller (capabilities-changed). It is the cheapest it will ever be to remove, and every day it stays as a public gateway method it invites more callers — which would turn a clean deletion into a multi-consumer migration. This aligns with the project's "make breaking changes freely before users depend on it" window and with "lift heavy things — ship the right design, not the expedient green one."

Slice shape:

1. Define the control-plane event surface + naming in `spec-next`.
2. Gateway publishes `gateway:capabilities:changed` on the bus instead of `notify()`.
3. (#308) `client-next` opens the unconditional gateway-scope control-plane subscription in `connect()` + reconnect path; route its events into the existing refetch/apply. Deferred until the trigger event can fire.
4. Delete `notify` / `acceptConnection` / `ClientConnection` / transport sink registration / `serverNotifier`.
5. `ToolCatalog.subscribeAll` → `createNotifier`.
6. Port the #311 E2E test to drive capability change through `bus.append` → subscription → client refetch. Its assertions (`onCapabilitiesChange` fires, snapshot re-syncs, multi-client fan-out, isolation) carry over unchanged; only the trigger swaps.

**#279 (MCP connection status) then lands on this foundation** as consumer two — it is the natural proof that the control-plane-event pattern generalizes beyond capabilities, and it needs exactly this (status projection over the wire with replay, material staying server-side).
