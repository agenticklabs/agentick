---
"@agentick/core": minor
---

feat: add momentary knobs + useOnExecutionEnd lifecycle hook

Momentary knobs (`knob.momentary()`) auto-reset to default at the end of each execution.
Use case: lazy-loaded context that the model expands on demand, with automatic token reclamation.

New lifecycle hook: `useOnExecutionEnd(cb)` fires after the tick loop but before snapshot persistence.
