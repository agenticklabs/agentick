# @agentick/shared

## 0.14.8

## 0.14.7

## 0.14.6

### Patch Changes

- 6b72302: fix: add "default" export condition to publishConfig exports

  Node's CJS resolver needs "default" or "require" in the exports map. Without it, require() throws ERR_PACKAGE_PATH_NOT_EXPORTED. Fixes intermittent crashes when nx's node executor loads packages via require().

## 0.14.5

### Patch Changes

- d0e35be: updated file reference type

## 0.14.4

## 0.14.3

## 0.14.2

## 0.14.1

## 0.14.0

## 0.13.2

## 0.13.1

## 0.13.0

### Minor Changes

- 8e568d1: Unified EmbedInput API and embed support on adapters

  - **EmbedInput**: New single-object input shape (`{ input, model?, dimensions?, taskType? }`) mirroring ModelInput style. Replaces previous `(texts, options)` positional params.
  - **embed as Procedure**: `EngineModel.embed` is now a Procedure with middleware, ALS context, and telemetry support.
  - **OpenAI adapter**: Added `embeddingModel` config option and `embed()` support via OpenAI embeddings API.
  - **Google adapter**: Added `embeddingModel` config option and `embed()` support via Google embedContent API, including `dimensions` and `taskType` passthrough.
  - **Per-request model override**: API adapters (OpenAI, Google) respect `input.model` to override the configured embedding model per-request.
  - **Custom XML tag passthrough**: Collector and markdown renderer now pass through unrecognized XML tags as custom blocks.

## 0.12.3

## 0.12.2

## 0.12.1

## 0.12.0

### Minor Changes

- 2435355: **Breaking**: `TransportEventData` no longer spreads `data` into the top level. Event payloads are now in a structured `data` field.

  Before: `{ type: "content_delta", sessionId: "main", text: "hello", index: 0 }`
  After: `{ type: "content_delta", sessionId: "main", data: { text: "hello", index: 0 } }`

  The `[key: string]: unknown` index signature is removed. This prevents silent property collisions between envelope fields (`type`, `sessionId`) and payload properties, and makes `TransportEventData` a proper typed interface rather than a bag.

  `unwrapEventMessage()` return type changed from `Record<string, unknown>` to `TransportEventData | Record<string, unknown>`.

  **Migration**: Any code accessing payload properties directly on transport events (e.g., `event.delta`, `event.text`) must now access them through `event.data` (e.g., `(event.data as StreamEvent).delta`).

## 0.11.2

## 0.11.1

### Patch Changes

- 336c439: Fix tool-confirm RPC: correct method name (`tool-response` → `tool-confirm`), map field names (`toolUseId` → `callId`, `approved` → `confirmed`), and forward `always` flag through gateway so "Always Allow" works for remote clients.

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

## 0.10.0

### Patch Changes

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

## 0.9.6

### Patch Changes

- 84752df: Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.

## 0.9.5

## 0.9.4

## 0.9.3

## 0.9.2

## 0.9.1

### Patch Changes

- 596eba0: Switch to NodeNext module resolution with explicit .js extensions on all relative imports. Fixes ESM compatibility for consumers using plain Node without a bundler. Bump target/lib to ES2023.

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

## 0.8.0

## 0.7.0

## 0.6.0

### Minor Changes

- 4750f5e: Tool call summaries and file confirmation with diff preview.

  Tools can define `displaySummary` to provide a short description (e.g., file
  path, command) that appears in stream events and TUI indicators.

  File modification tools (`write_file`, `edit_file`) now require confirmation
  before execution. A new `confirmationPreview` hook computes a unified diff
  that renders in the TUI confirmation prompt.

  Fixed: session confirmation channel wiring (was previously unconnected).

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

## 0.2.1

### Patch Changes

- 07b630c: Upgrade to React 19 and react-reconciler 0.33. useComState now uses useSyncExternalStore for correct external state synchronization. Clean up dead code from reconciler migration.

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
