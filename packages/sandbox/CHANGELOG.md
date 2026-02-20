# @agentick/sandbox

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
