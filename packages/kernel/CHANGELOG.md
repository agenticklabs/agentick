# @agentick/kernel

## 0.14.2

### Patch Changes

- @agentick/shared@0.14.2

## 0.14.1

### Patch Changes

- @agentick/shared@0.14.1

## 0.14.0

### Patch Changes

- @agentick/shared@0.14.0

## 0.13.2

### Patch Changes

- @agentick/shared@0.13.2

## 0.13.1

### Patch Changes

- @agentick/shared@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [8e568d1]
  - @agentick/shared@0.13.0

## 0.12.3

### Patch Changes

- badc15b: Fix EventBuffer dual-consumption bug where multiple async iterators on the same buffer caused duplicate and missed events. The shared waiter mechanism now wakes all iterators and each reads from the buffer at its own index.

  Gateway plugin routes now enforce auth by default. Plugins can opt out with `{ auth: false }`. Auth enforcement centralized in `dispatchPluginRoute()` covering both embedded and HTTP transport paths. Added `validateAuth()` to `PluginContext` for custom plugin auth logic.

  - @agentick/shared@0.12.3

## 0.12.2

### Patch Changes

- @agentick/shared@0.12.2

## 0.12.1

### Patch Changes

- @agentick/shared@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [2435355]
  - @agentick/shared@0.12.0

## 0.11.2

### Patch Changes

- @agentick/shared@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [336c439]
  - @agentick/shared@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [10023a7]
  - @agentick/shared@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [84a0400]
  - @agentick/shared@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [619c448]
  - @agentick/shared@0.10.0

## 0.9.6

### Patch Changes

- 84752df: Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.
- Updated dependencies [84752df]
  - @agentick/shared@0.9.6

## 0.9.5

### Patch Changes

- @agentick/shared@0.9.5

## 0.9.4

### Patch Changes

- @agentick/shared@0.9.4

## 0.9.3

### Patch Changes

- @agentick/shared@0.9.3

## 0.9.2

### Patch Changes

- 7b45b0d: Gracefully skip pino-pretty when not installed instead of crashing on logger initialization.
  - @agentick/shared@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [d3f9b8d]
  - @agentick/shared@0.9.0

## 0.8.0

### Patch Changes

- @agentick/shared@0.8.0

## 0.7.0

### Patch Changes

- @agentick/shared@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [4750f5e]
  - @agentick/shared@0.6.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/shared@0.4.0

## 0.2.1

### Patch Changes

- 07b630c: Upgrade to React 19 and react-reconciler 0.33. useComState now uses useSyncExternalStore for correct external state synchronization. Clean up dead code from reconciler migration.
- Updated dependencies [07b630c]
  - @agentick/shared@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/shared@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/shared@0.1.9
