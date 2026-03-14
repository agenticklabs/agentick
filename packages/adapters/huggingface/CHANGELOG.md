# @agentick/huggingface

## 0.14.3

### Patch Changes

- @agentick/shared@0.14.3
- @agentick/core@0.14.3

## 0.14.2

### Patch Changes

- @agentick/shared@0.14.2
- @agentick/core@0.14.2

## 0.14.1

### Patch Changes

- @agentick/shared@0.14.1
- @agentick/core@0.14.1

## 0.14.0

### Patch Changes

- @agentick/shared@0.14.0
- @agentick/core@0.14.0

## 0.13.2

### Patch Changes

- @agentick/shared@0.13.2
- @agentick/core@0.13.2

## 0.13.1

### Patch Changes

- @agentick/shared@0.13.1
- @agentick/core@0.13.1

## 0.13.0

### Minor Changes

- 8e568d1: Unified EmbedInput API and embed support on adapters

  - **EmbedInput**: New single-object input shape (`{ input, model?, dimensions?, taskType? }`) mirroring ModelInput style. Replaces previous `(texts, options)` positional params.
  - **embed as Procedure**: `EngineModel.embed` is now a Procedure with middleware, ALS context, and telemetry support.
  - **OpenAI adapter**: Added `embeddingModel` config option and `embed()` support via OpenAI embeddings API.
  - **Google adapter**: Added `embeddingModel` config option and `embed()` support via Google embedContent API, including `dimensions` and `taskType` passthrough.
  - **Per-request model override**: API adapters (OpenAI, Google) respect `input.model` to override the configured embedding model per-request.
  - **Custom XML tag passthrough**: Collector and markdown renderer now pass through unrecognized XML tags as custom blocks.

### Patch Changes

- Updated dependencies [8e568d1]
  - @agentick/shared@0.13.0
  - @agentick/core@0.13.0

## 0.12.3

### Patch Changes

- @agentick/core@0.12.3
- @agentick/shared@0.12.3

## 0.12.2

### Patch Changes

- @agentick/shared@0.12.2
- @agentick/core@0.12.2

## 0.12.1

### Patch Changes

- @agentick/shared@0.12.1
- @agentick/core@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [2435355]
  - @agentick/shared@0.12.0
  - @agentick/core@0.12.0

## 0.11.2

### Patch Changes

- Updated dependencies [6d169a8]
  - @agentick/core@0.11.2
  - @agentick/shared@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [336c439]
  - @agentick/shared@0.11.1
  - @agentick/core@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [10023a7]
  - @agentick/shared@0.11.0
  - @agentick/core@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [84a0400]
  - @agentick/shared@0.10.1
  - @agentick/core@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [619c448]
  - @agentick/core@0.10.0
  - @agentick/shared@0.10.0

## 0.9.6

### Patch Changes

- Updated dependencies [84752df]
  - @agentick/core@0.9.6
  - @agentick/shared@0.9.6

## 0.9.5

### Patch Changes

- Updated dependencies [dc26053]
  - @agentick/core@0.9.5
  - @agentick/shared@0.9.5

## 0.9.4

### Patch Changes

- @agentick/shared@0.9.4
- @agentick/core@0.9.4

## 0.9.3

### Patch Changes

- Updated dependencies [1a4c9b0]
  - @agentick/core@0.9.3
  - @agentick/shared@0.9.3

## 0.9.2

### Patch Changes

- @agentick/core@0.9.2
- @agentick/shared@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1
  - @agentick/core@0.9.1

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
