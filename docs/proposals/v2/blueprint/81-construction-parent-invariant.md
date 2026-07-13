# ADR 81 — The construction parent is a mandatory, explicit invariant

**Status:** PROPOSED 2026-07-13 (Fable, for Ryan)
**Amends:** ADR 31 (self-similar slottable harness hierarchy), ADR 76 (operation-middleware structural inheritance)
**Depends on / unblocks:** ADR 80 (the hook cascade needs the parent chain to reach real harnesses)
**Fixes:** a live, silent gap — the parent chain that middleware, hooks, telemetry, and structural auth all ride is threaded inconsistently, so the cascade is half-wired today

## The problem

Four subsystems all walk `this.parent`:

- **ADR 76 middleware** — `ownAndInheritedMiddleware()` (`base-harness.ts:648`).
- **ADR 80 hooks** — `ownAndInheritedHooks()` (`base-harness.ts:766`).
- **Telemetry** — `parentOpId` linkage up the tree.
- **ADR 45 structural-identity-for-auth** — the construction tree *is* the auth structure.

But the parent pointer is set only from `BaseHarnessOptions.parent`, and most harnesses **drop it**. Audit (2026-07-13):

| harness | `super(...)` | forwards parent? |
|---|---|---|
| loop-executor | `super("loop", scopeId, journal, bus, inbox)` — **no options param at all** | **no** |
| tool-executor | `super("tool", scopeId, journal, bus, inbox)` — options taken, then dropped | **no** |
| knobs | positional | **no** |
| resources | positional | **no** |
| timeline / tasks / elicitation | partial | partial |
| session | `super("session", options.session…)` | yes |

And the app passes `parent: this` at exactly **one** construction site. So the cascade works only where `parent` happens to be threaded.

**This is already a bug, independent of hooks.** With `parent === undefined` on loop/tool/knobs, **`app.use()` (ADR 76 tier-3, the "deployment-global wraps every descendant" promise) never reaches them** — they receive only tier-4 call-scoped (fiber-continuous) middleware. "Audit every tool dispatch app-wide with `app.use`" is silently broken *now*. ADR 80's `app.hooks.onBeforeToolDispatch` would be broken the same way. An invariant this load-bearing must not be implicit and drop-on-omission.

## Decision

**Every harness is constructed as ROOT or CHILD — never orphan-by-omission.** A harness either explicitly has no parent (it is a root — a gateway, a standalone-in-a-test harness) or it receives its **true construction parent**. Silent omission (today's default, which yields an orphan) is eliminated.

### 1. Parent follows scope ownership (the resolution rule)

A harness's true parent is **the harness that owns its scope id** — this dissolves the "sibling vs child" ambiguity into a determinable rule rather than a judgment call:

- **App-scoped** (constructed with `appId`, shared across sessions — e.g. `loop`/`executor` at `base-harness`/app `:714`): parent = the **app**. These are construction *siblings of the session*.
- **Session-scoped** (constructed with `sessionId`, per-session — e.g. `tool` at app `:1332`, `timeline`, `knobs`, `gates`, `elicitation`, `tasks`, `resources`): parent = the **session**.
- **Gateway/app root**: no parent (explicit root).

This is load-bearing for correctness, not cosmetics: a session-scoped `tool` parented to the session makes `session.hooks.onBeforeToolDispatch` reach it (and `app.hooks` reach it transitively app→session→tool); an app-scoped `loop` parented to the app makes `app.hooks` reach it but **not** `session.hooks` (correct — the loop is shared, not per-session). Mis-parenting (e.g. an app-shared harness under one session) double-counts scope and leaks one session's middleware onto another's ops.

### 2. Enforcement — two levels

- **Minimum (this ADR's fix):** every harness constructor accepts a `BaseHarnessOptions` bag and **forwards it to `super`**, and every construction site passes the true parent per §1. `LoopExecutorHarness` (and peers with no options param) gain one. Harness-specific options types (`ToolExecutorHarnessOptions`, …) extend `BaseHarnessOptions` so `parent`/`hooks` ride through.
- **Ideal (follow-on):** children are *born from parents* — the app/session build sub-harnesses through a helper that stamps `parent: this` structurally, so an orphan child is impossible to construct. Strongest, because it can't be forwarded wrong; the minimum + explicit `parent: this` gets ~90% there.

### 3. The two-sided fix (spec)

- **Child side** — each dropper (`loop`/`tool`/`knobs`/`resources`, and the partial `timeline`/`tasks`/`elicitation`) forwards `options` (incl. `parent`, `hooks`, `metadata`, `principal`, `telemetryNamespace`) to `super`. Behavior-preserving in isolation: parent stays `undefined` until a constructor passes it.
- **Parent side** — the app and session pass `parent: this` (the true parent per §1) at each `new XHarness(...)` site. This is what *activates* the cascade.

Both are required; the child-side is safe/mechanical, the parent-side carries the §1 determination.

## What this unblocks

The construction tree becomes the **single source of truth for every cascading concern at once** — where a harness sits answers "what middleware, hooks, telemetry, and auth cascade to it," uniformly. Concretely: ADR 80's hook cascade reaches real harnesses (`app.hooks.onBeforeToolDispatch` fires for tool dispatch), and ADR 76 tier-3 middleware is restored to the harnesses that silently lost it.

## Rejected

- **Leave `parent` optional / drop-on-omission (status quo).** It half-wires four subsystems invisibly. The defect surfaced only because ADR 80 tried to use the chain end-to-end.
- **"Always non-null parent."** Standalone harnesses are legitimate roots; forcing a parent breaks test/standalone construction. Root-or-child (explicit), not always-parented.
- **Infer parent from the substrate.** Substrate (bus/journal/inbox) and construction-parent are orthogonal axes — a harness can share a parent's substrate without being its cascade child (or vice versa). Parent must be declared, per §1.

## Tests

- **Forwarding:** each migrated harness, given `{ parent }`, exposes it on `this.parent` (structural).
- **Activation + scope correctness:** an `app.use` / `app.hooks.onBefore<X>` reaches an app-scoped harness's op and a session-scoped harness's op (transitively); a `session.hooks` reaches session-scoped ops but **not** an app-scoped shared harness's op (the sibling separation).
- **Behavior-preserving:** with no parent passed, existing suites unchanged (orphan → root, today's behavior).
- **Regression gate for the ADR-76 latent bug:** an `app.use` middleware now wraps a tool dispatch (proving tier-3 reaches the previously-parentless tool).

@see ADR 31 (the hierarchy this hardens), ADR 76 (the middleware inheritance it repairs), ADR 80 (the hook cascade it unblocks).
