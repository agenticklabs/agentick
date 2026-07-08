# @agentick/gates-next

**Gates — knob-backed continuation conditions.** A gate blocks loop
completion until it is cleared, giving an agent a checkpoint the run cannot
skip: "don't finish until the model has attested X," or "don't finish while
the typecheck is failing." Gates are a **pattern over knobs**, not a new
subsystem — a gate's value IS a knob value, so everything the knobs primitive
gives you (model-visible state, per-value subscription, snapshot/restore)
comes for free.

This package is the second demonstration of the v2 thesis that **React is a
binding over a programmatic core** (knobs was the first). There is no "React
gate" and "server gate" — there is one `GatesController` holding the registry
and the verification wiring, and `useGate` is a thin binding over it. Every
gate a tree declares via `useGate` and every gate declared programmatically
via `session.gates.register(...)` lands in the **same** controller registry,
evaluated by the **same** tick-end wiring. `session.gates.list()` shows all of
them.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## What it is

A gate has a `description`, model-facing `instructions` (rendered while the
gate is engaged), and one predicate. Two species, discriminated by which
predicate you supply:

- **Latch gates** (`activateWhen`) — **edge-triggered, model-cleared.** The
  arming predicate is consulted only while the gate is `inactive`; once it
  fires, the gate flips to `active` and stays engaged until the **model**
  clears it (`set_knob`) or the **host** calls `clear()`. Use when the
  condition is not checkable in code and the model must attest ("confirm you
  have summarized the findings before finishing").

- **Verified gates** (`satisfied`) — **level-triggered, code-cleared.** The
  predicate is evaluated at the end of **every** tick: the gate engages
  whenever it returns `false` and clears automatically the moment it returns
  `true`, re-engaging if a later tick regresses. Use for invariants code can
  check ("the typecheck must pass," "a validated submission must exist"). An
  optional `activateWhen` **arms** the obligation so it only applies once
  something made it relevant.

Values are the three-state `GateValue`: `"inactive" | "active" | "deferred"`
(verified gates use only `inactive`/`active`).

### The unforgeable guarantee

A verified gate registers its backing knob **read-only**. The model can
_read_ the gate's state in the `<Knobs />` section but `set_knob` **rejects**
writes to it — the predicate is the only authority. The model cannot knob
itself past a failing check. This is not advisory; it is enforced by the same
validation pipeline that guards every read-only knob, and it is covered by an
adversarial test (`gate.spec.tsx`, `controller.spec.ts`).

### Fail-closed

A verified predicate that **throws** is treated as **unsatisfied** — the gate
engages. The lifecycle store isolates handler errors (logs, does not
propagate), so without fail-closed a broken verifier would silently let the
loop complete unverified. Fail-closed makes a broken check block, not pass.

## Quick start — React (`useGate`)

```tsx
import { useGate, gate } from "@agentick/gates-next/react";

const typecheckGate = gate({
  description: "Typecheck must pass after edits",
  instructions: "GATE: run the typecheck and fix errors before finishing.",
  activateWhen: (r) => r.toolResults.some((t) => t.toolName === "edit_file"),
  satisfied: async (r) => (await runTypecheck()).ok,
});

function Agent() {
  const { element } = useGate("typecheck", typecheckGate);
  return (
    <>
      <System>You are a coding agent.</System>
      {/* Render last — the model sees the instructions right before its reply */}
      {element}
    </>
  );
}
```

`useGate` returns `{ active, deferred, engaged, clear, defer, element }`.
`element` is a `<section>` rendered only while the gate is `active`.

## Quick start — programmatic (`session.gates`)

Everything `useGate` does from the tree, host/adopter code does from the
session. Same controller, same registry, same wiring:

```ts
// Register a latch gate that must be attested before the run finishes.
const handle = session.gates.register("summary", {
  description: "Await summary",
  instructions: "Summarize the findings before completing.",
  activateWhen: (r) => r.toolResults.length > 0,
});

session.gates.list(); // → [{ name: "summary", value, verified, description }, …]
session.gate("summary")?.value; // → "inactive" | "active" | "deferred"

handle.clear(); // host-side release (equivalent to the model clearing a latch)
```

A tree-declared `useGate` gate and a programmatic gate both appear in
`session.gates.list()` — one registry.

### Host `.override()` — the trusted-host escape (verified gates)

Verified gates are code-cleared and read-only to the model. A **host**
override is legitimate (the host is trusted) but is an **explicit, audited**
escape — never a silent setter that reopens the read-only protection:

```ts
const g = session.gate("typecheck");
g?.override("inactive", "manual unblock: known-flaky check");
```

`override()` sets the value **and** emits a `session:gate:override` audit
event on the session bus (traceable via `app.events()`); it **throws** on a
latch gate (use `clear()` there). It is reachable only from host code — the
model's `set_knob` path stays refused by the read-only knob.

## How the two front-ends converge (architecture)

```
              gate() descriptor  (pure data — no reconciler)
                       │
        ┌──────────────┴───────────────┐
   useGate (React)              session.gates (programmatic)
        │  register / read              │  register / get / list / clear
        └──────────────┬───────────────┘
                 GatesController         ← ONE registry, ONE wiring
                 (knobs · loop)
```

The `GatesController` (in the reconciler-agnostic package root) holds the gate
registry and the `handleTickEnd` pass that arms, evaluates, fails closed,
auto-clears, and drives loop continuation. It takes its collaborators
**injected**:

- `knobs` — register/set/get/subscribe the backing knob.
- `loopControl` — block/continue the loop.
- `audit` — sink for the `.override()` escape.

**Evaluation is driven, not subscribed (ADR 67).** The session's continuation
decision — `session.notifyLifecycle` — calls `controller.handleTickEnd(result)`
once per tick with the settled `TickResult` (executed tool results +
`shouldContinue`), AFTER the reconciler tick-end has settled the tree. A
blocking gate calls `continueAfterTick` on the injected loop seam; the session
drains it and folds the hold into its `TickEndForwardDecision`. There is **no**
per-mount tick-end subscription and **no** `<GatesRuntime />` — the reconciler
owns no gate wiring, and programmatic-only gates evaluate identically to
tree-declared ones (both live in the same session-owned controller). `useGate`
is therefore **registration-only**: register on mount, unregister on unmount,
reflect the knob value.

Gates is **not a harness**: it owns no independent state (a gate's value is a
knob value), so it gets no `HookBridges` harness slot and is not snapshot-
captured. The controller rides the existing `BridgeContext` — a
reconciler-react React context — as a runtime transport property, which is how
`session.gates` and every `useGate` resolve the same instance.

### Layer-aware resolution (app tier — a future layer the seam enables)

The controller optionally resolves over an ordered `[parent, self]` layer
chain (ADR 34 cascade). A `parent` `GatesParentLayer` supplies **inherited**
gates: `get` / `list` unify across the chain with **self shadowing parent by
name**, and this controller's tick-end pass evaluates self gates **and** the
inherited ones (the parent owns no tick-end source of its own — a child layer
drives it, against the child's tick, in the parent's own knob + loop layer).
Shadowed names are evaluated once, by the effective (self) gate.

Today the parent is **absent everywhere** — no app tier exists yet, so the
session constructs its controller with `parent: undefined` and the chain is
just `[self]` (behavior byte-identical to no chain). The seam is present,
unused: a future **app-scoped** gate layer drops in as the session
controller's `parent` with no rewrite, and app-declared gates then evaluate
through each session's tick automatically.

## API

### Root (`@agentick/gates-next`) — reconciler-agnostic

- `gate(descriptor)` — trivial descriptor factory (declare at module scope).
- `isVerifiedGate(descriptor)`, `GATE_OPTIONS`, `VERIFIED_GATE_OPTIONS`.
- Types: `GateDescriptor`, `LatchGateDescriptor`, `VerifiedGateDescriptor`,
  `GateValue`.
- `GatesController` + `GatesControllerDeps`, `GatesParentLayer`, `GateKnobs`,
  `LoopControlSeam`, `GateOverrideAudit`, `GateInfo`, `GateHandle`,
  `GatesHandle`.

### `/react`

- `useGate(name, descriptor): GateState` — the React front-end.
- `useGates(): GatesHandle` — the in-scope gates surface (the SAME curated
  shape `session.gates` exposes: `register`/`get`/`list`/`clear`). Mirrors
  `useKnob` → `session.knobs`. The raw `GatesController` is intentionally
  **not** returned — `Controller` is an internal impl surface, not a public v2
  noun (the vocabulary is Harness/Bridge/Handle/Store).
- `<GatesProvider>`, `GatesContext` — controller resolution (rarely needed
  directly; the session transports its controller on the bridge bundle).

### `/testing`

- `fakeGatesController(knobs?)` — a working controller over stub knobs + a spy
  loop-control seam + a recorded audit sink; `.tick(result)` drives the shared
  wiring with no live mount.
- `spyLoopControl()` — a `LoopControlSeam` that records continue/stop calls.

### Session surface (augmented onto `SessionHarnessProtocol`)

- `session.gates` — `GatesHandle` (`register`/`get`/`list`/`clear`).
- `session.gate(name)` — `GateHandle | undefined`.

## Verified by

Every claim above is exercised by a test:

| Claim                                                                                                 | Test                                           |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Latch arms on trigger, blocks the loop, `clear()` releases                                            | `controller.spec.ts`, `gate.spec.tsx`          |
| Latch does not re-arm once engaged; `deferred` un-defers when blocking                                | `controller.spec.ts`, `gate.spec.tsx`          |
| Verified engages when unsatisfied, auto-clears on pass, re-engages on regression                      | `controller.spec.ts`, `gate.spec.tsx`          |
| Verified arming scope stays dormant until triggered                                                   | `controller.spec.ts`, `gate.spec.tsx`          |
| Fail-closed: a throwing predicate engages the gate                                                    | `controller.spec.ts`, `gate.spec.tsx`          |
| Verified knob is read-only — the model's `set_knob` dispatch is refused (adversarial)                 | `controller.spec.ts`, `gate.spec.tsx`          |
| `.override()` releases a verified gate AND emits an audit envelope; throws on latch; not a model path | `controller.spec.ts`                           |
| Async verified predicates are awaited                                                                 | `gate.spec.tsx`                                |
| Layer chain: `list`/`get` unify over a parent, self shadows parent by name                            | `controller.spec.ts`                           |
| An inherited (parent) gate still evaluates against the child's tick (parent's own knob + loop)        | `controller.spec.ts`                           |
| A self gate shadows a same-named parent gate during evaluation (parent skipped)                       | `controller.spec.ts`                           |
| Unified registry: tree-declared + programmatic gates both in `session.gates.list()`                   | `session/__tests__/gates-integration.spec.tsx` |
| Single construction site: `useGate`'s controller IS `session.gates` (reference equality)              | `session/__tests__/gates-integration.spec.tsx` |
| `useGate` (registration-only) → controller evaluates: arm/verify/block/defer/clear/read-only          | `gate.spec.tsx`                                |
| Real execution: `session.notifyLifecycle` evaluates both gates AND they HOLD the loop to `maxTicks`   | `session/__tests__/gates-integration.spec.tsx` |

## Status & roadmap

Shipping. The core wiring, both front-ends, the read-only guarantee, the
host override, and the unified registry are complete and tested.

Gates evaluate session-side (ADR 67): `session.notifyLifecycle` drives
`controller.handleTickEnd` with the settled `TickResult` and folds a gate's
hold into the loop's continuation decision. No `<GatesRuntime />`, no per-mount
tick-end subscription — tree-declared and programmatic gates evaluate
identically. A gate is a **continue-forcer**: it holds the loop open exactly as
steering does, under the loop's `maxTicks` hard cap.

Known gaps / trailheads:

- **App-tier gate layer** (`GatesParentLayer`) is a present-but-unused seam —
  no app-scoped controller exists yet, so the session constructs its controller
  with `parent: undefined`. A future app layer drops in as the session
  controller's `parent` with no rewrite.
