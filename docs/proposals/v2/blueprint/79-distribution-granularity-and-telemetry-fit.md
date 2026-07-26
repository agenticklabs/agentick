# ADR 79 — Distribution granularity: the session spine is the co-located entity (resolving A/B), and how telemetry fits

**Status:** DRAFT 2026-07-11 (Fable, for Ryan). **Supersedes** ADR 78's A-vs-B resolution (which chose B under uncertainty about whether composing the spine would hurt clustering — the dig below resolved that uncertainty). **Retains** ADR 78's brick #1 (app-edge telemetry runtime) and the whitelabel namespace — both valid under this decision. **Builds on:** ADR 77 (operation spine / fiber tree), ADR 38 (cluster lifecycle & ownership — DECIDED), ADR 35 (cluster protocol), ADR 31 (harness hierarchy), ADR 49 (planes).

## The finding that closes A/B

ADR 38 pins it verbatim: **"The cluster wraps the framework's local substrate (`bus`/`inbox`/`journal`)… Cluster is NOT a harness — it's the substrate-wrapping layer."** And the spine reaches the executor / tool-executor / reconciler by **direct object reference** (`RunExecutionInput`), **not** through bus/inbox — so the spine **bypasses the cluster-wrapped substrate entirely**.

Therefore **composing the spine (ADR 77 "A") is orthogonal to clustering** — it reclaims the fiber tree for calls that were always local direct-refs, and it does not touch the cluster package, which only wraps the message substrate the spine doesn't use. The fear that killed A in ADR 78 ("does mending the spine hurt the cluster story?") is answered **no**, by the code.

The one thing ADR 38 leaves _implicit_: the **distribution granularity**. Co-location of the spine is currently true _by construction_ (direct refs can't cross a process), not _by decision_. This ADR makes it a decision.

## Decision — the granularity contract

1. **The session's operation spine is a co-located ENTITY** (the actor / grain / `@effect/cluster` entity). Its harnesses (loop, executor, tool-executor, reconciler, and the leaf harnesses a run touches) communicate by **direct reference** and **compose as one fiber tree**. Structured concurrency, coordinated teardown on abort, resource scopes, ambient context, and nested tracing all work **in-process, within the entity**.

2. **Distribution happens at coarse boundaries via bus/inbox** (the cluster-wrapped substrate, ADR 38): whole sessions across nodes (sticky affinity), and shared services (task store, model gateway) over the wire. **This is the only seam where the fiber tree breaks**, and it breaks correctly — you cannot span a fiber across processes.

3. **Distributing _within_ a spine is a non-goal.** A network hop per tick is absurd; the spine is the tightest inner loop in the system. Anyone who ever needs it converts a _specific_ call to an inbox message and accepts the break _there_ — a deliberate, local choice, never the default.

This is the actor/entity model (Erlang/OTP, Akka, Orleans grains, `@effect/cluster`): **compose within the entity, message across entities, at a coarse boundary, with a resolution layer (the cluster) swapping local impls for remote proxies.** v2 already draws this line; ADR 78's B was severing the fiber tree _inside_ the entity for a distribution scenario that never occurs there.

## Consequences

- **Compose the session spine** (ADR 77's S1) — the real work. The **characterization suite (committed) is the safety net**; the loop `Effect.gen` rewrite is the crux, done behind it.
- **`parentOpId` propagates via FiberRef** within the composed spine — delete the manual threading _on the spine_.
- **The `.fx` edge** is the leave-Effect-land boundary (native-JS facade + Effect twin); `runPromise` happens once per send at the entity edge, plus once per node-hop at inbox handlers.
- **The cluster package needs no rework** — it is correctly positioned at bus/inbox.

## How telemetry fits (the proof the model is right)

Telemetry falls out of the granularity contract exactly, at both scales:

**Within the entity — free nested traces.** A `session.send` composes the spine into **one Effect**, run at **one root** on the entity's tracer-carrying `ManagedRuntime`. Because it's one fiber tree, every `Effect.withSpan` **nests automatically** — `session:send` > `loop:tick` > `executor:model-call`, `tool-executor:dispatch` — a proper trace tree, **for free**, with **one `Effect.provide(tracerLayer)` at the edge**. No per-harness runtime threading. No explicit span-parent plumbing. The whitelabel namespace and other telemetry config are read from the **fiber context** (provided once at the entity edge), so they reach every spine span without threading.

**Across entities / nodes — explicit stitch at the coarse boundary.** When a session messages another session or a shared service, the cluster-wrapped bus/inbox carries **W3C `traceparent`** on the message; the receiving node reads it as the parent span. Traces stitch across the process boundary the same way every distributed tracer does. Explicit propagation is correct _here_ — it's the one seam that genuinely crosses processes.

So telemetry is **composed within the entity, propagated across entities** — precisely the granularity contract. It "just works" the way the model says, which is the strongest evidence the model is right.

### What this means for the telemetry bricks

| Brick                                                 | Status under this ADR                                                                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1 — app-edge `ManagedRuntime` (built-once, disposed) | **KEPT** (committed) — the foundation. Extends from app-edge to the **session/entity edge** (one runtime injection per entity, _not_ per harness). |
| Whitelabel `telemetryNamespace`                       | **KEPT** (committed) — now read from fiber context so it reaches every spine span once the spine composes.                                         |
| #2 — per-harness runtime threading (ADR 78, "B")      | **SUPERSEDED** — unnecessary. Compose the spine → one root → one provide → free nesting. This is the throwaway we correctly paused.                |

So the committed telemetry work is **not wasted** — brick #1 and the namespace are the foundation under A too. Only the per-harness threading we _didn't_ build is dropped.

## Migration (unchanged from ADR 77, now with a decided target)

Spine-first, dual-path, characterization-guarded, edge contract frozen. Telemetry lands **when the spine composes** (free nesting), not as separate plumbing. Leaf harnesses that a run doesn't compose into stay independent and get telemetry via the same entity-edge runtime if they run within a send, or their own edge otherwise.

## Confidence

- Granularity contract: **HIGH** — directly evidenced (ADR 38 substrate-wrapping + the direct-ref spine), matches all prior art, and it's what v2 is already shaped for.
- A over B (on the spine): **HIGH now** — the cluster-orthogonality that was uncertain in ADR 78 is resolved by the code.
- Telemetry fit: **HIGH** — one provide at the entity edge + traceparent across; standard, and it validates the granularity.

## The one thing still worth confirming

ADR 35 (cluster protocol) — a skim to confirm nothing there _intends_ spine-level distribution (executor-reachable-via-inbox as a goal). The evidence says no (the spine is direct-ref, the loop's inbox dispatch is explicitly "not yet wired"), but ADR 35 is the place a contrary intent would live.
