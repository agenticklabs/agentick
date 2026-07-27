---
"@agentick/spec": minor
"@agentick/loop-executor": minor
"@agentick/session": minor
"@agentick/mcp": minor
---

Result-level metadata now reaches the client on the tool-dispatch stream
event. `ToolDispatchEvent.metadata` forwards `DispatchResult.metadata`
verbatim — the loop projects the bag it is handed and never interprets
it — which is what an MCP-Apps frame descriptor needs to reach a UI.

The consuming side stopped dropping it. `mapCallToolResult` now folds an
incoming `CallToolResult._meta` into `metadata.mcp.meta` — the SAME
namespaced key the server-side result extensions project FROM, so a
result-scoped payload reads identically whether agentick produced it or
received it — and `withMCP`'s proxy handlers return the full mapped
result instead of bare content blocks. Two fields the bare content
mapping also silently dropped now survive with it: `structuredContent`,
and `isError`, which means a consumed MCP tool's DOMAIN error no longer
reaches the model wearing a success.
