---
"@agentick/gateway": patch
---

fix(gateway): handle stale MCP session IDs gracefully

MCP clients (Cursor, etc.) may cache session IDs across server restarts. The MCP server plugin now detects stale session IDs paired with an `initialize` request and falls through to create a new session instead of returning 404. Also makes `GatewayPlugin.destroy()` optional.
