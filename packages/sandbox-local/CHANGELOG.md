# @agentick/sandbox-local

## 0.14.18

### Patch Changes

- @agentick/sandbox@0.14.18

## 0.14.17

### Patch Changes

- @agentick/sandbox@0.14.17

## 0.14.16

### Patch Changes

- @agentick/sandbox@0.14.16

## 0.14.15

### Patch Changes

- @agentick/sandbox@0.14.15

## 0.14.14

### Patch Changes

- Updated dependencies [30a8174]
  - @agentick/sandbox@0.14.14

## 0.14.13

### Patch Changes

- @agentick/sandbox@0.14.13

## 0.14.12

### Patch Changes

- @agentick/sandbox@0.14.12

## 0.14.11

### Patch Changes

- @agentick/sandbox@0.14.11

## 0.14.10

### Patch Changes

- @agentick/sandbox@0.14.10

## 0.14.9

### Patch Changes

- @agentick/sandbox@0.14.9

## 0.14.8

### Patch Changes

- @agentick/sandbox@0.14.8

## 0.14.7

### Patch Changes

- Updated dependencies [62c5e53]
  - @agentick/sandbox@0.14.7

## 0.14.6

### Patch Changes

- 6b72302: fix: add "default" export condition to publishConfig exports

  Node's CJS resolver needs "default" or "require" in the exports map. Without it, require() throws ERR_PACKAGE_PATH_NOT_EXPORTED. Fixes intermittent crashes when nx's node executor loads packages via require().

- Updated dependencies [6b72302]
  - @agentick/sandbox@0.14.6

## 0.14.5

### Patch Changes

- @agentick/sandbox@0.14.5

## 0.14.4

### Patch Changes

- @agentick/sandbox@0.14.4

## 0.14.3

### Patch Changes

- @agentick/sandbox@0.14.3

## 0.14.2

### Patch Changes

- @agentick/sandbox@0.14.2

## 0.14.1

### Patch Changes

- @agentick/sandbox@0.14.1

## 0.14.0

### Patch Changes

- @agentick/sandbox@0.14.0

## 0.13.2

### Patch Changes

- @agentick/sandbox@0.13.2

## 0.13.1

### Patch Changes

- @agentick/sandbox@0.13.1

## 0.13.0

### Patch Changes

- @agentick/sandbox@0.13.0

## 0.12.3

### Patch Changes

- @agentick/sandbox@0.12.3

## 0.12.2

### Patch Changes

- @agentick/sandbox@0.12.2

## 0.12.1

### Patch Changes

- @agentick/sandbox@0.12.1

## 0.12.0

### Patch Changes

- @agentick/sandbox@0.12.0

## 0.11.2

### Patch Changes

- @agentick/sandbox@0.11.2

## 0.11.1

### Patch Changes

- @agentick/sandbox@0.11.1

## 0.11.0

### Minor Changes

- 10023a7: ### Cache metrics & CacheHealth widget

  - Surface `cachedInputTokens`, `cacheCreationTokens`, and `cacheHitRatio` through ContextInfo, protocol payloads, streaming events, and devtools
  - New `CacheHealth` status bar widget with configurable color thresholds

  ### Shell → Bash rename

  - Rename Shell tool to Bash across sandbox packages
  - Fix base executor to use `bash -c` instead of `sh -c` (enables brace expansion)

  ### Mode-aware mount consolidation

  - `addMount()` now respects mount modes: rw parents consume all children, ro parents only consume ro children
  - Redundant child mounts skipped when parent already covers them
  - Mode promotion (ro → rw) on exact path match
  - Confirmation messages show the directory being mounted, not the individual file

  ### useEvents batching fix

  - Replace single-event useState with microtask-batched queue to prevent React state batching from dropping events

  ### Empty response guard

  - Detect empty model responses and replace with corrective event instead of persisting empty assistant messages

  ### Gateway logging

  - Debug/trace logging for RPC requests, event streaming, and send method flow
  - Logging config (level, file) in gateway FileConfig

### Patch Changes

- Updated dependencies [10023a7]
  - @agentick/sandbox@0.11.0

## 0.10.1

### Patch Changes

- @agentick/sandbox@0.10.1

## 0.10.0

### Patch Changes

- @agentick/sandbox@0.10.0

## 0.9.6

### Patch Changes

- 84752df: Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.
- Updated dependencies [84752df]
  - @agentick/sandbox@0.9.6

## 0.9.5

### Patch Changes

- @agentick/sandbox@0.9.5

## 0.9.4

### Patch Changes

- @agentick/sandbox@0.9.4

## 0.9.3

### Patch Changes

- @agentick/sandbox@0.9.3

## 0.9.2

### Patch Changes

- @agentick/sandbox@0.9.2

## 0.9.1

### Patch Changes

- @agentick/sandbox@0.9.1

## 0.9.0

### Patch Changes

- @agentick/sandbox@0.9.0

## 0.8.0

### Patch Changes

- @agentick/sandbox@0.8.0

## 0.7.0

### Patch Changes

- @agentick/sandbox@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [4750f5e]
  - @agentick/sandbox@0.6.0

## 0.5.0

### Patch Changes

- @agentick/sandbox@0.5.0

## 0.4.1

### Patch Changes

- Updated dependencies [fe10ade]
  - @agentick/sandbox@0.4.1

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/sandbox@0.4.0

## 0.4.0

### Minor Changes

- Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies
  - @agentick/sandbox@0.4.0
