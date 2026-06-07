---
"@agentick/core": patch
---

Rename default MCP resource tool names from `list_resources` / `read_resource` to `list_mcp_resources` / `read_mcp_resource`. The `mcp_` namespace prefix disambiguates from filesystem tools like `read_file` / `glob` — generic names collide cognitively and lead models to confuse MCP URIs with filesystem paths. Tool descriptions also tightened to explicitly call out the URI-vs-path distinction. Callers can still override via the existing `listToolName` / `readToolName` props.
