---
"@agentick/gateway": patch
---

fix: propagate authenticated user to ALS context in HTTP send handler

The `handleSend` SSE endpoint validated auth but never set `authResult.user` on the kernel Context, so session stores and tools saw `userId: "unknown"`. Now wraps `directSend` in `Context.run()` with the authenticated user, matching what `handleInvoke` already does.
