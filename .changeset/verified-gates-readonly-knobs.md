---
"@agentick/core": patch
---

Verified gates + read-only knobs.

`useGate` now supports two gate species, discriminated by the descriptor:

- **Latch gates** (`activateWhen`) — unchanged: edge-triggered arming, model-cleared via `set_knob`, deferrable.
- **Verified gates** (`satisfied`) — new: a code predicate (sync or async) evaluated at the end of every tick. The gate engages while the predicate fails, auto-clears the moment it passes, and re-engages if a later tick regresses the condition. `defer()` is a no-op; `clear()` is transient. The backing knob is registered read-only, so the model can observe gate state but cannot `set_knob` past a failing check — the predicate is the only authority.

A verified gate may also declare `activateWhen` as an **arming scope**: while unarmed the gate is dormant (no verification, no blocking); the first tick where the arming predicate fires arms it — sticky for the execution — and verification takes over the same tick. Use it for conditional invariants ("once files were edited, the typecheck must pass").

Knobs gain a `readOnly` option: model-visible but not model-settable. `set_knob` rejects read-only knobs by name and skips them in group writes (erroring when the whole group is read-only); the `useKnob` setter and application code remain unrestricted. Read-only knobs render with a `read-only` hint in the knobs section.

New exports: `LatchGateDescriptor`, `VerifiedGateDescriptor` (with `GateDescriptor` now the union of both).
