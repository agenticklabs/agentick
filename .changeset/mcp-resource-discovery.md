---
"@agentick/core": minor
"@agentick/gateway": patch
"agentick": minor
---

feat(mcp): unified `<MCP>` component with progressive resource discovery

New `<MCP>` component connects to MCP servers and provides both tools and resources. Tools are registered per-server. Resources are unified under `list_resources` and `read_resource` tools across all servers.

- `MCPClient`: resource discovery (`listResources`, `readResource`, `listResourceTemplates`), URI routing (`readResourceByURI`), cache invalidation
- `MCPResourceComponent`: terrain map in context + progressive resource tools
- `MCPComponent` (`<MCP>`): single component for tools + resources with shared client
- Exported from `"agentick"`: `MCP`, `MCPClient`, `MCPConfig`, `MCPResource`, etc.
