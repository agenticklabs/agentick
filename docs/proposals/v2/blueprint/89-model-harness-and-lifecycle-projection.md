# ADR 89 — Command-ify the model call; lifecycle is the projected command-hook system

**Status:** PROPOSED 2026-07-21 · **REVISED 2026-07-21** (premise corrected against
the shipped code — see "Actual architecture" below)
**Builds on:** ADR 26 (everything is a harness), ADR 80 (command-lifecycle hooks),
ADR 83 (one interceptor primitive — guard / transform / **observe**), ADR 55
(React lifecycle hooks), ADR 56 (tree-declared model / `RegisteredModel`).
**Amends:** the reconciler's bespoke `LifecycleStore` + the loop's hand-fed
`notifyLifecycle` (both retired).

## Correction (what the first draft got wrong)

The first draft asserted "the model is not a harness — `LanguageModelExecutor` is not
a `BaseHarness`." **That is false in the shipped code.** `LanguageModelExecutor
extends BaseHarness<"executor">` (family `"language-model"`), it is session-owned
(`session.executor`), and it is per-send overridable (`input.executor ?? this.executor`)
and per-tick resolvable (ADR 56 `<Model>` → `RegisteredModel`). The harness identity,
session scoping, and swap points already exist. The real gap is narrower and this ADR
is re-scoped around it.

## TL;DR

Two gaps, one root cause. (1) The model call is **a `runOperation` Operation, not a
`this.command(...)`** — the executor IS a harness, but its `execute`/`executeStream`
never mint an ADR-80 command, so there are no `model:generate` hooks, no `guardGenerate`,
no journal entry, and `withRetry`/`withFallback`/`tapModel` stay **bespoke combinators**
instead of `.use()` interceptors. (2) The reconciler's **`LifecycleStore` is a
hand-curated 7-event subset**, fed by ~7 hard-coded `loop.notifyLifecycle(...)` calls —
a bespoke observation mechanism the compiler owns instead of _projecting_ the framework's.

Both dissolve into one decision: **command-ify the model call (`execute`/`executeStream`
→ `model:generate` / `model:generate_stream` commands on the existing executor harness;
`project`/`normalize` stay pure transforms), optionally wrap `tick` as a command, and
make React lifecycle hooks the compiler registering ADR-83 interceptors (`observe` /
`transform` / `guard`) on the constituent command harnesses — the same hooks a user
declares programmatically.** A `useOn*` hook registers a callback (closing over component
state via a ref), not a render, so it can observe, reshape, OR veto/defer an operation.
No bespoke lifecycle store; any command is observable and interceptable; the model call
gets hooks, a guard, interceptors, and journaling — by _name_ (`onBeforeModelGenerate`),
so they hold even as the per-adapter executor instance is swapped per tick.

## Actual architecture (the composition this ADR must respect)

Ownership is **dependency injection at a composition root**; execution is **orchestrated
by the loop**. Two different axes — do not conflate them.

**Ownership — the session is the composition root.** It owns every subsystem as a
sibling and injects them into the loop per execution (`session/harness.ts:593-603,
1503-1511`):

```
Session ─── owns: reconciler · executor(model) · toolExecutor · stateApplicator(apply
            cmds) · models(registry) · loop
   └─ loop.runExecution({ reconciler, executor, target, toolExecutor, resolveModel,
                          stateApplicator, … })   ← siblings injected, NOT owned by loop
```

**Execution — the loop is the orchestrator (owns none of them).** It reads the refs off
`RunExecutionInput` and drives the tick cycle:

```
loop.runExecution:
   reconciler.renderTree ─▶ executor.run(tree, target) ─▶ stateApplicator.applyExecutorResult
      ─▶ toolExecutor.dispatch(result.toolCalls) ─▶ stateApplicator.applyToolResults ─▶ (repeat)
```

- **Model executor — fully loop-scoped.** `executor.run` is only ever called inside the
  loop's tick cycle.
- **Tool executor — dual-driven.** Inside the loop on `result.toolCalls`, AND directly
  via `session.dispatch()` (`session/harness.ts:989`) — the host-door that invokes a
  tool by name _without the model or the loop_ (`audience:"user"` tools, procedures).
  Intentional; means tool execution is NOT fully loop-contained.

**Naming — it's the MODEL-EXECUTOR.** The runner is a sibling of `toolExecutor` and
should be named symmetrically: `modelExecutor : toolExecutor :: BaseHarness<"model"> :
BaseHarness<"tool">`. Today it's the ambiguous `session.executor` / `BaseHarness<"executor">`;
this ADR uses **model-executor** throughout and a surgical rename lands it (`session.executor
→ session.modelExecutor`, type `"executor" → "model"`; the `LanguageModelExecutor` CLASS
name stays — the ambiguity was the field/type, and the class rename batches with the
deferred `XHarness → X` suffix sweep). NOTE the distinct concept: `session.modelExecutor`
(the runner) ≠ `session.model` (the selection/swap facade, §2) — the runner vs. which LLM
it runs.

**The "model" is overloaded — three layers, containment `RegisteredModel ⊃ modelExecutor ⊃
adapter`:**

- **adapter** (`LanguageModelAdapter`) — the provider SDK binding + its default target.
  The concrete LLM.
- **model-executor** (`BaseHarness<"model">`, `LanguageModelExecutor` class) — wraps
  exactly ONE adapter (fixed at construction: `this.adapter = options.adapter`; `target`
  delegates to `adapter.target`) and provides `project → execute → normalize`. The RUNNER,
  sibling of `toolExecutor`.
- **`RegisteredModel` = `{ modelExecutor, target }`** (`hook-bridges.ts:465`) — a run-ready
  SELECTION: which model-executor (hence which adapter) at which target. What `<Model>`
  builds and the loop resolves per tick.

So "swap the model" is ambiguous: swap the adapter _inside_ an executor, or swap the
whole `RegisteredModel` _containing_ an executor. Because a model swap can swap the
whole executor, anything that must **persist interceptors across a swap** has to sit
_above_ the `RegisteredModel` — above the executor. Today that stable layer is **the
session** (it owns `executor` + `models` + per-tick `resolveModel`), which is why this
ADR puts model-selection concerns on a `session.model` facade rather than inventing a
new harness (see the Decision + the fork below).

## Context

- **The model call is a command-less Operation.** `execute`/`executeStream` on
  `LanguageModelExecutor` are `runOperation(op, body)` Operations (their `fx` twins),
  NOT `this.command(...)`. So ADR 80 never mints `onBefore/AfterModelGenerate`.
- **Consequences of the model call escaping ADR 80 (not ADR 26 — it IS a harness):**
  - `withRetry`/`withFallback`/`tapModel` = combinators reinvented per-adapter, because
    the model call carries no command to `.use()` interceptors on.
  - **No `guardGenerate`** — the single most expensive, most-worth-gating op has no
    admission control (cost caps, safety, prompt-injection, mock/replay).
  - **Not journaled** — the audit ledger is missing the model calls.
  - **No lifecycle** — `useOnModelGenerateStart` cannot exist.
- **The reconciler re-implements lifecycle.** `LifecycleStore` (7 kinds:
  tick/execution/tool/error start/end) is fed by the loop's `notifyLifecycle`.
  `loop:run-execution` and `tool:dispatch` ARE commands (they have hooks); `tick`
  and `model:generate` are NOT. So the store is a curated subset, the loop
  hand-feeds it (coupling the loop to the reconciler), and a future dep-less
  compiler would have to re-implement the same store.

Why it happened: the executor's `execute` was modeled as an Operation (fast path,
inlined under `run`) before "command hooks ARE the lifecycle" (ADR 80/83) crystallized.
The model call is the last hot-path op still outside the command-hook system.

## Decision

### 1. Command-ify the model call on the EXISTING model-executor harness

> **Status: LANDED** (Phase 1B, `feat/v2`) — `execute` → `model:generate`
> (`this.command`), `executeStream` → `model:generate_stream`
> (`this.commandStream`, exposing the `.fx` sink-fold twin the loop consumes);
> `project` / `normalize` / `run` renamed to the `model:*` op surface. Mints
> `onBefore/AfterModelGenerate[Stream]` + `guardGenerate` + journaling on the
> model call. Real executor + `FakeLanguageModelExecutor` + conformance current.

There is **no new `ModelHarness` layer** (the first draft's `BaseHarness<"model">` as a
NEW layer is dropped — see the fork in §2). The `LanguageModelExecutor` (the
model-executor, `BaseHarness<"model">` after the rename) is already the session-owned
harness sibling of `toolExecutor`; the only change is that its model call becomes a
command instead of an Operation:

- **`model:generate`** and **`model:generate_stream`** — the executor's `execute` /
  `executeStream` become declared commands (`this.command(...)`) instead of
  `runOperation` Operations, so ADR 80 mints `onBefore/AfterModelGenerate[Stream]`. The
  streaming variant is a **streaming procedure** (procedures already emit `stream:chunk`
  — `onBefore` at start, chunks in the middle, `terminal`/`onAfter` at end).
- **`project` and `normalize` STAY pure transforms** — stateless, no command machinery.
  Only the side-effecting model call is the command; `run` composes project → the
  `execute` command → normalize around it.
- **Hooks resolve by NAME, so they survive per-tick executor swaps.** The loop resolves
  a different `RegisteredModel` (hence a different executor instance) per tick; but a
  hook is registered as `onBeforeModelGenerate` at app/session scope and dispatched by
  the command _name_, not the instance — so it applies to whichever executor issues the
  command. This is why command-ifying the per-adapter executor is sufficient for
  hooks/guard/journal and a stable "model harness" instance is NOT required for them.
- **What falls out, all standard, nothing bespoke:**
  - Interceptors: `withRetry`/`withFallback`/`tapModel` collapse into `.use(...)` on the
    model command (ADR 83 `transform`/`observe`) — retire the bespoke combinators.
  - **`guardGenerate`**: `.guard(decide)` — `proceed | veto | replace | defer` on a
    model call (cost ceiling, safety veto, replay/mock `replace`).
  - Journaling: model calls become journaled operations (audit: model, tokens, timing).
  - Lifecycle: `useOnModelGenerateStart` = `onBeforeModelGenerate` (§4).

### 2. Model selection + swap — a `session.model` facade, NOT a new harness

> **Status: LANDED** (feat/v2) — `session.model` facade in
> `@agentick/session` (`model-facade.ts`): `setModel` / `setTarget`
> swap the session default via the journaled + hookable `session:set-model`
> command (`onBeforeSessionSetModel` policy veto); `use` / `guard` register
> session-scoped interceptors on `model:generate[_stream]` that ride the
> tier-4 call-middleware seam (`sendBody`) so they PERSIST across `setModel`
> swaps. Precedence unchanged (`input.modelExecutor ?? this.modelExecutor`).
> Verified by `session/src/__tests__/model-facade.spec.ts`.

**The fork.** A model swap can swap the whole executor (a different adapter), so the ONE
thing command-ifying the executor does _not_ give you is **interceptors that persist
across a `setModel` swap** (a cost-guard registered on executor-A is gone when you swap
to executor-B). The first draft answered this with a new stable `BaseHarness<"model">`
above the executor. **Rejected as over-layering:** the session ALREADY owns the stable
model-selection state (`this.executor` default, the `models` registry, per-tick
`resolveModel`, the `input.executor ?? this.executor` override). Cross-swap concerns
belong there, exposed as a thin facade — not a whole new harness sibling.

- **`session.model`** — a facade over what the session already owns:
  - `session.model.setModel(model)` / `setTarget(target)` — set the session-default
    `RegisteredModel` (replaces today's construction-bound `this.executor`). Declared as
    a session command **`model:set`** so it is journaled + hookable (`onBeforeModelSet`
    policy — "this session may not switch to model X").
  - `session.model.use(...)` / `.guard(...)` — **session-scoped** interceptors on the
    `model:generate` command, registered by name at session scope so they **persist
    across `setModel`** (the command dispatches to whichever executor is current). This
    is the persistence win WITHOUT a new harness — it rides the same by-name command
    dispatch as §1.
- **Effective-model precedence** (like tool-binding precedence): per-tick
  `<Model model={…}>` (reconciler slice) > per-send `send({ executor, target })`
  override > the session default set by `setModel`. `setModel` sets the session default;
  the scoped forms select for their scope; the loop resolves the effective
  `RegisteredModel` per tick as it does today.

> Escape hatch, if cross-swap persistence ever needs its OWN identity (inbox-addressable
> "route a generate to a model node" in a cluster, a lifecycle FSM for the model layer,
> per-model-harness journaling distinct from the session): promote the `session.model`
> facade to a real `BaseHarness` sibling then. Default is the facade; the harness is the
> documented next rung, not the starting point.

### 3. `tick` becomes a command

> **Status — §3 LANDED (feat/v2).** `loop:tick` is a declared command on the LOOP
> harness (the loop owns tick orchestration; the model executor owns the single
> model call). Body = the tick THROUGH SETTLE; the DECIDE (continuation) stays in
> the run-execution while-loop (settle IN, decide OUT). Mints `onBeforeLoopTick` /
> `onAfterLoopTick`. Command terminal = the tick barrier (kill/resume + tick-order
> suites green). `notifyLifecycle` LEFT in place — §4 retires it.

The per-tick model round is wrapped as a command (`loop:tick` or on the model/loop
harness) so it mints `onBefore/AfterTick` and emits phases like every other op.
**The tick barrier is preserved via the operation terminal**: the loop `await`s the
tick command's terminal (the tree-settle barrier `notifyLifecycle("tick-end")`
currently provides) instead of a hand-coded await. This is the load-bearing part —
kill/resume and tick ordering must survive the wrapping.

### 4. Lifecycle = the compiler projecting the FULL command-hook system (ADR 83)

> **Status — §4 LANDED (feat/v2).** The loop's `notifyLifecycle` feed +
> `ReconcilerProtocol.notifyLifecycle` are DELETED; the SESSION registers the
> forwarders (`loop:run-execution` / `loop:tick` / `tool:dispatch` tier-2,
> identity-filtered; `model:generate[_stream]` as tier-4 call middleware so a
> per-tick swapped executor still projects). The tick-end SETTLE is an
> in-cascade `onAfterLoopTick` hook (settle-before-decide preserved, ADR 67);
> `LifecycleStore` shrank to `LifecycleDispatch` (thin per-mount dispatch +
> catch-up cache) behind the optional `LifecycleProjectionTarget.dispatchLifecycle`
> capability. `useOnModelGenerateStart/End` shipped and fire on BOTH tick
> paths: the streaming tick rides `model:generate_stream`, and the
> non-streaming `fx.run` composes through the `model:generate` command
> (the §1 gap is closed — `run` in the real + fake executors routes the
> execute step via `commandEffect("model:generate")`, folding the
> ProviderAborted→canceled + guard-veto→vetoed terminals across the command
> boundary; the event's `stream` flag distinguishes the paths). Gates'
> `notifyTickEnd` (session continuation) untouched.

There is **no bespoke `LifecycleStore`**. React lifecycle hooks are the compiler
registering **ADR-83 interceptors** on the constituent command harnesses — the
_exact_ mechanism a user uses programmatically. A `useOn*` hook does NOT register a
render; it registers a **callback** (a function) closing over the component's latest
state via a ref (as `useOnToolEnd` already does with `ref.current`). The operation
then invokes that callback, and — because it is a function, not a render — it can be
**any of ADR 83's three kinds**, not just observe:

- **`observe`** — the common case. Fire-and-forget side-effect (update UI state, log);
  non-blocking; returns nothing. `useOnToolEnd(cb)` → `toolExecutor.hooks.onAfterToolDispatch`
  as an `observe`; `useOnModelGenerateStart(cb)` → `model.hooks.onBeforeModelGenerate`;
  `useOnTickStart/End` → the `tick` command's `onBefore/After`.
- **`transform`** — in-path, awaited; reshapes input/output. A component injecting
  context into `model:generate`, or rewriting a tool's args, from its render state.
- **`guard`** — in-path, awaited; returns `proceed | veto | replace | defer`. A
  component vetoing a tool call, or **`defer`-ring to an approval UI** (component-
  authored confirmation) — from its render-time state via the ref.

This is the reconciler's thesis: the tree DECLARES the agent's behavior. It already
declares tools, sections, knobs, `gate()`; declaring a `guard`/`transform` on an
operation is the same move (`<ToolGate>` vetoing on user state; a `useGuardToolDispatch`
that defers to a confirm dialog). React components become full lifecycle participants,
not passive observers.

- **Any command is observable / interceptable** — the hardcoded 7-event list is gone.
  `model:generate`, `tick`, and every future command are uniformly available; the
  framework owns the plumbing (command hooks + the one interceptor primitive), the
  compiler _projects_ it, a dep-less compiler projects the identical source.

The one discipline (not a limitation): **`observe` is non-blocking** (fire-and-forget —
schedule the React update, return); **`transform`/`guard` run in the operation's
critical path (awaited)**, so they must decide promptly from captured state or `defer`
cleanly (the elicitation-style suspend) — they cannot hang. The exact same discipline a
programmatic interceptor has.

Two things the store did that must be preserved:

- **Catch-up.** A component mounting mid-tick must see the current `tick-start`. This
  stays as a **thin cache in the compiler** (the last `tick-start`/`execution-start`,
  replayed to late-registered observers) — but the _events_ come from real hooks, not
  a bespoke store.
- **Unsubscribe.** Registration rides component lifecycle: the interceptor is registered
  when the React hook mounts and unsubscribed on unmount (returns an `Unsubscribe`,
  cascaded per ADR 82/83).

## Consequences

- **Positive:** the model gets hooks / guard / interceptors / journaling / lifecycle
  / addressability, all standard; `withRetry`/`withFallback`/`tapModel` and the
  `LifecycleStore` + 7 `notifyLifecycle` calls are retired (net decoupling); lifecycle
  is uniformly extensible (no curated list); the loop stops knowing the reconciler's
  observation layer; swappable model with persistent gating.
- **Cost / risk:** this touches the loop's hot path (per-tick `model:generate` +
  `tick` commands), streaming-as-a-command, and **kill/resume** (the tick barrier).
  It is a dedicated foundational pass, not an interleave — guarded by the tick-ordering
  - kill/resume suite.
- **Migration:** `LanguageModelExecutor`'s `project`/`normalize` survive as pure
  transforms; `execute`/`executeStream` become the `ModelHarness` command bodies. The
  loop's `input.executor`/`input.target` threading becomes `session.model` +
  effective-model resolution. Adapter combinators are re-expressed as interceptors and
  deprecated.

## Non-goals / open questions

- The exact streaming-command envelope shape (phases + `stream:chunk` interplay) —
  finalize in implementation.
- Whether `model:set` is a full command or a plain setter (leaning command, for the
  journal + `onBeforeModelSet` policy).
- Whether `tick` lives on the loop harness or the model harness.
- The observe-vs-bus question for observers: `observe` interceptors are in-process
  (the compiler registers on the harness); the same lifecycle is also on the bus/
  journal, so a remote observer (a different process) subscribes to the bus. Both are
  projections of the ONE source (the operation's command lifecycle); in-process
  compilers use `observe`, cross-process consumers use the bus. Confirm the split.
