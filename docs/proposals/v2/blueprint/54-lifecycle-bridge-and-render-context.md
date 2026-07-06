# ADR 54 — The lifecycle bridge + render-context model info

**Status:** RATIFIED 2026-07-05 (Ryan) — build (a) + render-context
**Depends on:** ADR 03 (reconciler harness), ADR 53 (per-generation usage),
#204 (ModelInfo registry + useContextInfo), #169 (per-tick tree-declared models — future)
**Supersedes:** #204's async-hook `useContextInfo` window path

## TL;DR

The `useOn*` lifecycle-hook family (`useOnTickStart/End`,
`useOnExecutionStart/End`, `useContextInfo`) was **inert in production**:
nothing fed the reconciler's lifecycle store during a real run, and the
one consumer (`useContextInfo`, #204) read a window that was never
produced. The integration gate (#206) exposed TWO distinct problems, and
the second is a genuine architecture correction:

1. **Registration timing.** Hooks register via `useEffect`, which React
   flushes on `setImmediate` (async). `mount` resolved `mountReady`
   WITHOUT flushing passive effects, so listeners weren't live when the
   loop's first tick dispatched. → **`mount` flushes passive effects
   before `mountReady` resolves.** Targeted, uncontroversial.

2. **The window cannot reach the CURRENT render via async lifecycle
   setState.** tick-start → hook `setState(window)` is React-async;
   the reconciler's `renderTree` is synchronous (`flushSyncWork`). The
   setState never propagates into the same tick's IR — so a
   compaction component reading `useContextInfo().contextWindow` during
   render sees stale/absent data, and the IR is built against the wrong
   window. → **model info that must affect the CURRENT render is a
   synchronous INPUT to the render (render-context), not something
   observed after it.**

## The two subjects, split by tense

- **Current-tick facts** (contextWindow, active model): the render must
  react to them WHILE producing the IR. They are **render-context** —
  resolved by the session before/at the render and provided as a
  synchronous React context value. "The IR is the source of truth for
  the active model" (Ryan): the window is derived from the tick's model
  and threaded into the pass that produces the IR.

- **Past facts** (usedTokens, last outcome): historical, non-blocking.
  They flow via the **async lifecycle bridge** (the loop dispatches
  `tick-end`/`execution-end` to `reconciler.notifyLifecycle`; hooks fire
  reactively). One-tick-behind is correct — it's history.

`useContextInfo` merges the two: window from render-context (synchronous,
current), usedTokens from the lifecycle bridge (async, prior);
`utilization = usedTokens / window`.

## Design

### (a) mount flushes passive effects
`ReconcilerHarness.mount` awaits a passive-effect flush after the initial
render's commit, before resolving `mountReady`. This makes every
`useEffect`-registered lifecycle listener live before the first tick.
Uses react-reconciler's passive-effect flush (or a scheduled
setImmediate turn if the sync flush isn't exposed).

### (b) render-context for current model info
- `RenderTreeInput` (and `MountInput`) gains an optional
  `contextInfo?: { contextWindow?: number; usedTokens?: number }` — the
  session resolves it per render via `effectiveModelInfo(activeModel,
  models)` and passes it in.
- The reconciler provides it via a `ContextInfoContext` React provider
  (sibling to `LifecycleContext` / `BridgeProvider`), refreshed each
  render.
- `useContextInfo` reads that context SYNCHRONOUSLY for the window (+
  usedTokens if provided), and still layers the async lifecycle bridge
  for post-render usage updates. No async setState race; deterministic
  in-render.

### The lifecycle bridge (the async half — the producer)
- The loop dispatches `tick-start` (awaited, pre-render),
  `tick-end`/`execution-end` to `reconciler.notifyLifecycle` with
  `{ usage }` metadata (session-supplied via the run input). Lights up
  the WHOLE `useOn*` family, not just context info.
- Session is the resolver of both the render-context (window) and the
  bridge metadata (usage) — it owns target + injected `models` + the
  reconciler + mountId. Mirrors v1 `Session.broadcastContextInfo`.

### models injection
`models?: ModelRegistry` on app/gateway/session options, merged over
SEED_MODELS (the federated-registry decision, #206). No spec dependency
on model-next — the resolved window rides `contextInfo` (plain numbers)
and the lifecycle metadata bag (already open).

### force-render on model change (#169, future)
Under #169 the active model is IR-derived (post-render). A model change
then re-resolves the render-context window and the stabilization loop
re-renders to convergence — no async coordination needed, because the
window is a render INPUT. Marked `TODO(trail-per-tick-model)`. Today the
model is construction-bound (`session.target`) → stable across ticks.

## Rejected

- **Async-hook window path (#204 as merged).** `useContextInfo` window
  via `setState` from a tick-start lifecycle dispatch — races the
  synchronous reconciler render; the window never reaches the current
  IR. This is exactly what the gate disproved.
- **Loop-side effect flush per tick.** Yielding to `setImmediate` in the
  loop before each dispatch to let effects register — fragile, hot-path
  cost, and doesn't fix the window-in-render race (only registration).
  The mount-time flush (a) handles registration once.

## Tests

The integration gate (`session/__tests__/lifecycle-bridge.spec.tsx`) is
the regression proof: a REAL loop run must make `useOnTickEnd` fire and
`useContextInfo` yield a live window + utilization DURING render. Its
absence is why the dead bridge shipped green — every prior lifecycle
test injected at the store/harness boundary by hand.

## Scope
(a) + the render-context window + the lifecycle bridge + models injection
= this ADR, hands-on (reconciler-render coordination). Adapter data
fragments (#206) delegable. #169 force-render is a later wiring.
