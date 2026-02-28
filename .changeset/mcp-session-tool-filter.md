---
"@agentick/gateway": patch
---

Add `toolFilter` option to `mcpServerPlugin` for per-session MCP tool filtering. When set, each MCP client handshake creates its own `McpServer` with tools filtered by a user-provided callback that receives `(ToolEntry[], IncomingMessage)`. Without `toolFilter`, behavior is unchanged. Export `ToolEntry` type as `McpToolEntry`.
