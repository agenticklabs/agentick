# ADR 67 — Loop continuation as a two-tier predicate decision, owned by the session

**Status:** ACCEPTED 2026-07-08 (Fable, for Ryan). **Supersedes** the deferred "gates as
session continuation predicate" note (task #29) with a broader unification. **Builds on:**
ADR 53 (steering / `TickEndForwardDecision`), the gates core (`GatesController`), ADR 51
(provenance — who may halt).

## The problem: continuation control is fragmented

At each tick-end today, whether the loop keeps going is decided by **three disconnected
authorities**, at **two different points**:

1. **Session `notifyLifecycle` → `TickEndForwardDecision`** — ADR-53 steering ("new input →
   continue"). Computed at loop step 3. Receives NO `TickResult`.
2. **`LoopBridge.continueAfterTick` / `stopAfterTick`** — what gates drive (via
   `useLoopControl`, at the _reconciler_ tick-end, step 6). The interface even says
   "whether the loop honors them is governed by the loop's handler chain" — and the loop's
   `wantsContinue` reads only (1) + `tool_use`, so this channel's path into the decision is
   murky.
3. **The loop's own default** — `tool_use → continue`, `&& ticks < maxTicks`.

Gates sit on the channel (2) whose wiring into the real decision is least clear, a tick
behind the decision (3-then-6), and without the `TickResult` their predicates need.

## The model: one decision, every input a predicate

Collapse all three into **one continuation decision**, computed at the session's tick-end
hook, enriched with the typed `TickResult`. Every input is a predicate in one of two tiers:

- **Tier 1 — hard stop-forcers** (any → STOP): `maxTicks`, `abort`, explicit
  `stopAfterTick`. The runaway guard + a trusted-host halt. Override everything.
- **Tier 2 — continue-forcers** (any, if no tier-1 → CONTINUE): `tool_use`, steering (new
  input), an active gate. Same species — a gate _holds the loop open_ exactly as steering
  does.
- **Tier 3 — natural stop** (default): the model is done and nothing forces either way.

```
decision = anyStopForcer(preds)     ? { kind: "stop", reason }
         : anyContinueForcer(preds) ? { kind: "continue" }
         : { kind: "stop", reason: "natural" }
```

`maxTicks` is no longer a hardcoded `&& ticks < max` — it is the flagship tier-1
predicate. The loop's ad-hoc `wantsContinue` dissolves into this resolution.

## Who may stop (provenance — ADR 51)

Stop-forcing is a **trusted** act. The **model cannot stop-force** — it only continue-forces
(via `tool_use`); when it emits `end_turn` that is the _absence_ of a continue signal
(tier-3 natural stop), not a forced stop. `stopAfterTick` is **host/tree-only** and beats an
active gate — consistent with the host-only gate `.override()`: only trusted code halts
past a gate's hold. A gate's read-only-to-the-model guarantee is preserved.

## The one structural change: flip the tick-end order

Tier-2/tier-1 predicates read _settled_ state (a tick-end effect may update a knob a gate
checks). So the tree must settle **before** the decision:

**reconciler tick-end (settle tree + other `useOnTickEnd`) → session continuation decision
(predicates).**

Today it is reversed (session decision at step 3, reconciler tick-end at step 6). Flipping
this is the load-bearing mechanical change. `NotifyTickEndInput.result` is enriched from
`unknown` to the typed `TickResult` (the loop already has it).

## Consequences

- Gate evaluation moves out of the reconciler `LifecycleStore` into the session's
  continuation decision. `useGate` collapses to **descriptor registration only**;
  `<GatesRuntime/>` disappears; gates evaluate session-level with `TickResult`, no mount.
- `LoopBridge.continueAfterTick`/`stopAfterTick` become **contributors to the decision**
  (continue-forcer / tier-1 stop-forcer) rather than a parallel murky channel.
- Steering (ADR 53) becomes one built-in continue-forcer; `maxTicks`/`abort` built-in
  stop-forcers; `tool_use` a built-in continue-forcer.

## Scope (build vs future)

- **Build now:** the FIXED composition of the known predicates (`maxTicks`, `abort`,
  `stopAfterTick`, `tool_use`, steering, gates) evaluated in the session's tick-end hook,
  structured so adding a predicate is a one-liner. Enrich `NotifyTickEndInput` with
  `TickResult`. Flip the tick-end order. `useGate` → registration-only.
- **Future (not now):** a _dynamic_ extension-registered predicate registry (adopters
  contribute `token-budget`, `human-approval`, etc.). YAGNI until a real third-party
  predicate appears — the fixed composition already unifies the five built-ins, which is
  the value.

## Hard parity requirements (the build must not regress)

- ADR-53 steering behavior (new-input → continue) identical.
- `maxTicks` termination identical (as a tier-1 predicate now).
- The existing gate suites (block-open semantics, verified read-only, host override) green.
- `tool_use` continuation identical.
