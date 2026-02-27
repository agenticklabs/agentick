---
"@agentick/core": patch
---

Expose `sessionId` on COM so tool handlers can access their owning session's ID via `ctx.sessionId`. Returns null in test contexts without session wiring.
