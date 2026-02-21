# @agentick/tui

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1
  - @agentick/client@0.9.1
  - @agentick/core@0.9.1
  - @agentick/react@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [d3f9b8d]
  - @agentick/shared@0.9.0
  - @agentick/core@0.9.0
  - @agentick/client@0.9.0
  - @agentick/react@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [f84c8bb]
  - @agentick/client@0.8.0
  - @agentick/react@0.8.0
  - @agentick/shared@0.8.0
  - @agentick/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [c73753e]
  - @agentick/core@0.7.0
  - @agentick/shared@0.7.0
  - @agentick/client@0.7.0
  - @agentick/react@0.7.0

## 0.6.0

### Minor Changes

- 0350de3: Extract LineEditor as framework-agnostic class in @agentick/client. Readline-quality line editing (13 actions, kill ring, history, keybindings) now available to all platforms. Add useLineEditor hook to @agentick/react for web consumers. TUI's useLineEditor becomes a thin Ink-specific wrapper.
- 4750f5e: Tool call summaries and file confirmation with diff preview.

  Tools can define `displaySummary` to provide a short description (e.g., file
  path, command) that appears in stream events and TUI indicators.

  File modification tools (`write_file`, `edit_file`) now require confirmation
  before execution. A new `confirmationPreview` hook computes a unified diff
  that renders in the TUI confirmation prompt.

  Fixed: session confirmation channel wiring (was previously unconnected).

### Patch Changes

- e30960c: Fix ToolCallIndicator to use ToolCallEntry type from client instead of inline type.
- Updated dependencies [75960dd]
- Updated dependencies [e30960c]
- Updated dependencies [e30960c]
- Updated dependencies [0350de3]
- Updated dependencies [e30960c]
- Updated dependencies [4750f5e]
  - @agentick/client@0.5.0
  - @agentick/react@0.5.0
  - @agentick/core@0.6.0
  - @agentick/shared@0.6.0

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
