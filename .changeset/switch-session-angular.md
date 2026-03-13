---
"@agentick/angular": minor
---

Add `switchSession()` to `ChatSessionService` for multi-thread chat support. Tears down the current session and creates a new one with the given sessionId, optionally pre-populated with initial messages. Reuses the same underlying client connection. Also exposes a `sessionId` signal.
