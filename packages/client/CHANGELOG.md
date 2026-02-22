# @agentick/client

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
