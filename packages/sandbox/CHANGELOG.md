# @agentick/sandbox

## 0.14.35

### Patch Changes

- @agentick/core@0.14.35

## 0.14.34

### Patch Changes

- @agentick/core@0.14.34

## 0.14.33

### Patch Changes

- @agentick/core@0.14.33

## 0.14.32

### Patch Changes

- @agentick/core@0.14.32

## 0.14.31

### Patch Changes

- @agentick/core@0.14.31

## 0.14.30

### Patch Changes

- Updated dependencies [29ddb7a]
  - @agentick/core@0.14.30

## 0.14.29

### Patch Changes

- Updated dependencies [d8b1984]
  - @agentick/core@0.14.29

## 0.14.28

### Patch Changes

- @agentick/core@0.14.28

## 0.14.27

### Patch Changes

- @agentick/core@0.14.27

## 0.14.26

### Patch Changes

- @agentick/core@0.14.26

## 0.14.25

### Patch Changes

- Updated dependencies [b602b9b]
  - @agentick/core@0.14.25

## 0.14.24

### Patch Changes

- @agentick/core@0.14.24

## 0.14.23

### Patch Changes

- @agentick/core@0.14.23

## 0.14.22

### Patch Changes

- @agentick/core@0.14.22

## 0.14.21

### Patch Changes

- @agentick/core@0.14.21

## 0.14.20

### Patch Changes

- @agentick/core@0.14.20

## 0.14.19

### Patch Changes

- @agentick/core@0.14.19

## 0.14.18

### Patch Changes

- @agentick/core@0.14.18

## 0.14.17

### Patch Changes

- @agentick/core@0.14.17

## 0.14.16

### Patch Changes

- Updated dependencies [59a9281]
  - @agentick/core@0.14.16

## 0.14.15

### Patch Changes

- @agentick/core@0.14.15

## 0.14.14

### Patch Changes

- 30a8174: auth and sandbox teardown
  - @agentick/core@0.14.14

## 0.14.13

### Patch Changes

- @agentick/core@0.14.13

## 0.14.12

### Patch Changes

- Updated dependencies [04451f0]
  - @agentick/core@0.14.12

## 0.14.11

### Patch Changes

- @agentick/core@0.14.11

## 0.14.10

### Patch Changes

- @agentick/core@0.14.10

## 0.14.9

### Patch Changes

- @agentick/core@0.14.9

## 0.14.8

### Patch Changes

- @agentick/core@0.14.8

## 0.14.7

### Patch Changes

- 62c5e53: fix: SandboxTools returns a Fragment instead of an array so it can be used as a JSX component
  - @agentick/core@0.14.7

## 0.14.6

### Patch Changes

- 6b72302: fix: add "default" export condition to publishConfig exports

  Node's CJS resolver needs "default" or "require" in the exports map. Without it, require() throws ERR_PACKAGE_PATH_NOT_EXPORTED. Fixes intermittent crashes when nx's node executor loads packages via require().

- Updated dependencies [6b72302]
  - @agentick/core@0.14.6

## 0.14.5

### Patch Changes

- @agentick/core@0.14.5

## 0.14.4

### Patch Changes

- Updated dependencies [cc1ee21]
  - @agentick/core@0.14.4

## 0.14.3

### Patch Changes

- @agentick/core@0.14.3

## 0.14.2

### Patch Changes

- @agentick/core@0.14.2

## 0.14.1

### Patch Changes

- @agentick/core@0.14.1

## 0.14.0

### Patch Changes

- @agentick/core@0.14.0

## 0.13.2

### Patch Changes

- @agentick/core@0.13.2

## 0.13.1

### Patch Changes

- @agentick/core@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [8e568d1]
  - @agentick/core@0.13.0

## 0.12.3

### Patch Changes

- @agentick/core@0.12.3

## 0.12.2

### Patch Changes

- @agentick/core@0.12.2

## 0.12.1

### Patch Changes

- @agentick/core@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [2435355]
  - @agentick/core@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies [6d169a8]
  - @agentick/core@0.11.2

## 0.11.1

### Patch Changes

- @agentick/core@0.11.1

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
  - @agentick/core@0.11.0

## 0.10.1

### Patch Changes

- @agentick/core@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [619c448]
  - @agentick/core@0.10.0

## 0.9.6

### Patch Changes

- 84752df: Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.
- Updated dependencies [84752df]
  - @agentick/core@0.9.6

## 0.9.5

### Patch Changes

- Updated dependencies [dc26053]
  - @agentick/core@0.9.5

## 0.9.4

### Patch Changes

- @agentick/core@0.9.4

## 0.9.3

### Patch Changes

- Updated dependencies [1a4c9b0]
  - @agentick/core@0.9.3

## 0.9.2

### Patch Changes

- @agentick/core@0.9.2

## 0.9.1

### Patch Changes

- @agentick/core@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [d3f9b8d]
  - @agentick/core@0.9.0

## 0.8.0

### Patch Changes

- @agentick/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [c73753e]
  - @agentick/core@0.7.0

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

- Updated dependencies [e30960c]
- Updated dependencies [4750f5e]
  - @agentick/core@0.6.0

## 0.5.0

### Patch Changes

- Updated dependencies [156bc2f]
  - @agentick/core@0.5.0

## 0.4.1

### Patch Changes

- fe10ade: Enhanced EditFile tool with 5 editing modes (replace, delete, insert before/after/start/end, range), smart line deletion, 3-level whitespace-tolerant matching, and diagnostic error messages with file context.

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/core@0.4.0

## 0.4.0

### Minor Changes

- Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies
  - @agentick/core@0.4.0
