---
"@agentick/mcp": minor
---

MCP tool wire extensions via a namespaced `metadata.mcp` block, projected
at the wire (no spec changes): result-side `_meta` (envelope
`metadata.mcp.meta` → wire `CallToolResult._meta` — makes
`wwwAuthenticateMeta` step-up challenges actually reach clients),
declaration-side `_meta` (→ wire `Tool._meta`, the MCP Apps `ui://`
template-linkage carrier), and advisory annotation hints
(readOnly/destructive/idempotent/openWorld → wire `Tool.annotations`).
Typed helpers `mcpToolExtensions` / `mcpResultExtensions` exported from
`@agentick/mcp/server`. Wire output is byte-identical when no extensions
are carried.
