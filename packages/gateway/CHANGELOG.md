# @agentick/gateway

## 0.11.1

### Patch Changes

- 336c439: Fix tool-confirm RPC: correct method name (`tool-response` → `tool-confirm`), map field names (`toolUseId` → `callId`, `approved` → `confirmed`), and forward `always` flag through gateway so "Always Allow" works for remote clients.
- Updated dependencies [336c439]
  - @agentick/shared@0.11.1
  - @agentick/core@0.11.1
  - @agentick/kernel@0.11.1
  - @agentick/server@0.11.1

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
  - @agentick/shared@0.11.0
  - @agentick/core@0.11.0
  - @agentick/kernel@0.11.0
  - @agentick/server@0.11.0

## 0.10.1

### Patch Changes

- 84a0400: Pass full SendInput through WebSocket/Unix RPC transport

  The RPC transport was silently dropping multi-modal content by extracting
  plain text from SendInput before sending over the wire. Now the full
  SendInput (messages with ContentBlock arrays) passes through untouched.

  - SendParams accepts `input?: SendInput` (full multi-modal) alongside
    `message?: string` (text-only convenience shorthand)
  - Delete dead `attachments` field from SendParams
  - Delete `extractSendMessage` and helpers from transport-utils
  - Fix HistoryPayload.content type to `ContentBlock[] | string`

- Updated dependencies [84a0400]
  - @agentick/shared@0.10.1
  - @agentick/core@0.10.1
  - @agentick/kernel@0.10.1
  - @agentick/server@0.10.1

## 0.10.0

### Minor Changes

- 619c448: Formalize gateway protocol with full schema discovery

  Phase 1 — Protocol foundation:

  - Add `protocolVersion` to ConnectMessage/ConnectedMessage handshake
  - Send ConnectedMessage on WebSocket and Unix socket auth completion
  - New built-in methods: `schema`, `tool-catalog`, `tool-confirm`, `tool-dispatch`
  - Add `audience` field to ToolDefinition (shared)
  - Add `getToolDefinitions()` to Session interface (core)

  Phase 2 — Complete schema discovery:

  - `schema` method returns full protocol contract: every method with JSON Schema
    for params and response, every event type with category, every error code
  - Extract `MODEL_EVENT_TYPES`, `ORCHESTRATION_EVENT_TYPES`, `RESULT_EVENT_TYPES`
    from shared (zero-maintenance event catalog)
  - Structured error codes using shared's error hierarchy (`isNotFoundError`,
    `isGuardError`, etc.) instead of catch-all `METHOD_ERROR`
  - Custom method `response` schema support via `MethodDefinitionInput.response`
  - Breaking: `SchemaPayload` shape changed — unified `methods` record replaces
    `builtInMethods`/`customMethods` split (no external consumers yet)

### Patch Changes

- Updated dependencies [619c448]
  - @agentick/core@0.10.0
  - @agentick/shared@0.10.0
  - @agentick/kernel@0.10.0
  - @agentick/server@0.10.0

## 0.9.6

### Patch Changes

- 84752df: Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.
- Updated dependencies [84752df]
  - @agentick/core@0.9.6
  - @agentick/kernel@0.9.6
  - @agentick/shared@0.9.6
  - @agentick/server@0.9.6

## 0.9.5

### Patch Changes

- Updated dependencies [dc26053]
  - @agentick/core@0.9.5
  - @agentick/kernel@0.9.5
  - @agentick/shared@0.9.5
  - @agentick/server@0.9.5

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
