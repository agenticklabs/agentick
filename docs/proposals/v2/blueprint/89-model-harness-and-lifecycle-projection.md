# ADR 89 — The model is a harness; lifecycle is the projected command-hook system

**Status:** PROPOSED 2026-07-21 (for Ryan)
**Builds on:** ADR 26 (everything is a harness), ADR 80 (command-lifecycle hooks),
ADR 83 (one interceptor primitive — guard / transform / **observe**), ADR 55
(React lifecycle hooks).
**Amends:** the reconciler's bespoke `LifecycleStore` + the loop's hand-fed
`notifyLifecycle` (both retired).

## TL;DR

Two gaps, one root cause. (1) The **model is not a harness** — it's a procedure
pipeline (`project → execute → normalize` via `executor.fx`), so the model call is
a *procedure, not a command*: no `model:generate` hooks, no guard, no journal
entry, and the adapter combinators (`withRetry`/`withFallback`/`tapModel`) are a
**bespoke middleware layer reinvented** because there's no harness to `.use()` on.
(2) The reconciler's **`LifecycleStore` is a hand-curated 7-event subset**, fed by
~7 hard-coded `loop.notifyLifecycle(...)` calls — a bespoke observation mechanism
the compiler owns instead of *projecting* the framework's.

Both dissolve into one decision: **the model becomes a harness whose `execute` is
the `model:generate` command; `tick` becomes a command; and React lifecycle hooks
are the compiler registering ADR-83 interceptors (`observe` / `transform` / `guard`)
on the constituent command harnesses — the same hooks a user declares
programmatically.** A `useOn*` hook registers a callback (closing over component
state via a ref), not a render, so it can observe, reshape, OR veto/defer an
operation — components become full lifecycle participants. No bespoke lifecycle
store; any command is observable and interceptable; the model finally gets hooks, a
guard, interceptors, journaling, and a **swappable backing model** on a
session-persistent harness.

## Context

- **The model call is a procedure.** `LanguageModelExecutor` (`@agentick/executor-next`)
  is not a `BaseHarness`; the loop calls `tickExecutor.fx.executeStream(...)` per
  tick. `generate`/`generateStream` are free functions in `@agentick/model-next`.
  Nothing wraps the model call in `this.command(...)`, so ADR 80 never mints
  `onBefore/AfterModelGenerate`.
- **Consequences of the model escaping ADR 26:**
  - `withRetry`/`withFallback`/`tapModel` = middleware reinvented per-adapter,
    because there is no harness to carry `.use()`/interceptors.
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

Why it happened: the executor was designed as a **pure transform** before "everything
is a harness" + "command hooks ARE the lifecycle" crystallized. It is the last major
subsystem outside the harness model.

## Decision

### 1. The model is a harness; `execute` is `model:generate`

A `ModelHarness extends BaseHarness<"model">` (session-scoped, one per session).
Its command is the model call:

- **`model:generate`** and **`model:generate_stream`** — declared commands
  (`this.command(...)`), so ADR 80 mints `onBefore/AfterModelGenerate[Stream]`. The
  command body is the model call; the streaming variant is a **streaming procedure**
  (procedures already emit `stream:chunk` — `onBefore` at start, chunks in the
  middle, `terminal`/`onAfter` at end).
- **`project` and `normalize` STAY pure transforms** — they are stateless and do
  not deserve command machinery. The harness *composes* them around the
  `execute` command; only the side-effecting model call is the command. (Don't
  harness-ify the pure parts.)
- **What falls out, all standard, nothing bespoke:**
  - Interceptors: `withRetry`/`withFallback`/`tapModel` collapse into
    `model.use(...)` (ADR 83 `transform`/`observe`) — retire the bespoke adapter
    combinators.
  - **`guardGenerate`**: `model.guard(decide)` — `proceed | veto | replace | defer`
    on a model call (cost ceiling, safety veto, replay/mock `replace`).
  - Journaling: model calls become journaled operations (audit: model, tokens, timing).
  - Addressability: the model harness is inbox-addressable (cluster: route a
    generate to a model node).
  - Lifecycle: `useOnModelGenerateStart` = `onBeforeModelGenerate` (§4).

### 2. Swappable backing model on a persistent harness

The harness persists for the **session**; the backing `{ adapter, target }` is
**swappable** at runtime:

- **`session.model.setModel(adapter, target?)`** (and `setTarget(target)`) — swaps
  the backing model. Declared as a command **`model:set`** so it is journaled and
  hookable (audit model swaps; `onBeforeModelSet` for policy — "this session may not
  switch to model X").
- **Hooks / guards / interceptors are registered on the harness, NOT the adapter**,
  so they **persist across `setModel`**. Register a cost guard + a retry interceptor
  once; swap `gpt-5` → `claude` → `fable` freely for the whole session; the gating
  and middleware stay. This is the win the procedure pipeline can't give — today
  swapping the model means threading a different executor per tick and re-composing
  any middleware on the adapter.
- **Effective-model precedence** (like tool-binding precedence): per-tick
  `<Model model={…}>` (reconciler slice) > per-send `send({ executor, target })`
  override > the session default set by `setModel`. `setModel` sets the session
  default; the scoped forms select for their scope. The harness resolves the
  effective `{ adapter, target }` per `generate`. (Detail to finalize in
  implementation; the invariant is: harness identity + interceptors persist,
  model selection is scoped.)

### 3. `tick` becomes a command

The per-tick model round is wrapped as a command (`loop:tick` or on the model/loop
harness) so it mints `onBefore/AfterTick` and emits phases like every other op.
**The tick barrier is preserved via the operation terminal**: the loop `await`s the
tick command's terminal (the tree-settle barrier `notifyLifecycle("tick-end")`
currently provides) instead of a hand-coded await. This is the load-bearing part —
kill/resume and tick ordering must survive the wrapping.

### 4. Lifecycle = the compiler projecting the FULL command-hook system (ADR 83)

There is **no bespoke `LifecycleStore`**. React lifecycle hooks are the compiler
registering **ADR-83 interceptors** on the constituent command harnesses — the
*exact* mechanism a user uses programmatically. A `useOn*` hook does NOT register a
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
  compiler *projects* it, a dep-less compiler projects the identical source.

The one discipline (not a limitation): **`observe` is non-blocking** (fire-and-forget —
schedule the React update, return); **`transform`/`guard` run in the operation's
critical path (awaited)**, so they must decide promptly from captured state or `defer`
cleanly (the elicitation-style suspend) — they cannot hang. The exact same discipline a
programmatic interceptor has.

Two things the store did that must be preserved:

- **Catch-up.** A component mounting mid-tick must see the current `tick-start`. This
  stays as a **thin cache in the compiler** (the last `tick-start`/`execution-start`,
  replayed to late-registered observers) — but the *events* come from real hooks, not
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
  + kill/resume suite.
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
