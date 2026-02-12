---
"@agentick/core": minor
"@agentick/tui": minor
---

feat: add momentary knobs + useOnExecutionEnd lifecycle hook

Momentary knobs (`knob.momentary()`) auto-reset to default at the end of each execution.
Use case: lazy-loaded context that the model expands on demand, with automatic token reclamation.

New lifecycle hook: `useOnExecutionEnd(cb)` fires after the tick loop but before snapshot persistence.

fix: fire useOnTickStart on mount tick via catch-up mechanism

`useOnTickStart` now fires on every tick the component is alive, including the mount tick. Previously, callbacks registered during `useEffect` in `flushSyncWork()` missed the initial `notifyTickStart()`.

refactor: rename ExecutionRunner.prepareModelInput → transformCompiled

The runner hook now operates on `COMInput` (rich semantic structure) before `fromEngineState` flattens it to `ModelInput`, giving runners access to system messages, sections, timeline, and tools as separate semantic concepts.

feat(tui): InputBar controlled mode, delta timeline, activity indicator support
