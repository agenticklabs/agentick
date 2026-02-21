# agentick

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
  - @agentick/core@0.9.0
  - @agentick/agent@0.9.0
  - @agentick/guardrails@0.9.0

## 0.8.0

### Patch Changes

- @agentick/core@0.8.0
- @agentick/agent@0.8.0
- @agentick/guardrails@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [c73753e]
  - @agentick/core@0.7.0
  - @agentick/agent@0.7.0
  - @agentick/guardrails@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [e30960c]
- Updated dependencies [4750f5e]
  - @agentick/core@0.6.0
  - @agentick/agent@0.5.1
  - @agentick/guardrails@0.4.1

## 0.5.0

### Patch Changes

- Updated dependencies [156bc2f]
  - @agentick/core@0.5.0
  - @agentick/agent@0.5.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/core@0.4.0
  - @agentick/agent@0.4.0
  - @agentick/guardrails@0.4.0

## 0.3.0

### Patch Changes

- Updated dependencies [d38460c]
  - @agentick/core@0.3.0
  - @agentick/agent@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies [07b630c]
  - @agentick/core@0.2.1
  - @agentick/agent@0.2.1
  - @agentick/guardrails@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/core@0.2.0
  - @agentick/agent@0.2.0
  - @agentick/guardrails@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/core@0.1.9
