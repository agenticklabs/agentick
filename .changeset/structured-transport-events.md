---
"@agentick/shared": minor
"@agentick/client": minor
"@agentick/core": minor
"@agentick/gateway": minor
"@agentick/client-multiplexer": minor
---

**Breaking**: `TransportEventData` no longer spreads `data` into the top level. Event payloads are now in a structured `data` field.

Before: `{ type: "content_delta", sessionId: "main", text: "hello", index: 0 }`
After:  `{ type: "content_delta", sessionId: "main", data: { text: "hello", index: 0 } }`

The `[key: string]: unknown` index signature is removed. This prevents silent property collisions between envelope fields (`type`, `sessionId`) and payload properties, and makes `TransportEventData` a proper typed interface rather than a bag.

`unwrapEventMessage()` return type changed from `Record<string, unknown>` to `TransportEventData | Record<string, unknown>`.

**Migration**: Any code accessing payload properties directly on transport events (e.g., `event.delta`, `event.text`) must now access them through `event.data` (e.g., `(event.data as StreamEvent).delta`).
