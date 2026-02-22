# @agentick/gateway

## 0.9.4

### Patch Changes

- e01f0e5: Remove testing utility re-exports from main entrypoint to prevent vitest from being required at runtime. Testing utilities are available via `@agentick/gateway/testing` subpath import.
  - @agentick/kernel@0.9.4
  - @agentick/shared@0.9.4
  - @agentick/core@0.9.4
  - @agentick/server@0.9.4

## 0.9.3

### Patch Changes

- Updated dependencies [1a4c9b0]
  - @agentick/core@0.9.3
  - @agentick/kernel@0.9.3
  - @agentick/shared@0.9.3
  - @agentick/server@0.9.3

## 0.9.2

### Patch Changes

- Updated dependencies [7b45b0d]
  - @agentick/kernel@0.9.2
  - @agentick/core@0.9.2
  - @agentick/server@0.9.2
  - @agentick/shared@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1
  - @agentick/core@0.9.1
  - @agentick/kernel@0.9.1
  - @agentick/server@0.9.1

## 0.9.0

### Minor Changes

- d3f9b8d: feat: embeddings, gateway plugins, unix socket transport
  - Shared: embeddings types (`EmbeddingProvider`), `splitMessage` utility
  - Core: embedding support on adapters and engine models, `entry_committed` event, `executionId` on TickState
  - Gateway: plugin system with lifecycle management, Unix socket transport with shared RPC factory
  - Connector: re-export `splitMessage` from shared
  - Connector-telegram: rewrite as GatewayPlugin
  - Apple: embedding support via Apple Intelligence
  - Huggingface: new adapter for local embeddings via Transformers.js
  - Agentick: re-export `jsx-runtime` and `jsx-dev-runtime` from core
  - Fix: sub-path exports in publishConfig, Procedure wrapping for Tool handler

### Patch Changes

- Updated dependencies [d3f9b8d]
  - @agentick/shared@0.9.0
  - @agentick/core@0.9.0
  - @agentick/kernel@0.9.0
  - @agentick/server@0.9.0

## 0.8.0

### Minor Changes

- f84c8bb: Unified SSE wire format and event delivery

  **Gateway**: All event delivery now uses `EventMessage` format (`{ type: "event", event, sessionId, data }`) — SSE matches WebSocket. SSE clients are real transport clients via `EmbeddedSSETransport`, getting backpressure through `ClientEventBuffer`, appearing in `gateway.status.clients`, and receiving DevTools lifecycle events. Channel events reach all transports. WS clients can subscribe to and publish channel events via `channel-subscribe` and `channel` RPC methods. `GatewayEventType` derived from `StreamEvent["type"]`.

  **Client**: New `unwrapEventMessage()` utility normalizes `EventMessage` → flat format at every parse site (SSE, WS, client.ts). Handles both old and new formats for safe transition. Envelope fields always win over data properties to prevent collision.

### Patch Changes

- @agentick/kernel@0.8.0
- @agentick/shared@0.8.0
- @agentick/core@0.8.0
- @agentick/server@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [c73753e]
  - @agentick/core@0.7.0
  - @agentick/kernel@0.7.0
  - @agentick/shared@0.7.0
  - @agentick/server@0.7.0

## 0.5.1

### Patch Changes

- Updated dependencies [e30960c]
- Updated dependencies [4750f5e]
  - @agentick/core@0.6.0
  - @agentick/shared@0.6.0
  - @agentick/kernel@0.6.0
  - @agentick/server@0.4.1

## 0.5.0

### Patch Changes

- Updated dependencies [156bc2f]
  - @agentick/core@0.5.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/kernel@0.4.0
  - @agentick/shared@0.4.0
  - @agentick/core@0.4.0
  - @agentick/server@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [d38460c]
  - @agentick/core@0.3.0

## 0.2.1

### Patch Changes

- 07b630c: Upgrade to React 19 and react-reconciler 0.33. useComState now uses useSyncExternalStore for correct external state synchronization. Clean up dead code from reconciler migration.
- Updated dependencies [07b630c]
  - @agentick/core@0.2.1
  - @agentick/kernel@0.2.1
  - @agentick/shared@0.2.1
  - @agentick/server@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/core@0.2.0
  - @agentick/kernel@0.2.0
  - @agentick/shared@0.2.0
  - @agentick/server@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/core@0.1.9
  - @agentick/kernel@0.1.9
  - @agentick/shared@0.1.9
  - @agentick/server@0.1.9
