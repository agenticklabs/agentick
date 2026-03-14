---
"@agentick/gateway": patch
---

fix: authenticate and set ALS context once at the request boundary

Moved auth validation and `Context.run()` to `handleRequest()` so all
downstream handlers, session creation, plugin routes, and tool execution
inherit the authenticated user automatically. Previously each handler
validated auth independently, and `handleSend` never propagated the user
to the ALS context — causing session stores to see `userId: "unknown"`.

Also changed `this.session()` to use `Context.fork()` instead of
`Context.create()` so it inherits the outer context (including user)
when adding the gateway handle, rather than replacing it.
