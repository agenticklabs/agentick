# @agentick/core

## 0.3.0

### Minor Changes

- d38460c: Add ExecutionEnvironment, SessionRef, SpawnOptions, async close()

  - ExecutionEnvironment interface with 6 optional hooks: prepareModelInput, executeToolCall, onSessionInit, onPersist, onRestore, onDestroy
  - SessionRef narrow interface for environment lifecycle hooks (avoids generic type friction)
  - SpawnOptions (3rd arg to session.spawn()) for overriding model, environment, maxTicks
  - session.close() is now async (Promise<void>) — properly awaits onDestroy, child closes, compiler unmount
  - createTestEnvironment() with function interceptor support in @agentick/core/testing
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
