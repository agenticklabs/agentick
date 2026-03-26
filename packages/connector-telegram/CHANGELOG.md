# @agentick/connector-telegram

## 0.14.20

### Patch Changes

- Updated dependencies [152ac52]
  - @agentick/gateway@0.14.20
  - @agentick/shared@0.14.20

## 0.14.19

### Patch Changes

- Updated dependencies [8ad9d35]
  - @agentick/gateway@0.14.19
  - @agentick/shared@0.14.19

## 0.14.18

### Patch Changes

- Updated dependencies [36fac24]
  - @agentick/gateway@0.14.18
  - @agentick/shared@0.14.18

## 0.14.17

### Patch Changes

- Updated dependencies [f27c004]
  - @agentick/gateway@0.14.17
  - @agentick/shared@0.14.17

## 0.14.16

### Patch Changes

- @agentick/gateway@0.14.16
- @agentick/shared@0.14.16

## 0.14.15

### Patch Changes

- Updated dependencies [d08f1fe]
  - @agentick/gateway@0.14.15
  - @agentick/shared@0.14.15

## 0.14.14

### Patch Changes

- Updated dependencies [30a8174]
  - @agentick/gateway@0.14.14
  - @agentick/shared@0.14.14

## 0.14.13

### Patch Changes

- @agentick/shared@0.14.13
- @agentick/gateway@0.14.13

## 0.14.12

### Patch Changes

- @agentick/gateway@0.14.12
- @agentick/shared@0.14.12

## 0.14.11

### Patch Changes

- @agentick/shared@0.14.11
- @agentick/gateway@0.14.11

## 0.14.10

### Patch Changes

- @agentick/shared@0.14.10
- @agentick/gateway@0.14.10

## 0.14.9

### Patch Changes

- @agentick/shared@0.14.9
- @agentick/gateway@0.14.9

## 0.14.8

### Patch Changes

- @agentick/shared@0.14.8
- @agentick/gateway@0.14.8

## 0.14.7

### Patch Changes

- @agentick/shared@0.14.7
- @agentick/gateway@0.14.7

## 0.14.6

### Patch Changes

- 6b72302: fix: add "default" export condition to publishConfig exports

  Node's CJS resolver needs "default" or "require" in the exports map. Without it, require() throws ERR_PACKAGE_PATH_NOT_EXPORTED. Fixes intermittent crashes when nx's node executor loads packages via require().

- Updated dependencies [6b72302]
  - @agentick/shared@0.14.6
  - @agentick/gateway@0.14.6

## 0.14.5

### Patch Changes

- Updated dependencies [d0e35be]
  - @agentick/shared@0.14.5
  - @agentick/gateway@0.14.5

## 0.14.4

### Patch Changes

- @agentick/gateway@0.14.4
- @agentick/shared@0.14.4

## 0.14.3

### Patch Changes

- Updated dependencies [1b13ab3]
  - @agentick/gateway@0.14.3
  - @agentick/shared@0.14.3

## 0.14.2

### Patch Changes

- Updated dependencies [4ee5ffe]
  - @agentick/gateway@0.14.2
  - @agentick/shared@0.14.2

## 0.14.1

### Patch Changes

- @agentick/shared@0.14.1
- @agentick/gateway@0.14.1

## 0.14.0

### Patch Changes

- @agentick/shared@0.14.0
- @agentick/gateway@0.14.0

## 0.13.2

### Patch Changes

- @agentick/shared@0.13.2
- @agentick/gateway@0.13.2

## 0.13.1

### Patch Changes

- @agentick/shared@0.13.1
- @agentick/gateway@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [8e568d1]
  - @agentick/shared@0.13.0
  - @agentick/gateway@0.13.0

## 0.12.3

### Patch Changes

- Updated dependencies [badc15b]
  - @agentick/gateway@0.12.3
  - @agentick/shared@0.12.3

## 0.12.2

### Patch Changes

- Updated dependencies [17619ca]
  - @agentick/gateway@0.12.2
  - @agentick/shared@0.12.2

## 0.12.1

### Patch Changes

- Updated dependencies [98d54d1]
  - @agentick/gateway@0.12.1
  - @agentick/shared@0.12.1

## 0.12.0

### Patch Changes

- Updated dependencies [2435355]
- Updated dependencies [2435355]
  - @agentick/gateway@0.12.0
  - @agentick/shared@0.12.0

## 0.11.2

### Patch Changes

- @agentick/gateway@0.11.2
- @agentick/shared@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [336c439]
  - @agentick/shared@0.11.1
  - @agentick/gateway@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [10023a7]
  - @agentick/shared@0.11.0
  - @agentick/gateway@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [84a0400]
  - @agentick/shared@0.10.1
  - @agentick/gateway@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [619c448]
  - @agentick/gateway@0.10.0
  - @agentick/shared@0.10.0

## 0.9.6

### Patch Changes

- Updated dependencies [84752df]
  - @agentick/gateway@0.9.6
  - @agentick/shared@0.9.6

## 0.9.5

### Patch Changes

- @agentick/gateway@0.9.5
- @agentick/shared@0.9.5

## 0.9.4

### Patch Changes

- Updated dependencies [e01f0e5]
  - @agentick/gateway@0.9.4
  - @agentick/shared@0.9.4

## 0.9.3

### Patch Changes

- @agentick/gateway@0.9.3
- @agentick/shared@0.9.3

## 0.9.2

### Patch Changes

- @agentick/gateway@0.9.2
- @agentick/shared@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1
  - @agentick/gateway@0.9.1

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
  - @agentick/gateway@0.9.0

## 0.8.0

### Patch Changes

- @agentick/connector@0.8.0
- @agentick/shared@0.8.0

## 0.7.0

### Patch Changes

- @agentick/shared@0.7.0
- @agentick/connector@0.7.0
