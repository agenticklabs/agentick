# @agentick/client-multiplexer

## 0.12.0

### Minor Changes

- 2435355: **Breaking**: `TransportEventData` no longer spreads `data` into the top level. Event payloads are now in a structured `data` field.

  Before: `{ type: "content_delta", sessionId: "main", text: "hello", index: 0 }`
  After: `{ type: "content_delta", sessionId: "main", data: { text: "hello", index: 0 } }`

  The `[key: string]: unknown` index signature is removed. This prevents silent property collisions between envelope fields (`type`, `sessionId`) and payload properties, and makes `TransportEventData` a proper typed interface rather than a bag.

  `unwrapEventMessage()` return type changed from `Record<string, unknown>` to `TransportEventData | Record<string, unknown>`.

  **Migration**: Any code accessing payload properties directly on transport events (e.g., `event.delta`, `event.text`) must now access them through `event.data` (e.g., `(event.data as StreamEvent).delta`).

### Patch Changes

- Updated dependencies [2435355]
  - @agentick/client@0.12.0

## 0.11.2

### Patch Changes

- @agentick/client@0.11.2

## 0.11.1

### Patch Changes

- @agentick/client@0.11.1

## 0.11.0

### Patch Changes

- @agentick/client@0.11.0

## 0.10.1

### Patch Changes

- @agentick/client@0.10.1

## 0.10.0

### Patch Changes

- @agentick/client@0.10.0

## 0.9.6

### Patch Changes

- Updated dependencies [84752df]
  - @agentick/client@0.9.6

## 0.9.5

### Patch Changes

- @agentick/client@0.9.5

## 0.9.4

### Patch Changes

- @agentick/client@0.9.4

## 0.9.3

### Patch Changes

- @agentick/client@0.9.3

## 0.9.2

### Patch Changes

- @agentick/client@0.9.2

## 0.9.1

### Patch Changes

- @agentick/client@0.9.1

## 0.9.0

### Patch Changes

- @agentick/client@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [f84c8bb]
  - @agentick/client@0.8.0

## 0.7.0

### Patch Changes

- @agentick/client@0.7.0

## 0.4.1

### Patch Changes

- Updated dependencies [75960dd]
- Updated dependencies [e30960c]
- Updated dependencies [0350de3]
  - @agentick/client@0.5.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/client@0.4.0

## 0.2.1

### Patch Changes

- @agentick/client@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/client@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/client@0.1.9
