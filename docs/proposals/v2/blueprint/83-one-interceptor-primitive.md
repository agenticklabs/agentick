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

### 4. The cascade is live inheritance down the construction tree (generalizes ADR 82; deletes ADR 81)

> **Amended 2026-07-14 (gateway hook propagation, ADR 84).** The cascade was a
> _frozen construction-fold_ (each scope snapshotted its parent's
> `resolvedInterceptors()` once, at construction; a registration after a child
> existed did NOT reach it). That static boundary is now **live inheritance**:
> registering an interceptor on a harness propagates to every _live_ descendant,
> and a new descendant pulls the parent's current set at construction. The
> motivating requirement (ADR 84): a hook declared on the gateway must reach
> apps created **after** it, and cascade on down to their sessions and
> sub-harnesses. The paragraphs below describe the amended, live mechanism.

Guards + transforms inherit down the construction tree the SAME way hooks do
(ADR 82) — as a **live** relation, not a one-time snapshot:

- **Data.** Each harness holds `ownInterceptors` (its own registrations) and a
  live-maintained `inheritedInterceptors` (received from its parent). Each also
  holds a live `children` set. `resolvedInterceptors()` is the stable-sorted
  merge (guard-outermost, then scope, then registration — §5) of the two,
  memoized behind a dirty-bit invalidated on any mutation, so op-time stays O(1).
- **Construction (pull).** A child, on construction, registers with its parent,
  seeding `inheritedInterceptors` from `parent.resolvedInterceptors()` (the
  parent's current own+inherited set) and adding itself to `parent.children`.
  This preserves the old construction-time behavior exactly — a child still
  inherits everything registered before it existed.
- **Registration (push).** `harness.use`/`harness.guard`/`harness.hook` appends
  to `ownInterceptors` AND pushes the interceptor to every live `child`, which
  appends to its own `inheritedInterceptors` and recurses to grandchildren. The
  returned `Unsubscribe` removes it locally and cascades the removal to
  descendants by interceptor identity (`tagInterceptor`).
- **Teardown.** A destroyed child deregisters from `parent.children`; its
  inherited list is collected with it. No parent pointer survives teardown.

There is **no per-op parent walk** — op-time still reads only the local merged
list. The move from ADR 81's parent-walk was about not walking *per op*; live
inheritance keeps that (push-on-register, read-local-per-op) while restoring the
late-registration propagation the frozen fold gave up. This is what closes the
**gateway→app** gap (a gateway hook now reaches apps created afterward) without a
gateway special-case — every edge propagates identically. A per-request concern
around a SHARED harness (the model executor) is tier-4 (`withCallMiddleware`),
not the cascade — unchanged.

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

## Per-harness hookability (as of 2026-07-14)

The seam lives in `BaseHarness.runOperation`, so **any op routed through
`command()`/`runOperation` is hookable** — but not every op is routed that way,
and typed hook *names* exist only for verbs augmented into `CommandRegistry`.

| Harness / verb | Hookable | Typed name | Notes |
| --- | --- | --- | --- |
| `tool:dispatch` (+ `tool:abort`) | ✅ | ✅ | `onBefore/AfterToolDispatch`; `guardDispatch` |
| `session:send` / `append` / `apply-executor-result` / `apply-tool-results` | ✅ | ✅ | public door; NON-ADDRESSABLE (SendInput non-serializable); `apply-*` skip the loop's in-fiber `*Fx` path |
| `elicitation:elicit` | ✅ | ✅ | one op for the round-trip: before=request, after=response (form+URL unified) |
| `knobs:*`, `timeline:*`, `resources:*` | ✅ (mechanism) | — | route through `command()`; add a 1-line `CommandRegistry` entry for typed names |
| `tasks:submit` / `tasks:settle` | ⛔ | — (naming locked) | **the async-seam boundary**: the seam is async (`asBefore`/`asAfter` await); `submit` returns `TaskHandle` synchronously, so wrapping needs `runSyncExit` which dies on the async boundary. Unblockers: async `submit` (breaking) or a sync-hook fast-path (necessary-but-insufficient). |

**The async-only property is deliberate.** Every hookable op crosses the async
seam; a *synchronous* operation (a sync handle return, a sync FSM transition)
cannot be hooked without making it async. The things worth intercepting (model
calls, dispatch, elicits, sends) are inherently async; tasks is the one harness
whose valuable hooks sit on sync surfaces.

## Wire dispatch through the seam (ADR 80 §9, resolved 2026-07-14)

Wire (JSON-RPC) methods bypassed the seam: `transport/server/dispatch.ts` called
`resolution.handler(params, ctx)` directly. Now the handler call routes through
the **gateway's** `runOperation` (the `DispatchHost` IS the `GatewayHarness`). So
a wire method fires the gateway's interceptor seam — guards/hooks around the
dispatch — BUT under a **`wire:`-prefixed op name**, distinct from the op it
delegates to.

> **Amended 2026-07-14.** The first cut named the wire op after the bare wire
> method (`session/send`) and called the resulting `session/send ≡ session:send`
> Pascal collision "the symmetry." That only held because the gateway did NOT
> propagate hooks to apps — a bug (§4, now fixed) the design was leaning on. With
> live inheritance, a gateway `onBeforeSessionSend` folds down and fires at the
> `session:send` op; a wire op *also* named `SessionSend` would then fire the
> same hook a SECOND time at the wire boundary (double-fire, inconsistent between
> wire-originated and in-process sends). The fix is to stop the collision at its
> root: **give the wire op its own name.**

- **The name is the routing.** A hook fires wherever an op's name matches it, so
  every op must have a unique name. The wire dispatch op is `wire:<method>` —
  `wire:session/send` → `WireSessionSend` → `onBeforeWireSessionSend`. It no
  longer collides with `session:send` → `SessionSend` → `onBeforeSessionSend`.
  Each name now lands on exactly one layer:
  - `onBeforeWireSessionSend` — the **wire boundary** (gateway's own op): a
    session-send request arriving over a transport. Wire-specific concerns —
    rate-limit a method, transform wire params — live here.
  - `onBeforeSessionSend` — **every session send**, deployment-wide. Registered
    on the gateway it folds through apps to sessions (live inheritance, §4) and
    fires once at each `session:send` op, wire-originated or in-process alike.
- **`authorizeDispatch` stays the un-waivable pre-gate** — it runs BEFORE the
  wire op, so authz composes ahead of any userland wire hook.
- **Wire hooks are typed off `WireMethods`, NOT `CommandRegistry`.** The wire op
  names derive from `WireMethods` via the shared registry-agnostic derivation
  (`HooksOf<WireMethods, …>`, spec `hooks/derivation`) with the `wire:` prefix,
  so the wire surface and the op surface never mint the same key. This is the
  seam the client also types its hooks off (client-alignment follow-on) — one
  `Pascal`, three layers (client request · gateway wire · session op), distinct
  names, one fire each.
