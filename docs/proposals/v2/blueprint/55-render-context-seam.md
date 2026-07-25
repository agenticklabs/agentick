# ADR 55 — The render-context seam (generalize `contextInfo`; complete the lifecycle bridge)

**Status:** PROPOSED 2026-07-05 (Fable, for Ryan)
**Depends on:** ADR 03 (reconciler harness), ADR 54 (lifecycle bridge + render-context),
#204 (ModelInfo registry), #206 (lifecycle producer)
**Enables:** #169 (per-tick tree-declared model), budget-aware rendering (#186 spine),
per-principal context shaping (Slice 5 authz), self-correction loops
**Generalizes:** ADR 54's bespoke `contextInfo` field into an augmentation seam

## TL;DR

ADR 54 established that the runtime and the tree talk over **two channels, split
by tense**:

- **render-context** (synchronous, forward-looking) — facts about *this* render
  the tree reads *while producing the IR*;
- **lifecycle bridge** (async, backward-looking) — things that *happened* that the
  tree reacts to after the fact.

ADR 54 shipped each channel at the narrowest width that closed #206: render-context
carries exactly `contextInfo?: { contextWindow?, usedTokens? }` — a single hand-typed
field on `MountInput`/`RenderTreeInput`; the lifecycle bridge dispatches exactly
`tick-start`/`tick-end` to `reconciler.notifyLifecycle`. Both are correct. Both are
**under-built** relative to the seam they instantiate, and the under-build is now
load-bearing:

1. **`contextInfo` is a one-off, not a seam.** Every new current-tick fact (active
   model, budget-so-far, tick#, deadline, principal, last stop-reason) would widen
   `RenderTreeInput` again — a spec edit per fact, with no place for a package to
   contribute its own. That is exactly the shape `HookBridges` and `WireMethods`
   refused: they are **empty-seed envelopes packages augment**. Render-context has
   no envelope.

2. **The lifecycle bridge is half-wired.** The loop dispatches `tool-dispatch-start/end`,
   `execution-start/end`, and `error` to the **stream** (`input.onEvent`) but NOT to
   `reconciler.notifyLifecycle`. So `useOnExecutionStart`, `useOnExecutionEnd`, and
   `useOnError` **already exist as hooks and are inert** — same dead-bridge class ADR 54
   fixed for ticks, still unfixed for the rest of the family. `useOnToolStart/End`
   can't even be written: there is no tool lifecycle event in the spec union.

This ADR makes render-context a **first-class augmentation seam** (`RenderContext`)
and **completes the lifecycle bridge** so the whole `useOn*` family is live. Together
these turn the seam from "the window plumbing" into "the substrate for self-observing,
adaptive agents" — where the rendered context is a function of the agent's own
execution telemetry.

## The seam, precisely (as it exists after ADR 54)

```
                        ┌───────────────────────── the tree (JSX/IR) ─────────────────────────┐
   runtime (session +   │                                                                       │
   loop-executor)       │   useContextInfo()          useOnTickEnd()   useOnError()  ...        │
        │               │        ▲ sync                    ▲ async         ▲ async              │
        │               └────────┼────────────────────────┼───────────────┼─────────────────────┘
        │                        │                         │               │
        │   renderTree({ ...,    │                         │               │
        │     contextInfo })  ───┘  RenderContextContext    │               │
        │                        (synchronous render INPUT) │               │
        │                                                   │               │
        └── reconciler.notifyLifecycle({ event }) ──────────┴───────────────┘
                              (async LifecycleStore → useOn* hooks)
```

- **render-context** is a *render input*: resolved by the session, threaded through the
  loop into `renderTree`, provided by the reconciler as a React context, read
  **synchronously** during the render. It answers *"what is true for the render I am
  about to produce?"* — so the IR can be built as a function of it. Forward-looking.
- **lifecycle bridge** is a *reaction channel*: the loop dispatches lifecycle events to
  `reconciler.notifyLifecycle`, the per-mount `LifecycleStore` fans them to `useOn*`
  hooks, which `setState` and drive a re-render. It answers *"what just happened?"* —
  history the tree reacts to. Backward-looking. One-tick-behind is correct.

The split is not incidental — it is *the* invariant. A fact that must shape the current
IR (window, active model) MUST ride render-context; routing it through the async bridge
races the synchronous render and never reaches the IR (ADR 54's core correction). A fact
that is history (usedTokens, last outcome, a tool that ran) rides the bridge.

## Gap 1 — render-context becomes an augmentation seam

### The envelope

`@agentick/spec` gains `RenderContext` — the render-input analogue of `HookBridges`.
It carries the framework's own foundational render fact (`contextInfo`) as a seeded slot
and stays open for packages to augment:

```ts
// spec-next/src/protocol/render-context.ts
export interface RenderContext {
  /**
   * The active model's window facts for THIS render (ADR 54). Framework-
   * produced by the loop/session; plain numbers, no model-next dep.
   */
  readonly contextInfo?: {
    readonly contextWindow?: number;
    readonly usedTokens?: number;
  };
}
```

Packages augment via module augmentation — identical mechanics to `HookBridges`:

```ts
// (future) model-next/src/augment.ts — the active model as a render fact (#169)
declare module "@agentick/spec" {
  interface RenderContext {
    readonly activeModel?: { readonly id: string; readonly provider: string;
                             readonly capabilities?: ModelCapabilities };
  }
}
```

`MountInput` and `RenderTreeInput` replace the bespoke `contextInfo?: {...}` field with:

```ts
readonly renderContext?: RenderContext;
```

`contextInfo` moves *inside* the envelope — one slot among future many, not the whole
surface. **No backwards-compat shim** (v2 philosophy): the field is renamed, all four
call sites (loop dispatch, harness threading, the two hooks, the tests) move together.

### The producer

The **session** is the producer — it owns `target`, the injected `models` registry, the
principal, the budget spine. It resolves the whole `RenderContext` per render. ADR 54's
`resolveContextWindow?: () => number | undefined` on `RunExecutionInput` generalizes to:

```ts
readonly resolveRenderContext?: () => RenderContext | undefined;
```

The loop threads the resolved envelope straight into `renderTree({ renderContext })` —
it stays a dumb conduit (no per-fact knowledge). The session's resolver folds every slot
it can supply (`contextInfo` from `effectiveModelInfo(target, models)`; later `activeModel`,
`budget`, `principal`). Each new fact is *"the session's resolver adds a field"* — no spec
widening, no new plumbing.

### The consumer

`ContextInfoContext` (reconciler-react) generalizes to `RenderContextContext`, a
`React.Context<RenderContext | null>` provided as a sibling to `BridgeProvider` /
`LifecycleContext`, refreshed each render. `useContextInfo` reads `.contextInfo`
(unchanged behavior). A general `useRenderContext(): RenderContext` returns the envelope;
per-slot hooks (`useActiveModel`, `useBudget`, …) are thin readers landed with their slot.

## Gap 2 — complete the lifecycle bridge

The loop already produces every lifecycle moment on `input.onEvent` (the public stream).
The fix is to *also* dispatch the missing moments to `reconciler.notifyLifecycle`, exactly
as ADR 54 did for ticks. All fire-and-forget (`void` — a hook throw must not fail the run;
the store already isolates per-listener throws).

| Moment | Stream event (exists) | Bridge dispatch (add) | Hook it lights up |
| --- | --- | --- | --- |
| execution start | `execution-start` | `{ kind: "execution-start", executionId }` | `useOnExecutionStart` (inert today) |
| execution end | `execution-end` | `{ kind: "execution-end", executionId, outcome }` | `useOnExecutionEnd` (inert today) |
| tool start | `tool-dispatch-start` | `{ kind: "tool-start", tickId, callId, name, via }` | `useOnToolStart` (**new**) |
| tool end | `tool-dispatch-end` | `{ kind: "tool-end", tickId, callId, name, outcome, durationMs }` | `useOnToolEnd` (**new**) |
| error | `error` (catch paths) | `{ kind: "error", phase, error, tickId?, executionId? }` | `useOnError` (inert today) |

Spec adds `LifecycleToolStart` / `LifecycleToolEnd` to the `LifecycleEvent` union (the
tool moment is currently representable only as `LifecycleError { phase: "tool" }` — a
failure, not the start/success). reconciler-react adds `useOnToolStart` / `useOnToolEnd`
readers over the existing `LifecycleStore` (no store change — it is already kind-agnostic).

## What lives on the seam — and the capability each unlocks

This is the point of the ADR: the seam is where **the agent observes itself**. Each fact
below is a small rider once the envelope + bridge exist — *"session resolver adds a slot"*
or *"loop bridges an event"* — not a plumbing project.

**render-context (sync, forward — shapes the current IR):**

| Fact | Slot / source | Capability unlocked |
| --- | --- | --- |
| context window | `contextInfo.contextWindow` (shipped) | adaptive compaction — compact as the window fills |
| active model | `activeModel` ← `effectiveModelInfo` (#169) | render *for the model you're about to call* — per-model tool descriptions, formatting, reasoning scaffolds |
| budget / cost-so-far | `budget` ← #186 usage→cost spine | adaptive cost control — shed context / downshift model as budget tightens |
| tick# / deadline / elapsed | `progress` ← loop | urgency injection — "tick 8, wrap up"; deadline-aware behavior |
| principal + scopes | `caller` ← Slice 5 identity | per-caller context shaping — different tools/instructions by *who* asks (multi-tenant) |
| last stop-reason | `lastStop` ← prior tick | self-correction — react to *why* the last tick stopped |

**lifecycle bridge (async, backward — react to what happened):**

| Event | Hook | Capability unlocked |
| --- | --- | --- |
| tool start/end | `useOnToolStart/End` | spinners, scratchpad updates after a search, per-tool side-effects |
| error | `useOnError` | inject corrective context after a failure |
| execution start/end | `useOnExecutionStart/End` | turn-boundary bookkeeping, cost roll-ups |
| (future) compaction / knob change | `useOnCompact` / `useOnKnobChange` | react to timeline compaction or knob flips mid-run |

The through-line: **adaptive compaction (shipped) is the first instance of a general
class.** Adaptive model routing, budget/deadline awareness, per-principal shaping, and
self-correction all live on this seam and are *all* currently blocked by the same two
gaps. Closing them makes each a rider, not a re-plumb.

## Scope of THIS ADR (the foundation, not every rider)

**In:** the `RenderContext` envelope (empty-ish seed with `contextInfo` slot); the
rename `contextInfo?` → `renderContext?` on `MountInput`/`RenderTreeInput`; the producer
generalization `resolveContextWindow` → `resolveRenderContext`; the consumer rename
`ContextInfoContext` → `RenderContextContext` + `useRenderContext`; **completing the
lifecycle bridge** (execution-start/end, error, tool-start/end dispatched to
`notifyLifecycle`); `LifecycleToolStart/End` in the spec union; `useOnToolStart/End`
hooks. The regression gate (`session/__tests__/lifecycle-bridge.spec.tsx`) extends to
assert the *full* family fires from a real run.

**Out (riders, each its own issue):** `activeModel` (#169, needs IR-derived model +
force-render), `budget` (needs #186 cost wired to the session), `caller` (needs Slice 5
identity threaded to the session render path), `progress` / `lastStop` (small, land when
a consumer wants them). Each rider is spec-additive on the envelope + one resolver line.

## Rejected

- **Keep widening `contextInfo`.** Each new fact = a spec edit on two input types, no
  package can contribute, and the field name lies (it's not just "context info" once it
  carries budget/principal). This is the exact anti-pattern `HookBridges` exists to avoid.
- **One giant `RenderContext` typed in spec with every slot hardcoded.** Couples spec to
  model-next / identity / cost types and re-creates the "spec hardcodes foundational
  slots" smell CLAUDE.md forbids. The envelope stays neutral; packages augment.
- **A second bridge object for tool/error events.** The existing `notifyLifecycle` +
  `LifecycleStore` are already kind-agnostic. Adding event kinds and dispatch calls is
  the compose-primitives move; a parallel bridge is a subsystem where a field suffices.
- **Fold render-context INTO the lifecycle bridge (one channel).** This is ADR 54's
  disproven design — async setState can't reach the synchronous render. The two-channel
  split is the invariant, not an accident.

## Tests

- Extend `session/__tests__/lifecycle-bridge.spec.tsx` (the ADR 54 integration gate) to
  assert a real run makes `useOnExecutionStart/End`, `useOnToolStart/End`, and `useOnError`
  fire — not just `useOnTickEnd`. Their silence is what let the half-wired bridge ship.
- `reconciler-react/__tests__/render-context.spec.tsx`: `useRenderContext` reads the
  envelope; `useContextInfo` still reads `.contextInfo`; an augmented slot round-trips.
- The `useContextInfo` behavior test (`use-context-info.spec.tsx`) is unchanged — the
  window-in-render invariant is preserved (regression gate on the rename).
