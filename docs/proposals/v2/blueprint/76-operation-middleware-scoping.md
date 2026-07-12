# ADR 76 — Operation middleware scoping: per-harness, structural inheritance, and the call-scoped seam

**Status:** DRAFT 2026-07-10 (Fable, for Ryan). **Builds on:** ADR 19
(foundation — `Operation`, `runOperation`, the phase contract, the
`RuntimeContext` FiberRef), ADR 31 (harness hierarchy — two-phase construction,
parent-provided substrate, the `parent` reference every `BaseHarness` carries),
ADR 26/27 (everything-is-a-harness; built-ins are bundled, not privileged).
**Governing principle:** [[feedback_capability_not_opinion]] — ship the
*mechanism* (a place to register cross-cutting behavior) firmly; carry no policy
about what that behavior is.

## TL;DR

Middleware in v2 is registered per-harness-instance (`harness.use(mw)`) and wraps
only the operations *that* harness routes through `runOperation`. A deeply nested
call — `session.send` → tool-executor op → state op → knobs op — crosses four
harnesses, four independent `MiddlewareChain`s, and **no single registration wraps
the whole tree.** This ADR defines the scoping model as **three tiers**, mapped to
established mechanisms:

1. **Per-call** — no API. You own the body; wrap it at the call site. A per-call
   middleware API would be redundant.
2. **Per-harness instance** — `harness.use(mw)`. Exists today. Structural
   decorator at one node.
3. **Cross-tree ("global")** — **structural inheritance**: a harness composes its
   construction-ancestors' middleware around its own, root-outermost. Register at
   the app/session harness → every descendant operation is wrapped. **This is the
   change this ADR specs and the one we build now.**

A fourth, **call-scoped (dynamic)** tier — middleware carried on the
`RuntimeContext` FiberRef so it follows dynamic call causality rather than the
static construction tree — is designed here but **deferred** until a concrete
request-scoped consumer (a per-request budget cap is the likely first) exists.

## Problem

`BaseHarness` gives every harness a `MiddlewareChain` (`this.middleware`) and a
public `use(mw)`. `runOperation` composes **only `this.middleware`** around the
operation body:

```ts
// base-harness.ts, runOperation, step 4
const composed = this.middleware.compose<I, R, E>(body);
```

That is correct for *instance-local* concerns ("every write through this state
harness gets validated") but leaves a gap the moment a concern is **cross-cutting**:

- "Trace every operation everywhere" (one OTel span per op, app-wide).
- "Journal every operation with adopter tenant tags."
- "Enforce authorization uniformly across all harnesses."

Today each of those forces the adopter to `.use()` on *every* harness by hand —
and to *keep* doing so as new harnesses (sub-harnesses, spawned children) come
into existence. There is no register-once-applies-everywhere seam. The nesting is
real (`runOperation` already builds a causality tree via `parentOpId` inherited
from the FiberRef), but the middleware layer does not participate in it.

## Why the null hypothesis doesn't suffice

*Steel-man first (per [[feedback_steelman_the_null_hypothesis]]): why can't the
adopter just register on each harness?*

Because harness instances are created **by the framework, dynamically, below the
adopter's reach.** A `SessionHarness` constructs its own tool-executor, state,
knobs, gates sub-harnesses during two-phase construction (ADR 31); a `session.spawn`
creates a child session with its own sub-tree. The adopter never holds references
to most of these at the time they'd need to call `.use()`. "Register on each
harness" is not a workaround — it is *impossible* for the harnesses that don't
exist yet at registration time. A cross-cutting concern must attach to a **place in
the tree** (an ancestor) and be *inherited* by descendants created later. That is
exactly what parent-provided substrate (ADR 31) already does for the bus, inbox,
and journal. Middleware is the one cross-cutting substrate that was left
per-instance. Concrete failing case: an adopter calls `app.use(tracing)` before any
session exists, then `app.createSession()` twice; with today's code neither
session — nor any of their sub-harness operations — is traced, and there was no
object to `.use()` on when `tracing` was registered.

## Decision

### Tier 1 — Per-call: no API

If you own the call site, you own the body — wrap it there. Middleware earns its
keep only for operations you *don't* directly invoke. We ship nothing here.

### Tier 2 — Per-harness instance: `harness.use()` (unchanged)

Registers on `this.middleware`. Wraps every operation this harness routes through
`runOperation`. First-registered is outermost. This is the decorator-at-one-node
seam and it is correct as-is.

### Tier 3 — Structural inheritance (the change)

A harness's effective middleware stack is **its construction-ancestors' chains,
composed root-outermost, wrapping its own chain, wrapping the body.** Formally,
for a harness `H` with ancestor path `root → … → parent → H`:

```
composed = compose([ ...root.mw, ...ancestors.mw, ...parent.mw, ...H.mw ], body)
```

where within each chain first-registered is outermost, and the **root ancestor's
middleware is the outermost of the whole stack**. Broad scope wraps narrow scope:
an app-level tracing span encloses a session-level auth check encloses a
knob-harness-level validator encloses the body.

Mechanism: `runOperation` already reads the ambient `RuntimeContext` to inherit
`parentOpId`. We add a sibling walk over the **construction** parent pointer
(`this.parent`, present on every `BaseHarness` per ADR 31) to collect ancestor
middleware. The walk is done **fresh per operation** so late (un)registration on an
ancestor is honored, and it terminates at the first non-`BaseHarness` parent
(top-of-tree). Cost is a handful of pointer hops (tree depth is
gateway→app→session→sub ≈ 3–4); negligible against Effect operation overhead.

**Behavior-preserving:** a root harness (no `BaseHarness` ancestor) with only its
own chain composes identically to today. A child with no ancestor middleware
registered composes identically to today (ancestors contribute empty lists). The
change is strictly additive — it only does something once an ancestor is `.use()`d.

**Limitation (correct by design):** structural inheritance reaches middleware
registered on a *true construction ancestor* only. A harness constructed with
`parent === undefined` inherits nothing. This is the right semantics for a
*structural* scope — "everything under this node in the tree" — and it is why the
call-scoped tier below exists for the cases structural scope can't express.

### Tier 4 — Call-scoped / dynamic (BUILT — the ADR 77 spine payoff)

> **UPDATE (built).** Tier 4 was originally deferred (below) on the null hypothesis
> that tiers 2/3 cover the common cases. Building the ADR 77 spine surfaced that the
> hypothesis is FALSE for the most common case — see "Construction-topology finding."
> Tier 4 is now built: `withCallMiddleware([mw], effect)` (exported from
> `@agentick/runtime-next`) scopes `mw` around every nested `runOperation` the effect
> reaches, via a `CallMiddlewareRef` FiberRef read at the compose site (outermost of
> all). Proven cross-sibling in `runtime/__tests__/call-middleware.spec.ts`.

**Construction-topology finding (why tier 4 is primary, not deferred).** The ADR
originally assumed a nested construction tree (`gateway → app → session → sub`) where
structural inheritance (tier 3) reaches most concerns. The real topology is FLAT: the
app constructs the loop / executor / tool / reconciler ONCE as **shared singletons**
and hands the same instances to every session — so they are construction-*siblings* of
the session, not its children. Consequences: (a) `app.use()` (tier 3) reaches
everything — deployment-global; but (b) a **session/request-scoped** concern around the
model call CANNOT be expressed structurally — the executor is shared across all
sessions, so a session structurally wrapping it would leak into other sessions. That
concern is exactly tier 4's *dynamic call scope*, and the ADR 77 spine (the call
`session.send → loop → executor → tool` is now ONE fiber) is what makes the FiberRef
propagate across those siblings. **The spine did not merely unblock tier 4; it made
tier 4 the primary mechanism for the single most common middleware need.**

Structural scope walks the *construction* tree. Some concerns are scoped to a
*dynamic call tree* instead: "run *this* `send` with a budget cap" or "trace *this
one* request," where the middleware should wrap every nested operation across every
harness the call touches, then evaporate — regardless of where those harnesses sit
in the construction tree.

**Use Effect's own dynamic-scope primitive — do not hand-roll fiber propagation.**
`runOperation` already establishes the `RuntimeContext` FiberRef via `withContext`
(step 0), so the mechanics are proven. Carry the ambient middleware list on a
`Context.Reference<OperationMiddleware>` (Effect service with a built-in default —
no `Layer` wiring at call sites) or extend the existing `RuntimeContext` FiberRef,
and scope it with `Effect.provide` / `Effect.locally`. Every nested `runOperation`
reads it and composes it **outermost of all** (broadest scope). Fiber propagation,
fork inheritance, and teardown are Effect's job, not ours:

```ts
// SKETCH — not built. Effect provides the propagation.
Effect.provideService(session.send(input), OperationMiddleware, [budgetCap])
// → budgetCap wraps every op transitively reached by this send,
//   in every harness, then is gone when the send completes.
```

Cost was ~5 lines at the same spot `runOperation` already reads the FiberRef — the
list read + a `composeMiddleware([...call, ...inherited, ...own], body)`. **Built as
described.** The `CallMiddlewareRef` FiberRef holds the ambient list; `runOperation`
reads it (`yield* getCallMiddleware`) and composes it outermost; `withCallMiddleware`
scopes it via `Effect.locally` (nested calls accumulate). No `Layer` wiring at call
sites. The original "defer to first consumer" reasoning was overtaken by the
construction-topology finding above: call-scoped is not a *per-deployment-vs-per-request*
nicety — it is the ONLY correct scope for session/request middleware around a
*shared* harness, which is the common case, not the rare one.

> **Aside — why not `@effect/rpc`'s `RpcMiddleware` for any of this?** It exists,
> and it's the closest named prior art, but it's bound to `@effect/rpc`'s handler
> model and wire envelope. The v2 wire is **JSON-RPC 2.0** (chosen for MCP
> envelope-parity, ADR 33), not `@effect/rpc`'s format — so `RpcMiddleware` is not
> reachable at our wire, and operation middleware here is a *substrate* concern
> (around `runOperation`), not a *wire* concern regardless. See ADR 33 §rejected
> alternatives.

### Composition order (all tiers together)

Outermost → innermost:

```
call-scoped (FiberRef, broadest)      ← deferred tier 4
  → inherited ancestors (root → parent)   ← tier 3, this ADR
    → this harness (tier 2)
      → lifecycle `before` handlers (verdict: veto>replace>defer>proceed)
        → operation body
```

Within any one chain, first-registered is outermost.

## Consistency requirement: handlers share the model

`BaseHarness` has **two** intercept seams, not one: freeform `Middleware`
(around-style, this ADR) and the `HandlerRegistry` verdict system
(`before`/… handlers returning `veto | replace | defer | proceed`). They are
different *powers* (freeform wrap vs. structured decision) and that distinction is
deliberate. But the **scoping model must be the same for both**, or adopters will
be surprised that `app.use()` reaches a descendant while an app-level `before`
handler does not. Handler inheritance is **not** in the tier-3 change below (kept
surgical), and is flagged as the immediate follow-up: `HandlerRegistry.run` should
walk the same construction-ancestor path. See open question Q2.

## What this is NOT

- **Not a new hook subsystem.** Tier 3 reuses the `parent` pointer ADR 31 already
  threads. Tier 4 reuses the FiberRef `runOperation` already reads. No new
  registry, no new lifecycle.
- **Not policy.** The framework ships the *place to register* and the *composition
  order*. What any middleware does — trace, journal, authorize, cap — is the
  adopter's. Capability, not opinion.
- **Not the `onChange` notify seam (ADR 75).** Middleware is *intercept* (can
  transform / short-circuit). `onChange` is *notify* (read-only, after-the-fact).
  Different power levels, different ADRs. This ADR is the intercept side's scoping;
  ADR 75 is the notify side's primitive.

## Open questions

1. **Walk vs. cache.** Collect the ancestor chain fresh per op (current spec —
   honors late registration, simplest) or memoize per harness and invalidate on
   ancestor `use`/unsubscribe? Start with the walk; memoize only if profiling a hot
   path demands it. Add a `TODO(perf)` trailhead at the walk.
2. **Handler inheritance.** Make `HandlerRegistry.run` walk the same ancestor path
   so tier-3 semantics are uniform across both intercept seams (see §Consistency).
   Immediate follow-up; separate diff.
3. **Public commands not yet on `runOperation`.** `SessionHarness.send`,
   `AppHarness.createSession` accept `.use()` registrations today but aren't wrapped
   until refactored onto `runOperation` (noted in the `use()` docstring). Inherited
   middleware has the same precondition. Tracked separately; not this ADR.
4. **Ordering: `before` handlers vs. inherited middleware.** Today `before`
   handlers run *outside* `this.middleware`. Under tier 3 they still run inside the
   inherited stack — an app-level span would *not* enclose a descendant's veto
   decision. Is that the wanted semantics, or should inherited middleware wrap the
   handler phase too? Deferred; the surgical change preserves today's relative
   order (handlers before middleware).

## Draft implementation

Spec'd against `packages-next/runtime/src/substrate/base-harness.ts` in DRAFT state
(marked `DRAFT(ADR 76)` at each touch point) to workshop the shape:

- `MiddlewareChain.snapshot()` — expose the registered list in order.
- `composeMiddleware(list, body)` — free function; `MiddlewareChain.compose`
  delegates to it (DRY).
- `BaseHarness.ownAndInheritedMiddleware()` — protected, recursive: returns
  `[...parent?.ownAndInheritedMiddleware(), ...this.middleware.snapshot()]`,
  yielding root-outermost order naturally.
- `runOperation` step 4 composes `this.ownAndInheritedMiddleware()` instead of
  `this.middleware` alone.

Strictly additive; behavior-preserving until an ancestor is `.use()`d.
