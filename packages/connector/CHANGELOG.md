# @agentick/connector

## 0.9.2

### Patch Changes

- @agentick/shared@0.9.2
- @agentick/client@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1
  - @agentick/client@0.9.1

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
  - @agentick/client@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [f84c8bb]
  - @agentick/client@0.8.0
  - @agentick/shared@0.8.0

## 0.7.0

### Patch Changes

- @agentick/shared@0.7.0
- @agentick/client@0.7.0
