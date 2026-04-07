# MCP (Model Context Protocol)

Connect AI agents to external tools and data via the [Model Context Protocol](https://modelcontextprotocol.io/).

## Quick Start

```tsx
import { MCP, System, Timeline } from "agentick";

function MyAgent() {
  return (
    <>
      <MCP
        servers={{
          postgres: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"],
          },
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
          },
        }}
      />
      <System>You can query databases and read files.</System>
      <Timeline />
    </>
  );
}
```

The `<MCP>` component connects to servers, discovers their capabilities, and makes everything available to the model:

- **Tools** from each server are registered individually (the model calls them directly)
- **Resources** are unified under two tools — `list_resources` and `read_resource` — for progressive discovery across all servers

## How Resources Work

MCP servers can expose read-only data (database schemas, config files, API docs) as **resources**. Instead of dumping all resources into context, the model discovers them progressively:

1. **Terrain map** — a section in context listing resource names and descriptions
2. **`list_resources`** — tool to get full URIs, mime types, and details (with optional filtering)
3. **`read_resource`** — tool to fetch content by URI

The model sees what's available, narrows down what it needs, then reads specific resources. This scales to hundreds of resources without bloating context.

```
Model sees in context:
  Resources:
    users — Users table schema
    orders [application/json] — Orders table schema
  Resource Templates:
    table_schema (db://schema/{table}) — Any table schema

  Use list_resources for URIs and details. Use read_resource to fetch content.

Model calls: list_resources({ pattern: "user" })
  → [{ uri: "db://schema/users", name: "users", server: "postgres", ... }]

Model calls: read_resource({ uri: "db://schema/users" })
  → "CREATE TABLE users (id INT, name TEXT, ...)"
```

## Configuration

### Cursor-style (stdio servers)

```tsx
<MCP
  servers={{
    postgres: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-postgres", connStr],
    },
  }}
/>
```

### Full config (remote servers)

```tsx
<MCP
  servers={{
    api: {
      serverName: "api",
      transport: "sse",
      connection: { url: "https://mcp.example.com/sse" },
      auth: { type: "bearer", token: apiToken },
    },
  }}
/>
```

### Tool filtering

```tsx
<MCP
  servers={{
    filesystem: { command: "npx", args: [...] },
    database: { command: "npx", args: [...] },
  }}
  toolFilter={{
    filesystem: {
      include: ["read_file", "list_directory"],  // whitelist
      prefix: "fs_",                              // fs_read_file
    },
    database: {
      exclude: ["drop_table"],                    // blacklist
    },
  }}
/>
```

### Custom resource tool names

```tsx
<MCP
  servers={...}
  listResourcesToolName="browse_schemas"
  readResourceToolName="fetch_schema"
/>
```

## Transports

| Transport   | SDK Class                       | Use Case                    |
| ----------- | ------------------------------- | --------------------------- |
| `stdio`     | `StdioClientTransport`          | Local process (npx, python) |
| `sse`       | `SSEClientTransport`            | Remote server with SSE      |
| `websocket` | `StreamableHTTPClientTransport` | Modern HTTP streaming       |

Cursor-style configs default to `stdio`. Use full `MCPConfig` for `sse` or `websocket`.

## Architecture

```
<MCP servers={...} />
  │
  ├─ MCPToolComponent (per server)     ← registers each server's tools
  │    └─ MCPClient.listTools()
  │    └─ MCPTool (ExecutableTool)
  │
  └─ MCPResourceComponent (once)       ← unified resource discovery
       └─ MCPClient.listAllResources()
       └─ MCPClient.listAllResourceTemplates()
       └─ <Section> terrain map
       └─ <Tool> list_resources
       └─ <Tool> read_resource
```

A single shared `MCPClient` manages all server connections. Tools are per-server (each has unique name/behavior). Resources are unified (one `list_resources` + `read_resource` across all servers, routing is internal).

### URI Routing

When the model calls `read_resource({ uri: "db://schema/users" })`, the system:

1. Checks cached resources for an exact URI match → routes to that server
2. Checks resource templates for a pattern match (`db://schema/{table}`) → routes to that server
3. Throws if no server owns the URI

## API

### `<MCP>` (primary)

| Prop                    | Type                                              | Description                             |
| ----------------------- | ------------------------------------------------- | --------------------------------------- |
| `servers`               | `Record<string, MCPServerConfig \| MCPConfig>`    | Server configs                          |
| `toolFilter`            | `Record<string, { include?, exclude?, prefix? }>` | Per-server tool filtering               |
| `listResourcesToolName` | `string`                                          | Custom name (default: `list_resources`) |
| `readResourceToolName`  | `string`                                          | Custom name (default: `read_resource`)  |

### `MCPClient` (advanced)

For sharing connections or direct resource access:

```typescript
import { MCPClient } from "agentick";

const client = new MCPClient();
await client.connect(config);

// Resources
const resources = await client.listAllResources();
const templates = await client.listAllResourceTemplates();
const contents = await client.readResourceByURI("db://schema/users");

// Cache management
client.invalidateResources("postgres"); // re-fetch on next call
client.invalidateResources(); // all servers
```
