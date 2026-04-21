# @agentick/kernel

## 0.14.48

### Patch Changes

- @agentick/shared@0.14.48

## 0.14.47

### Patch Changes

- @agentick/shared@0.14.47

## 0.14.46

### Patch Changes

- @agentick/shared@0.14.46

## 0.14.45

### Patch Changes

- @agentick/shared@0.14.45

## 0.14.44

### Patch Changes

- @agentick/shared@0.14.44

## 0.14.43

### Patch Changes

- @agentick/shared@0.14.43

## 0.14.42

### Patch Changes

- @agentick/shared@0.14.42

## 0.14.41

### Patch Changes

- @agentick/shared@0.14.41

## 0.14.40

### Patch Changes

- @agentick/shared@0.14.40

## 0.14.39

### Patch Changes

- @agentick/shared@0.14.39

## 0.14.38

### Patch Changes

- @agentick/shared@0.14.38

## 0.14.37

### Patch Changes

- @agentick/shared@0.14.37

## 0.14.36

### Patch Changes

- @agentick/shared@0.14.36

## 0.14.35

### Patch Changes

- @agentick/shared@0.14.35

## 0.14.34

### Patch Changes

- @agentick/shared@0.14.34

## 0.14.33

### Patch Changes

- @agentick/shared@0.14.33

## 0.14.32

### Patch Changes

- @agentick/shared@0.14.32

## 0.14.31

### Patch Changes

- @agentick/shared@0.14.31

## 0.14.30

### Patch Changes

- @agentick/shared@0.14.30

## 0.14.29

### Patch Changes

- @agentick/shared@0.14.29

## 0.14.28

### Patch Changes

- @agentick/shared@0.14.28

## 0.14.27

### Patch Changes

- @agentick/shared@0.14.27

## 0.14.26

### Patch Changes

- @agentick/shared@0.14.26

## 0.14.25

### Patch Changes

- @agentick/shared@0.14.25

## 0.14.24

### Patch Changes

- @agentick/shared@0.14.24

## 0.14.23

### Patch Changes

- @agentick/shared@0.14.23

## 0.14.22

### Patch Changes

- @agentick/shared@0.14.22

## 0.14.21

### Patch Changes

- @agentick/shared@0.14.21

## 0.14.20

### Patch Changes

- @agentick/shared@0.14.20

## 0.14.19

### Patch Changes

- @agentick/shared@0.14.19

## 0.14.18

### Patch Changes

- @agentick/shared@0.14.18

## 0.14.17

### Patch Changes

- @agentick/shared@0.14.17

## 0.14.16

### Patch Changes

- @agentick/shared@0.14.16

## 0.14.15

### Patch Changes

- @agentick/shared@0.14.15

## 0.14.14

### Patch Changes

- @agentick/shared@0.14.14

## 0.14.13

### Patch Changes

- @agentick/shared@0.14.13

## 0.14.12

### Patch Changes

- @agentick/shared@0.14.12

## 0.14.11

### Patch Changes

- @agentick/shared@0.14.11

## 0.14.10

### Patch Changes

- @agentick/shared@0.14.10

## 0.14.9

### Patch Changes

- @agentick/shared@0.14.9

## 0.14.8

### Patch Changes

- @agentick/shared@0.14.8

## 0.14.7

### Patch Changes

- @agentick/shared@0.14.7

## 0.14.6

### Patch Changes

- 6b72302: fix: add "default" export condition to publishConfig exports

  Node's CJS resolver needs "default" or "require" in the exports map. Without it, require() throws ERR_PACKAGE_PATH_NOT_EXPORTED. Fixes intermittent crashes when nx's node executor loads packages via require().

- Updated dependencies [6b72302]
  - @agentick/shared@0.14.6

## 0.14.5

### Patch Changes

- Updated dependencies [d0e35be]
  - @agentick/shared@0.14.5

## 0.14.4

### Patch Changes

- @agentick/shared@0.14.4

## 0.14.3

### Patch Changes

- @agentick/shared@0.14.3

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
