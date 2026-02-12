# @agentick/tui

## 0.5.0

### Minor Changes

- 156bc2f: feat: add momentary knobs + useOnExecutionEnd lifecycle hook

  Momentary knobs (`knob.momentary()`) auto-reset to default at the end of each execution.
  Use case: lazy-loaded context that the model expands on demand, with automatic token reclamation.

  New lifecycle hook: `useOnExecutionEnd(cb)` fires after the tick loop but before snapshot persistence.

  fix: fire useOnTickStart on mount tick via catch-up mechanism

  `useOnTickStart` now fires on every tick the component is alive, including the mount tick. Previously, callbacks registered during `useEffect` in `flushSyncWork()` missed the initial `notifyTickStart()`.

  refactor: rename ExecutionRunner.prepareModelInput → transformCompiled

  The runner hook now operates on `COMInput` (rich semantic structure) before `fromEngineState` flattens it to `ModelInput`, giving runners access to system messages, sections, timeline, and tools as separate semantic concepts.

  feat(tui): InputBar controlled mode, delta timeline, activity indicator support

### Patch Changes

- Updated dependencies [156bc2f]
  - @agentick/core@0.5.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/shared@0.4.0
  - @agentick/core@0.4.0
  - @agentick/client@0.4.0
  - @agentick/react@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [d38460c]
  - @agentick/core@0.3.0
