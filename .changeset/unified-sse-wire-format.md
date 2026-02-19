---
"@agentick/gateway": minor
"@agentick/client": minor
---

Unified SSE wire format and event delivery

**Gateway**: All event delivery now uses `EventMessage` format (`{ type: "event", event, sessionId, data }`) — SSE matches WebSocket. SSE clients are real transport clients via `EmbeddedSSETransport`, getting backpressure through `ClientEventBuffer`, appearing in `gateway.status.clients`, and receiving DevTools lifecycle events. Channel events reach all transports. WS clients can subscribe to and publish channel events via `channel-subscribe` and `channel` RPC methods. `GatewayEventType` derived from `StreamEvent["type"]`.

**Client**: New `unwrapEventMessage()` utility normalizes `EventMessage` → flat format at every parse site (SSE, WS, client.ts). Handles both old and new formats for safe transition. Envelope fields always win over data properties to prevent collision.
