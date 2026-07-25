# ADR 48 — Layered isolation: scope keys, per-scope harnesses, shared resources

**Status:** Accepted (model settled; implementation phased)
**Date:** 2026-07-01
**Related:** ADR 29 (bus cursor log), ADR 31 (harness hierarchy / composable substrate), ADR 45 (structural identity), ADR 47 (signals ride the bus), ADR 35 (cluster tiers), #302 (authWireExtension), #283 (gateway `withCredentials` cascade), #289 (per-principal construction), #292 (task lifetime), #152 (per-principal connection pool)

---

## TL;DR

A "multi-tenant distributed durable gateway" needs **no tenancy subsystem, no `Principal` class, no snapshot/migration protocol, no universal `Store` supertype.** It is the composition of primitives that already exist:

- **Isolation = composition.** A per-scope harness instance (child bus / child journal / namespace-keyed store) isolates by construction. Bus/journal fan writes **up** to parents (global observability) while keeping reads **isolated** downward. Verified to hold across cluster replicas.
- **Harness instance ≠ backing resource.** The harness is per-scope and cheap (an object + a scope key). The expensive backing resource (Pg pool, Redis client, socket) is shared/global and *injected*. A per-session harness is a scoped **view** over a shared adapter, isolated by a key — never a per-session connection.
- **A principal is a scope key.** The identity axis (`tenant → user`) is a hierarchical scope key of the same shape as the work axis (`gateway → app → session`). It is derived by an **auth projection function** (identically shaped to `ClusterPartitioning.keyFor`), fixed in scope at construction (ADR 45), and threaded like `sessionId`. Authentication *is* producing this key.
- **Scope is chosen by what the state IS**, not a blanket rule: work/execution → **session**; identity/auth → **principal**; physical resource → **global**.
- **Migration = durable store adapter.** Put the source of truth in an external durable adapter and node failover is "re-point + read." Snapshot/restore is only for in-memory-source-of-truth; live mid-execution resumes via journal replay + idempotency, not fiber snapshot.

The framework already has the mechanisms (substrate factories, namespace-keyed stores, `EventScope` + `EventScopeExtensions`, structural identity). The gap is **convention + wiring + two durable adapters + the auth boundary**, not new architecture.

---

## Context

The stated goal is a fully-functional multi-tenant, distributed, durable gateway cluster. The obvious-but-wrong path is to build a tenancy subsystem: a `Tenant` type, a `Principal` class with a registry, `tenantId` hardcoded into core types, a snapshot/restore migration protocol, a universal `Store<T>`. Every one of those is over-engineering — a "worldview" layered on top of systems that already express the need more simply.

Two facts, both verified in-tree this session, collapse most of that work:

1. **`LocalEventBus` fan-in / isolated-reads composes, and it composes across replicas.** A per-session child bus wrapping its node's (cluster-wrapped) bus: session events fan up and reach a gateway-scope observer on *another* replica, while a sibling session on the same node never observes them. Isolation is physical (separate ring buffers), not filter-based, so clustering cannot leak it. (`packages/cluster/src/__tests__/composition-across-replicas.spec.ts`, `packages/runtime/src/__tests__/local-event-bus.spec.ts`.)

2. **Stores are namespace-keyed pluggable adapters.** `CredentialsStore` is `(namespace, key) → value` with a `backend` id, conformance suite, in-memory reference adapter, optional reactivity. `OperationJournal`, `SandboxRuntime`, `ClusterTransport` follow the same pattern. Namespacing *is* the isolation mechanism.

So the design question is not "how do we build multi-tenancy" — it's "how do we compose what exists, and where does each thing's isolation boundary sit."

---

## Decision

### 1. Two scope axes, both hierarchical scope keys on `EventScope`

```
Work path      (execution):  gateway → app → session      (already in EventScope)
Identity path  (who):        tenant  → user               (EventScope.principal, stamped by BaseHarness)
```

Both are hierarchical keys. Both **fan in / resolve up**. The work path already exists (`EventScope.appId / sessionId / gatewayId / nodeId`). The identity path is the *same shape at a different key*.

**`principal` is a core `EventScope` field, not an augmentation-seam entry** (refined during implementation — see below). It graduated to core because it became **foundational on `BaseHarness`**: the base class carries it as construction identity and stamps it onto events, so `spec-next` is no longer agnostic about it — it's a first-class framework identity dimension, alongside `sessionId`/`gatewayId`.

```ts
// spec-next/data/events.ts — core EventScope
interface EventScope extends EventScopeExtensions {
  // ...work-path dimensions...
  readonly principal?: string; // identity axis; stamped by BaseHarness
}

// runtime-next/substrate/base-harness.ts — construction identity
class BaseHarness {
  protected readonly principal: string | undefined; // from BaseHarnessOptions.principal
  // makeEvent stamps it AUTHORITATIVELY onto every emitted event's scope
  // (an op cannot override it — no per-op identity spoofing).
}
```

**Why core, not the augmentation seam:** `principal` is the *one* identity dimension `BaseHarness` can stamp uniformly — unlike `scopeId`, whose scope field is surface-specific (session→sessionId, app→appId). Centralizing it on the base class (both `this.principal` for impls and the authoritative `makeEvent` stamp) is what prevents per-command drift and makes identity structural rather than ambient. That foundational role is what promotes it from downstream augmentation to core.

*(`EventScopeExtensions` remains the seam for genuinely harness-package-specific dimensions — `sandboxId`, `mcpConnectionId`.)*

### 2. Isolation = composition, at the scope determined by the state's nature

| State | Isolation unit | Mechanism |
|---|---|---|
| Work / execution — bus, journal, session-state, tasks (default) | **session** | child bus/journal (fan-in/isolated) or namespace = work-path |
| Identity / auth — credentials, tokens | **principal** | namespace = identity-path; **resolve up** user → tenant → global |
| Physical resource — Pg pool, Redis client, sockets | **global** | shared, injected; never scoped |

Work-scoped state fans writes up to app/gateway (global observability) while reads stay isolated. Identity-scoped stores namespace by principal and resolve up the hierarchy on read (the read-side twin of bus fan-in).

### 3. Harness instance (per-scope, cheap) vs backing resource (shared, injected)

A per-scope harness is a scoped view over a shared adapter. The Pg example:

- Gateway constructs **one** `PgCredentialsStore` (one connection pool).
- Each principal gets a per-principal `CredentialsHarness` **instance** whose `store` is that shared pool and whose namespace is the principal key.
- Isolation is the namespace; the pool is shared. **Per-scope instances, shared connections. No connection fanout.**

This is dependency injection over the existing factory pattern: `LocalEventBus.factory({parent})` already constructs a per-child instance that wraps a shared parent. A `credentialsFactory` constructs a per-principal harness wrapping a shared gateway-level store. Same move.

### 4. Principal is derived by an auth projection function; authentication *is* producing the key

The derivation is the identity analog of `ClusterPartitioning.keyFor(addr) => shardKey`: a projection from inbound context to a key.

```ts
interface AuthConfig {
  /** Project inbound auth context → the principal scope key.
   *  string           → static single-principal deploys ("local")
   *  (ctx) => string  → real auth (token → "acme/user-42")
   *  Runs once per connection / session creation; result fixed on the
   *  session's scope for its lifetime (structural identity, ADR 45). */
  principal?: string | ((ctx: AuthContext) => string | Promise<string>);
}
```

**The function lives on auth** (deriving identity from wire material is authentication, by definition). **The result lives on scope** (`EventScope.principal`, opaque downstream). These are not in tension — auth produces the key; scope carries it; stores consume it. Layering: gateway-level default, app-level override; **not** session-level (a session inherits its principal from the connection that created it).

### 5. The fusion rule: the session is where the two axes fuse

The work axis and the identity axis are orthogonal **above** the session
boundary and collapse into one **at and below** it:

- **Gateway and app are principal-plural.** One app serves every
  principal's sessions. Nothing at these scopes may bind to a principal;
  anything living here that touches identity-sensitive data partitions
  **by key** (namespace/key-strategy), never by instance.
- **Session and everything below is principal-singular.** A session
  belongs to exactly one principal for its entire life — construction-
  bound, authoritatively stamped, no per-op override. **Re-auth as a
  different user is a new session, never a mutation.** Spawned children
  inherit the parent's principal; identity flows down, never sideways,
  never re-derived per operation.

The session being the **largest work-scope that is principal-singular**
is *why* the session is the unit of work, and why per-session
instantiation of session-lifetime harnesses is correct rather than
wasteful.

**Corollary — 1:1-with-session harnesses inherit principal; they are
never independently principal-instantiated.** Timeline, state, knobs,
tasks, elicitation, loop/tool executors, reconciler mounts: all 1:1 with
their session, so they carry the session's principal via scope stamping
at zero mechanism cost. A "per-principal timeline" is a category error —
the timeline is already per-session and sessions do not span principals.

**The binding decision procedure** (two questions, three mechanisms):

```
Does the resource outlive a session?
  NO  → session-bound; principal inherited from the session. (Default.)
  YES → Does it hold live auth-bearing state (an authenticated
        connection, an OAuth'd client, a user workspace)?
        YES → per-principal INSTANCE (structural isolation).
              e.g. MCP client connections (#152), sandbox runtimes.
              Test: two sessions of the same principal may share it;
              two principals must never.
        NO  → shared instance, principal-KEYED DATA (namespace/
              key-strategy partitioning). e.g. gateway-level
              credentials (#283), user memory, user-scoped skills.
```

Scope stamping on events is the always-on third mechanism — it serves
observability and fan-in filtering, and is **never** the isolation
mechanism itself (filter-based isolation is the pattern ADR 47 killed).

**BYOK caveat.** Provider executors are normally global (physical
resource, shared SDK client). In a bring-your-own-key deployment the
provider client becomes auth-bearing and flips to per-principal
instances by the procedure above. Do not "solve" BYOK with a per-call
key lookup — that is runtime-filter isolation wearing a different hat.

**Multi-actor surfaces (connectors).** A group chat (Telegram, Slack
channel) is one conversation with multiple humans. The session's
principal is the **installation/workspace identity** — the thing that
authorized the connector — and the per-message *actor* rides
`RuntimeContextUser` / message metadata as a context dimension. It is
never the session principal; principal-per-sender would break session
principal-immutability.

**The checkout pattern is designed once.** #152 (MCP connections pooled
per-principal, sessions checking out and returning) is the template for
every principal-bound-instance resource — sandbox runtimes next, BYOK
executors after. The checkout/return contract (lease vs refcount, what
happens when a principal's last session closes) is a generic primitive,
not MCP-specific plumbing.

### 6. Migration = durable store adapter; snapshot only for in-memory

If the source of truth is an external durable adapter (Pg/Redis), node failover is: the new node constructs the same harnesses pointed at the same store + scope key, and **reads current state**. No snapshot, no migration protocol. Snapshot/restore is only for in-memory-source-of-truth (local single-node). Live mid-execution (a suspended fiber tree) resumes via **journal replay + idempotency** (the `DurableJournal` seam, `cluster/journal.ts`) or **task checkpoints**, never fiber snapshot.

This unifies two things previously treated separately: **durable execution and HA migration are the same mechanism — externalize the source of truth into a durable store adapter.**

---

## What's built vs. the gap

**Built (mechanisms):**
- Substrate factories with parent composition (bus + journal fan-in/isolated; inbox deliberately does not compose — addressing).
- `EventScope` + `EventScopeExtensions` augmentation seam.
- Namespace-keyed pluggable stores + conformance + in-memory adapters.
- Structural identity (ADR 45): scope fixed at construction, not read ambiently.
- Cluster substrate (broker/net/ws/redis, membership, partitioning, re-election) — distribution.

**Gap (convention + wiring + adapters, not architecture):**
- Per-scope-by-default wiring: store-backed harnesses install app-level today; the "per-scope instance over injected shared adapter, namespaced by session (work) / principal (identity)" convention is not yet blessed or defaulted.
- The auth boundary (#302) that runs `auth.principal` and fixes it in scope.
- Resolve-up convention in identity-scoped harnesses (~10-line hierarchy walk).
- Durable adapters: only `MemoryJournal` and in-memory credential/task stores exist. Pg/Redis adapters are the durable path against existing interfaces.
- `TaskStore` interface (designed; see below) — tasks are an in-memory `Map` today.

---

## `TaskStore` (designed, shelved until durable execution is active)

Follows the pattern (interface + `backend` + conformance + in-memory default). Domain-shaped — **not** a reused `CredentialsStore`, because durable execution needs `list({status})` (a secondary index) to answer "on restart, which tasks were in-flight?"

```ts
interface TaskStore {
  put(record: TaskRecord): Promise<void>;
  get(taskId: string): Promise<TaskRecord | undefined>;
  list(filter?: { status?: TaskStatus }): Promise<readonly TaskRecord[]>;
  delete(taskId: string): Promise<boolean>;
  readonly backend: string;
}
interface TaskRecord {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly input: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly scope?: EventScope; // isolation
}
```

A durable `TaskStore` adapter *is* durable execution and survives node failover for free (state was never in the node).

---

## Rejected alternatives

- **`Principal` class / registry / plumbing.** Principal is an opaque scope key; auth material lives in the credential store keyed by it; roles live where the Authorizer reads them. A class holds nothing that isn't handled elsewhere.
- **Universal `Store<T>` supertype to subclass.** Shapes diverge (namespaced KV vs append-log vs query-by-status); the framework reuses by composition + per-domain interfaces + adapter convention, not inheritance. No polymorphic consumer exists (three-consumers rule fails). Extract a narrow **capability** interface (e.g. a snapshot capability) only when a real consumer needs it — never a base class.
- **Snapshot-based migration as the primary path.** Dissolved: externalize the source of truth and migration is re-point + read. Snapshot is the in-memory fallback only.
- **Separate `tenantId` / `userId` / `region` fields on `EventScope`.** One `principal` key (hierarchy by convention), not N identity fields. (`principal` itself *is* a core field — it earned that by being foundational on `BaseHarness`; a proliferation of identity fields is what's rejected.)

---

## Open choices (deferred to the consumer that reveals them)

- **Flat vs structured principal key** — `"acme/user-42"` (hierarchy by splitting convention) vs `{ tenant, user }` / `string[]`. Ship `string`; let #302 + the first credential adapter decide if structure is needed. Do not model N-level hierarchy speculatively.
- **`TaskStore` exact shape** — pin when durable execution is the active goal.
- **A snapshot *capability* interface** (`{ backend; snapshot(); restore() }`) — only if/when the in-memory-migration fallback needs it; not now.

---

## Consequences

- Multi-tenant needs no new concepts — it's per-scope composition + injected shared adapters + the identity scope key.
- Durable execution and HA migration unify into "durable store adapter."
- The next work is small and empirical: prove the per-scope-instance-over-shared-adapter convention with one store-backed harness, then generalize.

---

## Rollout (smallest-first)

1. **Verify composition across replicas** — done (`composition-across-replicas.spec.ts`).
2. **Per-session child bus/journal by default** — flip isolation from opt-in to default for work-scoped substrate.
3. **Prove the store convention** — one store-backed harness (`StateHarness`) as per-scope instance over a shared adapter, namespaced by scope, fan-in preserved. Find where the wiring chafes before generalizing.
4. **`TaskStore` interface + in-memory adapter** — unlocks durable execution + migration as an adapter swap.
5. **Auth boundary (#302)** — `auth.principal` projection; fix principal in scope.
6. **Hierarchical credential resolution** (#283) + per-principal construction enforcement (#289).
7. **Durable adapters** (Pg/Redis journal + stores) + **Redis-tier conformance** (#207).
8. **Multi-tenant cluster conformance** — isolation × HA × scale × reactivity, adversarial.
