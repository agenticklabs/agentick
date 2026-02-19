# @agentick/core

## 0.8.0

### Patch Changes

- @agentick/kernel@0.8.0
- @agentick/shared@0.8.0

## 0.7.0

### Minor Changes

- c73753e: Sync all packages to 0.7.0.

  **Connector system** — New `@agentick/connector` package with platform integration primitives. Initial adapters for iMessage and Telegram.

  **CompletionSource redesign** — `@agentick/client` CompletionSource API uses match/resolve pattern.

  **MessageSource registry** — Typed message provenance tracking in `@agentick/shared`, used by connectors.

  **Gateway fix** — Re-resolve closed sessions after idle eviction.

  **Content blocks fix** — Pass all content block types through DefaultPendingMessage.

  **Testing utilities** — `createMockClient()` decoupled from vitest. Pass `vi.fn` or `jest.fn` as `fn` parameter for spy-wrapped methods.

  **Knobs documentation** — Accordion pattern for conditional context rendering.

### Patch Changes

- @agentick/kernel@0.7.0
- @agentick/shared@0.7.0

## 0.6.0

### Minor Changes

- 4750f5e: Tool call summaries and file confirmation with diff preview.

  Tools can define `displaySummary` to provide a short description (e.g., file
  path, command) that appears in stream events and TUI indicators.

  File modification tools (`write_file`, `edit_file`) now require confirmation
  before execution. A new `confirmationPreview` hook computes a unified diff
  that renders in the TUI confirmation prompt.

  Fixed: session confirmation channel wiring (was previously unconnected).

### Patch Changes

- e30960c: Auto-resume session on send when session exists but is not running.
- Updated dependencies [4750f5e]
  - @agentick/shared@0.6.0
  - @agentick/kernel@0.6.0

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

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/kernel@0.4.0
  - @agentick/shared@0.4.0

## 0.3.0

### Minor Changes

- d38460c: Add ExecutionRunner, SessionRef, SpawnOptions, async close()
  - ExecutionRunner interface with 6 optional hooks: prepareModelInput, executeToolCall, onSessionInit, onPersist, onRestore, onDestroy
  - SessionRef narrow interface for runner lifecycle hooks (avoids generic type friction)
  - SpawnOptions (3rd arg to session.spawn()) for overriding model, runner, maxTicks
  - session.close() is now async (Promise<void>) — properly awaits onDestroy, child closes, compiler unmount
  - createTestRunner() with function interceptor support in @agentick/core/testing
  - Dead code cleanup: removed obsolete streaming accumulation and processStream from EngineModel

## 0.2.1

### Patch Changes

- 07b630c: Upgrade to React 19 and react-reconciler 0.33. useComState now uses useSyncExternalStore for correct external state synchronization. Clean up dead code from reconciler migration.
- Updated dependencies [07b630c]
  - @agentick/kernel@0.2.1
  - @agentick/shared@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/kernel@0.2.0
  - @agentick/shared@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/kernel@0.1.9
  - @agentick/shared@0.1.9
