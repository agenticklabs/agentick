---
"@agentick/gateway": patch
---

Add MCP server and OpenAI-compatible protocol plugins. `mcpServerPlugin` exposes session tools via standard MCP `tools/list` + `tools/call`. `openaiCompatPlugin` serves `/v1/chat/completions` and `/v1/models` for any OpenAI SDK client. Plugin route registration added to `PluginContext`. Built-in method dispatch deduplicated via `resolveBuiltInMethod`.
