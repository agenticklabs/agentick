# Agentick v2 — Cut Plan (durability, gateway completion, v1 parity, personas)

**Status:** proposed 2026-07-01 (principal-engineer review session)
**Audience:** the implementing agent (Opus) + Ryan
**Companions:** `STATUS.md` (running log — update it after every landed step),
`IMPLEMENTATION-PLAN.md` (original phased rollout), `blueprint/` ADRs.

This plan covers the arc from today (Phase 5 in flight, ADR 46/45/48 landing)
to the v2.0 cut. It was derived from: a four-plane audit of `packages-next/`,
a mine of the full v2 build-session transcripts (796 user messages), an
inventory of v1 (`packages/`) features missing from v2, and a read of the
first production adopter (Knowify: `nx-knowify/libs/ernesto` +
`apps/assistant-api/src/v2/gateway.ts`, both on agentick v1 today).

---

## 0. How to work this plan

Non-negotiable working agreements (distilled from the build sessions —
violating these is how trust gets burned):

1. **ADR before build** for anything with a shape decision. Spec, ADR, and
   code must not drift; update all three in the same arc.
2. **Retro after every step**, even when certain it's unnecessary. Surface:
   reinvented wheels, aspirational-vs-actual code, hand-rolled things that
   should be Effect or `utils-next` primitives. Then a cleanup commit.
3. **Effect internal, Promise external.** Adopter- and implementer-facing
   surfaces (store ports, executor callbacks, tool handlers, transports) are
   Promise-shaped; Effect is the substrate and an opt-in escape hatch.
4. **Report LOC changed per phase.** Least-LOC-wins; reuse before writing.
5. **Human-in-the-loop at every gate marked ⛔ below.** Sub-agents inherit
   these rules.
6. **No `tenantId` (or any tenancy noun) baked into the framework.**
   Multi-tenancy falls out of principal + scope-key composition (ADR 45/48).
7. Terminology discipline: *MCP client* is server-side/gateway-internal;
   *agentick client* is the browser/TUI wire client. `harness` is not an
   adopter-facing noun. Model-visible framework tools use the `session_*`
   namespace.
8. Existing conventions bind: Meszaros doubles under `/testing`, conformance
   suite per protocol, README per package with "Verified by" sections,
   `TODO(phase-N)` markers at call sites, flat `withX` options, strict
   typecheck including tests, no worktrees.

**Do-not-start list** (explicitly parked by Ryan): #243 reconciler→compiler
rename, #275 `XHarness`→`X` rename, #268 README title sweep (all three are
v2.0-cut-day mechanical sweeps, done LAST); ADR 44 depless reconciler; any
ALS-first context design (ALS is v1; v2 is Effect fibers with the narrow
dual-write bridge ADR 45 specifies).

---

## 1. Grounding: who this is for

Agentick is a low-level, pluggable framework for building **agent harnesses**
— cloud or local, coding or customer-service. The design target is a
spectrum, and every primitive must serve both poles:

- **Local pole** — an openclaw/hermes-style single-user agent on one machine.
  **Local very likely still uses the gateway** (in-process or unix-socket
  transport); gateway is a primitive at both poles, not a cloud add-on.
- **Cloud pole** — a multi-tenant distributed gateway cluster (the active
  mission; ADR 48 layered isolation + principal work serves it).

**The two-pole test** is the primitive-vs-extension discriminator: a
capability both poles need is a primitive with a bundled in-memory default;
a capability one pole needs is an extension package.

Named adopters and acceptance tests:

- **Knowify/ernesto** — first production adopter. Multi-tenant SaaS, Postgres
  + Redis, stateless HTTP replicas, Socket.IO-Redis fan-out, incremental
  event-driven persistence (`V1SessionStore`), kAuth/OAuth dual-token auth,
  MCP server for external clients (Cursor/Claude/ChatGPT), custom timeline
  windowing/compaction, spawn/swarm recursion, TigerFS sandbox.
- **tentickle** — the named acceptance test: "the real test will be if we can
  completely 100% migrate tentickle to v2."
- **v2-otto / v2-otto-cluster / v2-real** — in-tree forcing-function examples.

---

## 2. State of play (verify before building)

Shipped and locked: substrate (BaseHarness five-surface contract,
MemoryJournal/LocalEventBus/LocalInbox), all eight harnesses, cluster
machinery over four wires, skills/prompts/tasks/elicitation/credentials
harnesses, MCP client + server-harness slices, wire-extension registry with
transports sharing one server dispatcher, `BaseHarness.principal` (ADR 48)
stamped authoritatively.

Open structural items this plan resolves or schedules: the durability model
(A19, E11, L7, DurableJournal), #254 gateway-extensions ADR (recurring
blocker), auth-at-the-edge (#302-shaped), v1 parity (connectors, channels,
devtools, scheduler, sandbox providers, framework adapters, TUI/CLI), the
`agentick` metapackage, structured outputs / terminal tools.

⚠️ The v1-gap inventory produced day estimates assuming v2 transports need
gateway mounting built from scratch. That is partly stale — v2 transports
share `transport/src/server/dispatch.ts` (the ingress edge where the
per-request context is built). Note: `gateway.acceptConnection` was
**removed in ADR 47** — there is no gateway connection registry; ingress
is transport-layer. **First task of Workstream C: re-verify each gap against
packages-next reality before scoping.**

---

## 3. Workstream A — Durability: "Stores, not snapshots" (ADR 49)

**This is the highest-leverage open decision.** Ryan's own late-session
words: *"snapshots make sense unless the data/state is already persisted
elsewhere (Pg/other db) and that is the source of truth."* The first
adopter already runs the answer in production: `V1SessionStore` is an
incremental write-behind projection (session events → Postgres rows), and
resume = load rows + rebuild. No snapshot is ever taken. The local pole
wants the same shape with a JSONL transcript file.

### A1. Write ADR 49 ⛔ (review with Ryan before implementation)

Contents:

- **State-class taxonomy** (adopter-facing vocabulary; each harness README
  must declare its class):
  - **Class A — authoritative:** timeline entries (and per-harness stores
    that already exist: credentials, skills/prompts catalogs). Durable via a
    **store port** per harness — the `CredentialsStore` pattern generalized:
    harness wraps a Promise-shaped store interface; bundled default is
    in-memory; adopters inject durable implementations. Store ports ship
    enumeration (`keys`/`list`) per the enumeration-is-foundational rule.
  - **Class B — re-derivable:** sections, compiled context, tool registry,
    knob descriptors, formatter bindings. Persisted by nothing; recovered by
    **re-render**. Name the property: *the JSX tree is the schema; render is
    the recovery path.* (Tools are "compiled per tick," already ratified.)
  - **Class C — ephemeral:** dataCache (re-fetches by contract), in-flight
    ops, state-harness K/V (gets a trivial KV store port for adopters who
    want it), task progress (survives via its own store port or is declared
    lost-on-restart — decide per ADR, see #292).
- **Journal reclassified** as observability + idempotency ledger, NOT a
  recovery log. Compaction may be lossy. L7 (idempotency-key growth) becomes
  a TTL/LRU fix and should land in the same arc. `DurableJournal` remains
  the cluster rung-(d) seam for v2.x durable execution — unchanged, still
  deferred.
- **Write policy:** default **write-behind with an execution-end flush
  barrier** (crash mid-execution loses at most the in-flight turn — matches
  both Knowify behavior and local-agent expectations); **write-through**
  available per store. The resume invariant: any process that loads the
  stores sees every completed execution.
- **Snapshot demoted, not deleted:** residual roles are (a) opt-in
  hibernation of Class C, (b) warm-transfer optimization for cluster
  hand-off. It leaves the durability critical path. `SnapshotCapable`
  machinery stays as-is.
- **Session resume flow:** `app.getSession(id)` gains open-or-rehydrate
  semantics — load store-backed harness state, mount element, re-render.
  Cold resume must work on any node (this is the cluster failover story —
  see Workstream B).
- **Dissolutions:** A19 dissolves (no monolithic `PersistenceBackend`;
  per-harness store ports); E11 narrows to Class-A wire-shape versioning
  (Class B migrates by redeploy + re-render).

### A2. `TimelineStore` port (flagship)

- Port interface in the timeline package (spec observation types in
  spec-next if they cross the wire): `load(sessionId)`, `append(entry)`,
  enumeration, plus whatever the two-tier design needs for the persisted
  tier. In-memory default implements it. Conformance suite
  (`runTimelineStoreConformance`) so adopter stores are certifiable.
- **Two reference adapters, one per pole** (small, proves the port):
  - `timeline-fs` flavor: JSONL transcript file (local agents; human-greppable).
  - `timeline-postgres` (or sqlite first if faster to conformance): the
    Knowify-shaped row-per-entry adapter. Naming per convention:
    `<role>-<discriminator>-next`.
- Wire the flush barrier into loop-executor/session (execution-end hook).
- Then: **`ProjectionStrategy` seam** on the projection tier — pure function
  `(persisted entries, budget, prior projection) → projection` — plus an
  exported helpers module (`truncateEdges`, `summarizeBlock`-class helpers
  ernesto had to fork v1 timeline to get). This turns ernesto's
  sliding-window + rolling-summary compaction into configuration over
  primitives.

### A3. State KV store port + tasks lifetime decision

- `state-next` gets the same treatment (tiny KV port).
- Resolve #292 (TasksHarness lifetime/app-level daemon) in ADR 49's Class-C
  terms.

**Acceptance for Workstream A:** kill a process mid-conversation in an
integration test; resume on a "different node" (fresh app instance over the
same store); the session continues with every completed execution intact.
One test per pole (fs store, pg/sqlite store).

---

## 4. Workstream B — Gateway completion + the distributed multi-tenant cluster mission

This is the **active sprint** ("fully functional multi-tenant distributed
gateway cluster"). Order matters; #254 is the recurring blocker.

### B1. #254 — Gateway extensions ADR ⛔ (design first, it unblocks the queue)

The formal `GatewayExtension` protocol: how packages contribute
gateway-scoped harnesses/plugins (MCP server mode B, credentials at gateway
level #283, connectors — see C1). Decide the relationship to wire
extensions (ADR 46) and the composite `withX → { session?, app?, gateway?,
wire? }` factories (#297). Not all gateway extensions are harnesses — the
ADR should say which shapes exist and when to use each (extend ADR 32's
spectrum rather than inventing a new taxonomy).

### B2. Auth at the edge (the #302 shape)

Token → principal at **transport ingress** (ADR 50's `interceptIngress`
seam, a gateway extension; NOT the removed `acceptConnection`): pluggable
auth handler, per-transport token extraction already normalized, producing
`principal` + `RuntimeContextUser` onto the runtime context; cascades into
session construction per ADR 45/48 structural identity (enrichment at the
boundary — never a runtime authorization filter, which is the `notify({to})`
pattern ADR 47 killed). Knowify's dual-token plugin (kAuth HS256 + OAuth
RS256 + hydration + cache) is the reference adapter — port its *pattern*,
not its Knowify specifics. "Full-featured for standard and modern auth
requirements" is the bar. Framework never trusts `ctx.user` for
authorization.

### B3. Wire-extension completion train

In dependency order: #297 composite factories → #298 `mcpControlWireExtension`
(closes #279, unblocks #277d React `useMcpClients`) → #299 conformance
helper → #313 HTTP transport sink (buffered-until-SSE) → #308 dynamic
capability add/remove reactivity. Plus client projections for
tasks/credentials/elicitation with **enumerate RPC + added/removed topology
notifications** (the foundational-enumeration rule) — tasks currently lacks
`enumerate` entirely.

### B4. MCP remaining slices

#171e–i as still open (HTTP+OAuth RS, WS transport, direct projection
`mcp://gateway/<name>`, embedded OAuth AS, conformance+README); #152
connection pool keyed by auth principal (Ryan flagged "weeks"); #123
resources runtime, #124 roots bridge, #125 capability discovery — the last
native-foundation items, and #123 gates MCP resource projection.

**#152 is the template, not plumbing (ADR 48 §5):** the per-principal
checkout/return contract (lease vs refcount; behavior when a principal's
last session closes) must be designed as the *generic* pattern for every
principal-bound-instance resource — sandbox runtimes next, BYOK provider
executors after. Design it once, at that altitude.

### B5. Cluster: failover = rehydration; validate fan-out on the real workload

- With Workstream A landed, **node death = rehydrate-on-next-send**. Design
  note (small ADR or ADR-49 appendix): **execution leases** — who owns an
  in-flight execution, lease expiry on node loss. No live session migration;
  do not build state-transfer machinery.
- **First production cluster validation target:** cross-replica event
  fan-out to connected clients — exactly what Knowify hand-rolls with the
  Socket.IO Redis adapter. `ClusterEventBus` over `cluster-redis` replaces
  it. Build the demo/bench proving it (multi-node gateway, WebSocket
  clients on different nodes, session events reaching all).
- Keep the phase-4b/5 TODOs (codec routing, partition rebalance, per-sub
  scope opt-in, remote ask) in the backlog behind the lease work. #207
  real-Redis docker conformance lands with the fan-out validation.
- L8 (substrate self-instrumentation) belongs here: bus lag / journal size /
  inbox cache metrics surface — required for a distributed deployment to be
  operable, and a v2.0 release blocker per STATUS.

---

## 5. Workstream C — v1 parity, landing on the gateway

Ryan: v1 has "connectors and other things still missing... they will
inevitably make it in there and they will be very likely on gateway."
**Start with a verification pass** — the gap inventory's sizing assumed less
v2 than exists. For each item: confirm the gap, write the shape decision
(most need #254 landed first), then port with v1 as the lesson source
(`packages/` stays in-tree for exactly this reason).

### C1. Connectors (design decision required ⛔)

v1: `packages/connector` base + `connector-telegram`, `connector-imessage`.
A connector is an inbound/outbound channel binding (a chat surface ↔
sessions). Proposed v2 shape to pressure-test in the ADR: a **gateway
extension** (per #254) that owns platform auth + webhook/long-poll ingress,
maps platform conversation → session (via the store-backed resume path from
Workstream A), and rides the fan-in bus for outbound delivery. Naming per
convention: `connector-next` (base) + `connector-telegram-next`, etc. The
transcript corpus contains zero design discussion of connectors — do not
assume v1's shape is wanted; write the ADR from v2 primitives and the v1
lessons.

**Principal rule for multi-actor surfaces (binding — ADR 48 §5):** a
group chat is one conversation with multiple humans. The session's
principal is the **installation/workspace identity** (whatever
authorized the connector); the per-message *actor* rides
`RuntimeContextUser` / message metadata as a context dimension. Never
principal-per-sender — that would break session principal-immutability.
The connectors ADR must state this explicitly.

### C2. Channels

v1 named channels (`"messages"`, `"tool_confirmation"`, custom per-client
subscriptions). v2 largely covers this with bus + subscriptions + wire
notifications; the parity work is a **mapping doc + gap-fill**, not a new
subsystem (compose primitives, not subsystems). Verify against v1 client
use cases; fill only proven holes.

### C3. Framework HTTP adapters

Explicitly bookmarked in-session and still outstanding. Express first
(thin: mount gateway dispatch + SSE on an Express app — Knowify embeds in
NestJS, so a NestJS-friendly story matters too). Keep them trivial
wrappers; the transports already own the real logic.

### C4. Sandbox providers

v2 sandbox harness exists with in-memory bridge only. Port v1's provider
interface + docker/local providers as `sandbox-<provider>-next` packages.
(TigerFS stays adopter-side.)

### C5. DevTools

Parked by Ryan ("clean-sheet UI; circle back"). The v2-shaped design is now
cheap: devtools = a wire-extension client of the gateway consuming the bus
+ journal; the **persistence-backed production inspector** ("persist events
to PG... build an admin ui around that") becomes a journal-store adapter
question after Workstream A. Schedule the server/protocol slice; the UI can
trail the cut.

### C6. Scheduler

Extensively designed in-session ("scheduler is pure event source,"
location-agnostic extension) but never built; Ryan lists
`@agentick/scheduler` among the endgame package names. Post-ADR-49 it's
small: durable job store port + emits on the bus. Schedule after A + B1.

### C7. TUI / CLI / misc utilities

TUI is a named client of the wire ("the TUI is also a client") — defer
until the client surface stabilizes (post-B3). CLI, guardrails, secrets
(subsumed by credentials), angular/socket.io bindings: defer or drop;
decide at cut time with the two-pole test.

### C8. Structured outputs + terminal tools

Live adopter need (Knowify email-classification flows). The in-flight v1
plan (`terminal?: boolean` tool config + `createTerminalTool` that
short-circuits loop continuation, overridable by continuation hooks) should
land **in v2 terms**: this is also the missing **continuation-policy hook**
on the loop executor (currently one hardcoded line). Pair it with the
structured-output design decision (three candidate models in the docs; pick
one, note that only OpenAI honors `responseFormat` today and others drop it
silently — that silent drop must become an explicit error or projection).

---

## 6. Workstream D — Metapackage, personas, acceptance gates

### D1. `agentick` metapackage

Assemble the public metapackage bundling the built-ins (ADR 27's packaging
asymmetry made real). Includes the default-wiring ergonomics pass —
`createApp` with sensible defaults; the "cleaner api for this" itch Ryan
flagged. The config-file convenience layer ("agentick is low-level... one
would build a framework on top") is a **post-2.0** concern; note it, don't
build it.

### D2. Two reference personas (standing gap-finders)

- **Local pole:** openclaw-style single-user agent — gateway + in-process
  or unix-socket transport, fs timeline store, sandbox, skills. Extend
  `example/v2-otto` or add `example/v2-local`. This is also the quickstart
  the READMEs point at.
- **Cloud pole:** ernesto-shaped skeleton — gateway + auth adapter +
  postgres timeline store + MCP server + spawn + compaction-via-
  ProjectionStrategy. Not a production migration; a gap-filing instrument.
  Every piece of Knowify glue (V1SessionStore, enrichment hooks, media
  resolution, tool filtering, ALS injection) must map to a v2 primitive or
  file an issue. Media-block resolution in canonical projection is a known
  gap to file immediately (Knowify has an in-code note begging for it).

### D3. Acceptance gates for the v2.0 cut ⛔

1. Both personas run green end-to-end.
2. **tentickle migrates 100%** (Ryan's named test).
3. Kill-and-resume durability test passes on both poles (Workstream A).
4. Cluster fan-out validation on Redis passes (Workstream B5).
5. L7 + L8 closed; workspace tests + strict typecheck green.
6. Then, and only then, the mechanical sweeps: #243, #275, #268,
   `packages-next` → `packages` git-mv, drop `-next` suffixes, README/
   docs sweep.

---

## 7. Workstream E — Containment + hardening (fill work, any time)

- **Effect charter ADR** (short): two audiences, one rule — spec-facing and
  port-facing surfaces are Promise-shaped; Effect is internal + opt-in.
  Consolidate the ~150-LOC duplicated scaffolding across `defineExecutor` /
  `defineLanguageModelExecutor` (#103) and make the callback path the
  canonical documented way to write a provider executor; the
  `BaseLanguageModelExecutor` class becomes the advanced tier. Conformance
  suites runnable from plain vitest without Effect imports.
- **Runtime slot-collision detection** for `extensionBridges` /
  augmentation-backed registries: occupied slot ⇒ throw. One guard,
  prices the module-augmentation version-skew risk before third-party
  harnesses exist.
- **READMEs** for timeline/state/knobs/gates/subscriptions (scaffold rule
  currently violated), each declaring its ADR-49 state class.
- ADR 41 error-hierarchy migration completion wherever POJO `_tag` unions
  remain (executor/tool-executor/mcp noted).
- Anthropic executor body (not adopter-critical — ernesto runs
  OpenAI+Google — but needed for dogfooding/eval; slot as fill work).
- Loaders backlog: #246 follow-ups, #248/#249/#250.

---

## 8. Sequencing

```
A1 (ADR 49) ──► A2 (TimelineStore + adapters + barrier) ──► A3
   │                    │
   │                    ├──► B5 (leases + fan-out validation, needs A for rehydrate)
   │                    └──► C5/C6 (devtools persistence, scheduler store)
B1 (#254 ADR) ──► B2 (auth/principal edge) ──► C1 (connectors ADR+port)
   │                 └──► B3 (wire train) ──► B4 (MCP slices) ──► C7 (TUI)
C8 (terminal tools + continuation hook)   — independent, adopter-driven, early
D1 (metapackage) ──► D2 (personas; personas consume A2/B2 as they land)
E (fill work)      — parallel throughout
D3 (gates + mechanical sweeps)            — last
```

Recommended start order: **A1 and B1 in the same week** (both are ADRs;
both unblock the most), C8 early (small, real adopter pull), then A2 and B2
as the first implementation arcs.

---

## 9. Evidence base (for the implementer's orientation)

- Transcript mine (796 user messages, main session): decisions on substrate
  slots, ADR 36 define/create, ADR 40/45/46/48, "in-memory default +
  adapters" ratified, snapshot-vs-external-source-of-truth tension
  acknowledged, the two-pole openclaw↔multi-tenant quote, the cluster
  sprint declaration, the do-not-start renames.
- v1 gap inventory: connectors (telegram/imessage), gateway plugins
  (mcp-server/openai-compat/logging), channels, devtools server, sandbox
  providers, scheduler, TUI/CLI, express middleware.
- Knowify audit: `V1SessionStore` write-behind projection (826 LOC to be
  absorbed by store ports), dual-token auth plugin, per-client MCP tool
  filtering, media resolution note, custom timeline windowing/compaction,
  stateless-replica + Redis fan-out topology.
