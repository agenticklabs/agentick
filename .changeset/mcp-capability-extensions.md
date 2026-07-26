---
"@agentick/mcp": minor
---

MCP server capability-extensions seam: `McpServerOptions.extensions`
(typed off the SDK's `ServerCapabilities["extensions"]`) advertises
spec extensions in the `initialize` result — e.g. the MCP Apps
negotiation `{"io.modelcontextprotocol/ui": { mimeTypes:
["text/html;profile=mcp-app"] }}`. A separate slot from `capabilities`
deliberately: wired capabilities are harness-verified ("no lying on
the wire"), extension claims are adopter-owned. Absent/empty →
advertised capabilities byte-identical to before; the bag is copied at
construction; client-side passthrough pinned by test.
