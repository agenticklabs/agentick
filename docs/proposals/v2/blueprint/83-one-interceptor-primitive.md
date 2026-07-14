# ADR 83 — One interceptor primitive: guard / hook / observe over `Middleware`

**Status:** ACCEPTED 2026-07-13 (Fable, for Ryan)
**Supersedes:** ADR 81 (construction-parent invariant — no longer needed).
**Amends:** ADR 76 (operation-middleware tiers), ADR 80 (command-lifecycle hooks), ADR 82 (hook cascade as construction-fold — now generalized to all interceptors).

## TL;DR

The operation boundary had **three** interception mechanisms — the verdict
**gate** (`HandlerRegistry` / `HandlerVerdict` / `runInheritedBefore`, a distinct
before-phase), **middleware** (`.use`), and **hooks** (`onBefore`/`onAfter`). Two
of them (gate, middleware) collected via a runtime **parent-walk**; hooks folded
at construction. That is one concept — _intercepting an operation_ — wearing
three costumes.

There is exactly **one** interception primitive: the wrapping `Middleware`
`(input, next, ctx) => output`. Everything else is a **kind** of it or **sugar**
over it:

- **`guard`** — admission control. Decides `proceed | veto | replace | defer`
  before the body. Sugar: `harness.guard(decide)` / `guardEffect`. Raises a typed
  `OperationSignal` that `runOperation` maps to the terminal.
- **`transform`** — reshapes input/output (this is plain middleware; hooks
  `onBefore`/`onAfter` are keyed sugar over it).
- **`observe`** — pure side-effect (metrics, logging), never changes the value.

`runOperation` composes ONE interceptor list, stable-sorted `guard`-outermost,
around the body. The verdict subsystem is **deleted**. The cascade is a
**construction-fold**, not a parent-walk (ADR 82, now generalized) — which
deletes ADR 81.

## Why (the three costumes, and the proof they collapse)

A single wrapping middleware covers the entire interception space:

| Intent                    | `(input, next, ctx) => output`                  |
| ------------------------- | ----------------------------------------------- |
| observe                   | `const r = await next(input); log(r); return r` |
| transform input           | `return next(reshape(input))`                   |
| transform output          | `return reshape(await next(input))`             |
| veto (deny)               | `throw OperationVeto` — never call `next`       |
| replace (canned result)   | `return cannedResult` — never call `next`       |
| defer (retry-later)       | `throw OperationDefer`                          |
| retry / timeout / acquire | the natural loop / race around `next`           |

The verdict gate was a strictly-weaker special case (before-only,
short-circuit-only) given a whole parallel subsystem. The codebase already
half-proved the collapse: **hooks already desugared to middleware** via
`asBefore`/`asAfter` + `liftMiddleware`. ADR 83 finishes that job for the gate.

## Design

### 1. Kinds + control-signals (`runtime/src/substrate/op-signals.ts`)

`InterceptorKind = "guard" | "transform" | "observe"`. Each interceptor is tagged
(`tagInterceptor`); untagged defaults to `"transform"`. A `guard` that decides
non-`proceed` raises a typed `OperationSignal`:

```ts
class OperationVeto {
  _signal = "veto";
  reason?;
}
class OperationDefer {
  _signal = "defer";
  retryAfter?;
}
class OperationReplace {
  _signal = "replace";
  result;
  reason?;
}
```

`signalFromVerdict(verdict)` is the SOLE bridge from the ergonomic
`HandlerVerdict` DSL to a signal.

### 2. The one composed seam (`runOperation`)

```
idempotency replay
  → emit requested / before   (observe-only events, unchanged)
  → assembled = [ ...callMiddleware (tier-4),
                  ...inheritedInterceptors (folded at construction),
                  ...ownMiddleware, ...hooks.forOp(name) ]
  → compose( orderInterceptors(assembled), body )     // stable: guard ≺ transform ≺ observe
  → settle: catchAll →  isOperationSignal ? terminateFromSignal(vetoed/replaced/deferred)
                                          : publish terminal:failed + re-raise ORIGINAL err
            success  →  terminal:succeeded
```

`catchAll` sees only the typed-failure channel (defects/interrupts pass through,
exactly as the prior `tapError`). **Terminal semantics are byte-identical**:
`terminateFromSignal` delegates to the same `terminate()` path the old verdict
switch used (`vetoed`/`deferred` fail with `OperationOutcomeError`, `replaced`
succeeds with the result). Only the _trigger_ changed — a caught signal instead
of a separate phase.

### 3. Naming — `guard`, not `gate`

The seam is **`guard`** (op admission). It is NOT `gate`: the `gates` package /
`SessionHarness.gate(name) => GateHandle` is **loop continuation**, a different
concept at a different scope. This is not aesthetic — the type system forced it:
a `gate(decide)` on `BaseHarness` collided with `SessionHarness.gate(name)`
(TS2416). The rule:

> **guard : operation :: gate : loop.**

`GuardDecider`, `guardEffect`, and the tool-executor's `guardDispatch` (was
`onBeforeDispatch`) follow. This also dissolves the earlier `onBeforeDispatch`
(gate) vs `onBeforeToolDispatch` (hook) collision — the gate one is now a guard.

### 4. The cascade is a construction-fold (generalizes ADR 82; deletes ADR 81)

Guards + transforms inherit down the construction tree the SAME way hooks do
(ADR 82): each scope snapshots its parent's `resolvedInterceptors()` at
construction into `this.inheritedInterceptors` (a frozen value threaded through
options, mirroring the `hooks` layer), and reads it locally per op. **No parent
pointer, no per-op walk** — which deletes `ownAndInheritedMiddleware`,
`runInheritedBefore`, and the construction-parent that ADR 81 was about.

Own tier-2 registration (`harness.use`/`harness.guard` on a harness's own ops)
stays fully dynamic — a local `this.middleware.snapshot()` read per op. What the
fold snapshots is only the INHERITED layer. As with hooks, the trade is the
static boundary: `app.use` after a session exists does not reach that session
(nothing built-in relies on this; a sweep found the walk functional on exactly
one edge — App→Session — and every sub-harness dropped `parent`, so the fold
also _fixes_ a latent gap: per-session sub-harnesses now inherit app-level
guards/middleware). A per-request concern around a SHARED harness (the model
executor) is tier-4 (`withCallMiddleware`), not the fold — unchanged.

### 5. Precedence by composition order (capability, not opinion)

Multi-guard precedence moves from the old **order-independent priority**
(`veto > replace > defer`, any veto wins regardless of registration) to
**compose-order**: the first non-`proceed` guard in composed order wins, with a
stable `guard`-outermost sort (then scope, then registration). That old priority
was the substrate **hardcoding a policy** into `mergeVerdict`; compose-order is a
mechanism the caller controls — consistent with agentick's "capability, not
opinion" line. The safety-relevant case — a **broad-scope veto beating a
narrow-scope replace** — is preserved by the guard-outermost + scope ordering
(pinned by `guard-ordering.spec.ts`). The only divergence is two guards at the
_same_ scope with a `replace` composed before a `veto`; that was untested and is
arguably the more honest semantic (you chose the order). Preserving
order-independence would require re-introducing a guard-collection pre-pass —
the exact machinery this deletes.

### 6. Fiber invariant — unchanged

Guards register via `this.middleware.use` and ride the SAME `liftMiddleware`
compose seam as `.use` and hooks (ADR 80 §7). Ambient `RuntimeContext`, OTel
span-nesting, and interruption survive the `await`. There is no bespoke
guard-runner. Because guards compose outermost, a retry/transform middleware
cannot swallow a raised veto signal.

## Rejected

- **Keep the verdict subsystem.** It is a strictly-weaker special case with a
  full parallel implementation. Its three legitimate responsibilities survive as
  thin conventions: the **named seam** (`guard()` sugar), **introspectability**
  (kind-tagged interceptors, `listInterceptors`), and **deny-before-transform**
  (the guard-outermost sort). No capability paid for the win.
- **A shared `Cascade<T>` container for guards + transforms + hooks.** Guards and
  transforms are flat lists (`readonly Middleware[]` + concat); hooks are keyed
  per-command (`Hooks`). Forcing one container is ceremony over an array. The
  unification is the _strategy_ (fold-at-construction, read-local-per-op), not a
  container type.
- **Order-independent verdict priority.** See §5 — a hardcoded substrate policy;
  replaced by caller-controlled compose order.

## Notes / follow-ups

- `LifecycleHandlerError` (spec) is retained as a valid error-taxonomy entry but
  currently has no producer: a guard decider that _throws_ (rather than returning
  a verdict) propagates the raw error to `terminal:failed`. If we later want to
  distinguish "the guard itself errored" from "the body errored," wrap the guard
  decider's failure in `LifecycleHandlerError` at `guardEffect`.

## Tests

- `guard-ordering.spec.ts` — deny-before-transform (transform registered first,
  guard still first, sees un-reshaped input); broad-ancestor-guard vs
  narrow-descendant-transform; guard-proceed non-destructive; `listInterceptors`
  enumerable + guard-outermost.
- `command-hooks.spec.ts`, `middleware-and-hooks.spec.ts`, `confirmation.spec.ts`
  — hooks + `guardDispatch` + the confirmation gate, all through the one seam.
- `structural-middleware.spec.ts` — the construction-fold inheritance + its
  static boundary (registration before construction inherits; after does not).

## Amendment (2026-07-14) — hooks ARE op-scoped middleware; the `Hooks` subsystem deleted

The original collapse left the thesis _almost_ complete. Hooks still rode a
**separate, parallel cascade**: the `Hooks` class + a per-command-keyed `hookLayer`
field, threaded via its own `hooks:` option down every sub-harness, read at the
compose site as `…this.hookLayer.forOp(name)` — distinct from the
`inheritedInterceptors` fold that carries guards + middleware. So "one seam" still
had two cascades and two storage mechanisms. This amendment finishes the job.

### The primitive that was hiding: `on<Command>`

A hook already desugars to middleware (`asBefore`/`asAfter` produce
`AsyncMiddleware`). Expose that middleware directly, **typed to the command and
scoped to its op**:

```
use(mw)                    ← floor: full middleware, UNTYPED, global
  on<Command>(mw)        = use( scopeToCommand(cmd, mw) )      ← THE primitive: typed + op-scoped
    onBefore<Command>(fn)  = on<Command>( asBefore(fn) )        ← sugar
    onAfter<Command>(fn)   = on<Command>( asAfter(fn) )         ← sugar
  guard(decide)          = use( tag("guard", verdict→signal) ) ← UNCHANGED, already exactly this
```

`on<Command>` is the _ultimate low-level typed_ registrar — the whole
`(input, next, ctx) => output` wrapper (wrap / retry / short-circuit / try-finally
/ shared state across both sides), typed to that verb, unlike raw `.use` (untyped,
global). before/after are one-sided conveniences on top.

### Op-scoping via `RuntimeContext.op`

For an `on<Command>` middleware to self-scope on the shared `.use` chain, the op
must name itself. `runOperation` computes the op's command suffix once (the same
`Pascal` suffix `deriveHookNames` yields) and puts it on `ctx.op`.
`scopeToCommand(suffix, mw) = (input, next, ctx) => ctx.op === suffix ? mw(...) : next(input)`.
This is the same keying the `hookLayer` did (Pascal suffix) — moved from a keyed
`Map` to a per-middleware tag + a `ctx` compare.

### One chain, one cascade

Hooks now register on `this.middleware` (own, dynamic) like guards. They cascade
through the **one** `inheritedInterceptors` fold (`resolvedInterceptors()` already
returns `[…inherited, …ownMiddleware]` — now inclusive of hooks). **Deleted:** the
`Hooks` class (`from`/`extend`/`without`/`forOp`), the `hookLayer` field, and the
separate `hooks:` threading through app/session/sub-harnesses. The declarative
`createSession({ hooks })` config folds into the SAME `inheritedInterceptors`
value threaded to per-session sub-harnesses (one threaded value, not two) — the
construction-fold static boundary is unchanged.

### What stays vs changes

- **Adopter API stays and GROWS.** The `hooks` config object stays; the
  `on[Before|After]<Surface><Action>` names stay; **added:** `on<Surface><Action>`
  (full middleware) in the config, on `harness.hook({…})`, and on the
  `harness.hooks.*` proxy. Nothing removed.
- **Guard is untouched** — already a `.use` guard-kind interceptor; concept, verdict
  DSL, `guardDispatch`, outermost-sort all as-is. Hooks merely join it on the chain.
- **Compose order** becomes **registration order** within the `transform` rank
  (guards still float outermost via the stable sort). This replaces the old
  "hooks always innermost" — more predictable, the "deferred interleave refinement"
  ADR 82 flagged, now resolved.
- **Imperative removal simplifies** — the `Unsubscribe` is the `MiddlewareChain`'s
  native unsubscribe; `Hooks.without` is gone.

### Cost

Each hook composes on every op and self-filters by `ctx.op` (vs the old keyed
lookup) — negligible for realistic hook counts. One new `ctx` field. Net: the
adopter surface grows, the substrate shrinks.

### The path (each step independently green)

1. `RuntimeContext.op` + set it in `runOperation`.
2. `scopeToCommand` + the `on<Command>` registrar/type (`CommandMiddlewares`) + proxy key.
3. Re-express `onBefore`/`onAfter` + `hook`/`hooks` over `on<Command>`.
4. Move the declarative `hooks` config to register over `.use`.
5. Delete `Hooks`/`hookLayer`/`forOp`; fold hooks into `resolvedInterceptors`; compose site drops `hookLayer.forOp`.
6. Merge the session-config hooks into the `inheritedInterceptors` threading (drop the `hooks:` option).

@see ADR 76 (tiers this re-collects), ADR 80 (hooks + fiber invariant), ADR 82
(the fold this generalizes), ADR 81 (superseded).
