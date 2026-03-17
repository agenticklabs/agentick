# @agentick/client

## 0.14.7

### Patch Changes

- @agentick/shared@0.14.7

## 0.14.6

### Patch Changes

- 6b72302: fix: add "default" export condition to publishConfig exports

  Node's CJS resolver needs "default" or "require" in the exports map. Without it, require() throws ERR_PACKAGE_PATH_NOT_EXPORTED. Fixes intermittent crashes when nx's node executor loads packages via require().

- Updated dependencies [6b72302]
  - @agentick/shared@0.14.6

## 0.14.5

### Patch Changes

- Updated dependencies [d0e35be]
  - @agentick/shared@0.14.5

## 0.14.4

### Patch Changes

- @agentick/shared@0.14.4

## 0.14.3

### Patch Changes

- @agentick/shared@0.14.3

## 0.14.2

### Patch Changes

- @agentick/shared@0.14.2

## 0.14.1

### Patch Changes

- @agentick/shared@0.14.1

## 0.14.0

### Patch Changes

- @agentick/shared@0.14.0

## 0.13.2

### Patch Changes

- a4464da: feat: add appendMessages() to MessageLog, ChatSession, and ChatSessionService
  - @agentick/shared@0.13.2

## 0.13.1

### Patch Changes

- 7a414a0: feat: paginated message history + Angular service cleanup

  - Add `prependMessages()` to MessageLog, ChatSession, and ChatSessionService for loading older messages on scroll-back
  - Rewrite AgentickService: remove `providedIn: "root"`, eliminate polling RxJS fallback, proper cleanup of client subscriptions, use `inject()` exclusively
  - @agentick/shared@0.13.1

## 0.13.0

### Patch Changes

- Updated dependencies [8e568d1]
  - @agentick/shared@0.13.0

## 0.12.3

### Patch Changes

- @agentick/shared@0.12.3

## 0.12.2

### Patch Changes

- @agentick/shared@0.12.2

## 0.12.1

### Patch Changes

- @agentick/shared@0.12.1

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
  - @agentick/shared@0.12.0

## 0.11.2

### Patch Changes

- @agentick/shared@0.11.2

## 0.11.1

### Patch Changes

- Updated dependencies [336c439]
  - @agentick/shared@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [10023a7]
  - @agentick/shared@0.11.0

## 0.10.1

### Patch Changes

- Updated dependencies [84a0400]
  - @agentick/shared@0.10.1

## 0.10.0

### Patch Changes

- Updated dependencies [619c448]
  - @agentick/shared@0.10.0

## 0.9.6

### Patch Changes

- 84752df: Add typesVersions fallback for legacy moduleResolution: node consumers. Relax generic prop constraint from `P extends Record<string, unknown>` to unconstrained `P` so TypeScript interfaces work as component props.
- Updated dependencies [84752df]
  - @agentick/shared@0.9.6

## 0.9.5

### Patch Changes

- @agentick/shared@0.9.5

## 0.9.4

### Patch Changes

- @agentick/shared@0.9.4

## 0.9.3

### Patch Changes

- @agentick/shared@0.9.3

## 0.9.2

### Patch Changes

- @agentick/shared@0.9.2

## 0.9.1

### Patch Changes

- Updated dependencies [596eba0]
  - @agentick/shared@0.9.1

## 0.9.0

### Patch Changes

- Updated dependencies [d3f9b8d]
  - @agentick/shared@0.9.0

## 0.8.0

### Minor Changes

- f84c8bb: Unified SSE wire format and event delivery

  **Gateway**: All event delivery now uses `EventMessage` format (`{ type: "event", event, sessionId, data }`) — SSE matches WebSocket. SSE clients are real transport clients via `EmbeddedSSETransport`, getting backpressure through `ClientEventBuffer`, appearing in `gateway.status.clients`, and receiving DevTools lifecycle events. Channel events reach all transports. WS clients can subscribe to and publish channel events via `channel-subscribe` and `channel` RPC methods. `GatewayEventType` derived from `StreamEvent["type"]`.

  **Client**: New `unwrapEventMessage()` utility normalizes `EventMessage` → flat format at every parse site (SSE, WS, client.ts). Handles both old and new formats for safe transition. Envelope fields always win over data properties to prevent collision.

### Patch Changes

- @agentick/shared@0.8.0

## 0.7.0

### Patch Changes

- @agentick/shared@0.7.0

## 0.5.0

### Minor Changes

- 75960dd: Add AttachmentManager for multimodal message support. Platforms add images, PDFs, and other files before submit(), which drains them into ContentBlock[] automatically. Includes default validator (image/png, jpeg, gif, webp, pdf), default block mapper (image/\* → ImageBlock, else → DocumentBlock), and full integration with ChatSession and useChat hook.
- 0350de3: Extract LineEditor as framework-agnostic class in @agentick/client. Readline-quality line editing (13 actions, kill ring, history, keybindings) now available to all platforms. Add useLineEditor hook to @agentick/react for web consumers. TUI's useLineEditor becomes a thin Ink-specific wrapper.

### Patch Changes

- e30960c: Add composable chat primitives: ChatSession, MessageLog, ToolConfirmations, MessageSteering. ChatSession auto-subscribes to SSE transport by default.
- Updated dependencies [4750f5e]
  - @agentick/shared@0.6.0

## 0.4.0

### Minor Changes

- 842f92c: Bump all packages to 0.4.0. Includes @agentick/sandbox-local (OS-level sandbox provider) and @agentick/sandbox contract extensions (NetworkRule, ProxiedRequest, Permissions.net rules, ExecOptions.onOutput).

### Patch Changes

- Updated dependencies [842f92c]
  - @agentick/shared@0.4.0

## 0.2.1

### Patch Changes

- Updated dependencies [07b630c]
  - @agentick/shared@0.2.1

## 0.2.0

### Minor Changes

- a9cf566: agentick convenience package now re-exports @agentick/agent and @agentick/guardrails. One install, one import source.

### Patch Changes

- Updated dependencies [a9cf566]
  - @agentick/shared@0.2.0

## 0.1.9

### Patch Changes

- 3f5f0be: Add documentation website (VitePress + TypeDoc), AGENTS.md for cross-agent discovery, and agent skills for common development tasks.
- Updated dependencies [3f5f0be]
  - @agentick/shared@0.1.9
