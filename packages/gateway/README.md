# @agentick/gateway

Unified gateway for multi-client, multi-app Agentick access.

Gateway can run as a **standalone daemon** or be **embedded** into existing web frameworks like Express or NestJS.

## Installation

```bash
npm install @agentick/gateway
# or
pnpm add @agentick/gateway
```

## Quick Start

### Standalone Mode

Run Gateway as its own process with built-in HTTP/SSE transport:

```typescript
import { createGateway } from "@agentick/gateway";
import { createApp, Model, System, Timeline } from "@agentick/core";

const ChatApp = () => (
  <>
    <Model model={gpt4} />
    <System>You are a helpful assistant.</System>
    <Timeline />
  </>
);

const gateway = createGateway({
  port: 3000,
  host: "127.0.0.1",
  apps: {
    chat: createApp(<ChatApp />),
  },
  defaultApp: "chat",
  auth: {
    type: "token",
    token: process.env.GATEWAY_TOKEN,
  },
});

await gateway.start();
console.log("Gateway running on http://127.0.0.1:3000");
```

### Embedded Mode

Embed Gateway into an existing Express app (or other framework):

```typescript
import express from "express";
import { Gateway } from "@agentick/gateway";

const app = express();
app.use(express.json());

const gateway = new Gateway({
  embedded: true, // Skip starting internal HTTP server
  apps: { assistant: agentickApp },
  defaultApp: "assistant",
});

// Handle requests yourself
app.use("/api", (req, res) => {
  gateway.handleRequest(req, res);
});

app.listen(3000);
```

For Express, use `@agentick/express` which wraps this pattern:

```typescript
import { createAgentickMiddleware } from "@agentick/express";

const middleware = createAgentickMiddleware({
  apps: { assistant: agentickApp },
  defaultApp: "assistant",
});

app.use("/api", middleware);

// Access gateway for lifecycle management
await middleware.gateway.close();
```

## Configuration

```typescript
interface GatewayConfig {
  // Server (standalone mode only)
  port?: number; // Default: 18789
  host?: string; // Default: "127.0.0.1"
  id?: string; // Auto-generated if not provided

  // Apps
  apps: Record<string, AgentickApp>;
  defaultApp: string;

  // Mode
  embedded?: boolean; // Skip transport init, use handleRequest()

  // Unix socket (daemon mode)
  socketPath?: string; // When set, gateway also listens on this Unix socket

  // Authentication
  auth?: AuthConfig;

  // Custom methods
  methods?: MethodsConfig;
}
```

### Authentication

```typescript
// No auth (development)
auth: { type: "none" }

// Static token
auth: {
  type: "token",
  token: process.env.API_TOKEN,
}

// JWT
auth: {
  type: "jwt",
  secret: process.env.JWT_SECRET,
  issuer: "my-app",  // Optional
}

// Custom validation
auth: {
  type: "custom",
  validate: async (token) => {
    const decoded = await verifyToken(token);
    return decoded
      ? { valid: true, user: { id: decoded.sub } }
      : { valid: false };
  },
}

// With user hydration (works with any auth type)
auth: {
  type: "custom",
  validate: async (token) => {
    const decoded = await verifyJWT(token);
    return { valid: true, user: { id: decoded.sub } };
  },
  hydrateUser: async (authResult) => {
    // Enrich with database data
    const dbUser = await db.users.findById(authResult.user.id);
    return {
      id: dbUser.id,
      tenantId: dbUser.tenantId,
      roles: dbUser.roles,
      email: dbUser.email,
    };
  },
}
```

## Custom Methods

Define RPC-style methods that clients can invoke. Methods run within Agentick's context system with full access to user info, channels, and tracing.

```typescript
import { createGateway, method } from "@agentick/gateway";
import { Context } from "@agentick/kernel";
import { z } from "zod";

const gateway = createGateway({
  apps: { assistant: agentickApp },
  defaultApp: "assistant",

  methods: {
    // Simple method - no schema needed
    ping: async () => ({ pong: true, timestamp: Date.now() }),

    // Namespaced methods
    tasks: {
      // With Zod schema - params are typed!
      list: method({
        schema: z.object({
          sessionId: z.string(),
          completed: z.boolean().optional(),
        }),
        handler: async (params) => {
          const ctx = Context.get();
          return todoService.list(params.sessionId, {
            userId: ctx.user?.id,
            completed: params.completed,
          });
        },
      }),

      create: method({
        schema: z.object({
          sessionId: z.string(),
          title: z.string().min(1),
          priority: z.enum(["low", "medium", "high"]).optional(),
        }),
        handler: async (params) => {
          const ctx = Context.get();
          const task = await todoService.create({
            title: params.title,
            priority: params.priority,
            userId: ctx.user?.id,
          });
          // Emit event for devtools/subscribers
          Context.emit("task:created", { taskId: task.id });
          return task;
        },
      }),

      // Deeply nested namespaces
      admin: {
        archive: method({
          roles: ["admin"], // Checked before handler
          handler: async () => todoService.archiveAll(),
        }),
      },
    },

    // Role-protected methods
    admin: {
      stats: method({
        roles: ["admin"],
        handler: async () => {
          const ctx = Context.get();
          return adminService.getStats(ctx.user?.tenantId);
        },
      }),

      // Custom guard function
      dangerousAction: method({
        guard: async () => {
          const ctx = Context.get();
          return ctx.user?.roles?.includes("superadmin") ?? false;
        },
        handler: async (params) => {
          // Only superadmins reach here
        },
      }),
    },
  },
});
```

### Method Definition Styles

| Style           | Example                                        | Wrapper? |
| --------------- | ---------------------------------------------- | -------- |
| Simple function | `async (params) => result`                     | No       |
| With schema     | `method({ schema: z.object({...}), handler })` | Yes      |
| With guards     | `method({ roles: ["admin"], handler })`        | Yes      |
| Namespace       | `{ tasks: { list, create } }`                  | No       |
| Deep namespace  | `{ tasks: { admin: { archive } } }`            | No       |

Methods are invoked using colon-separated paths: `tasks:list`, `tasks:admin:archive`, `admin:stats`.

### Guard Errors

Role and custom guards throw `GuardError` (from `@agentick/kernel`) on denial. The gateway returns HTTP 403 for guard denials:

```typescript
import { isGuardError } from "@agentick/kernel";

// In your error handling
if (isGuardError(error)) {
  error.code; // "GUARD_DENIED"
  error.guardType; // "role" or "custom"
}
```

## Unix Socket Transport (Daemon Mode)

Gateway can listen on a Unix domain socket for local IPC. This enables a daemon architecture where the gateway runs as a background process and lightweight clients connect over the socket.

```typescript
const gateway = createGateway({
  apps: { chat: myApp },
  defaultApp: "chat",
  socketPath: "/tmp/my-agent.sock",
  auth: { type: "token", token: process.env.API_TOKEN },
});

await gateway.start();
// Gateway now accepts connections on both HTTP and Unix socket
```

`socketPath` is orthogonal to HTTP/WebSocket — a gateway can listen on Unix socket AND HTTP simultaneously.

### Client Connection

Use `createUnixSocketClientTransport` to connect from another Node.js process:

```typescript
import { createUnixSocketClientTransport } from "@agentick/gateway";
import { createClient } from "@agentick/client";

const transport = createUnixSocketClientTransport({
  socketPath: "/tmp/my-agent.sock",
  token: process.env.API_TOKEN,
});

const client = createClient({ baseUrl: "unix://", transport });
const session = client.subscribe("my-session");
const handle = session.send("Hello from another process!");
```

The Unix socket transport uses NDJSON (newline-delimited JSON) — the same message types as WebSocket. The client transport lives in `@agentick/gateway` (not `@agentick/client`) because `node:net` is Node.js-only and the client package must remain browser-compatible.

### Socket Security

The socket file inherits filesystem permissions. For daemon deployments, ensure the socket directory has restricted permissions (0o700) so only the owning user can connect.

## Protocol Plugins

The gateway ships two plugins that expose sessions via standard interfaces.
Both are optional — import and `use()` them as needed.

### MCP Server

Exposes gateway capabilities as a standard MCP server via Streamable HTTP.
Any MCP client (Claude Desktop, Cursor, Claude Code, etc.) can connect.

Supports three modes:

- **Resources-only** — serve MCP resources without tools (no `sessionId` needed)
- **Static tools** — expose session tools, frozen at initialization
- **Per-session tools** — filter tools per client via `toolFilter` callback

#### Resources Only

Serve domain knowledge, schemas, or documentation as MCP resources without
exposing any tools:

```typescript
import { mcpServerPlugin } from "@agentick/gateway";
import type { MCPStaticResource, MCPResourceTemplate } from "@agentick/gateway";

gateway.use(
  mcpServerPlugin({
    path: "/mcp",
    serverName: "my-server",
    serverVersion: "1.0.0",

    // Static resources — fixed URI, returns content when read
    resources: [
      {
        name: "guide",
        uri: "myapp://guide/overview",
        title: "Platform Overview",
        description: "Key concepts and terminology.",
        read: () => ({ text: "# Overview\n\nWelcome to..." }),
      },
    ],

    // Resource templates — parameterized URI with listing and autocomplete
    resourceTemplates: [
      {
        name: "schema",
        uriTemplate: "myapp://schema/{model}",
        title: "Model Schema",
        description: "Field definitions and relationships.",
        list: () => [
          { uri: "myapp://schema/users", title: "Users Schema" },
          { uri: "myapp://schema/orders", title: "Orders Schema" },
        ],
        read: (variables) => ({ text: `# ${variables.model}\n\n...` }),
        complete: {
          model: (value) => ["users", "orders"].filter((m) => m.startsWith(value)),
        },
      },
    ],
  }),
);
```

#### Tools + Resources

Expose session tools alongside resources. Tools are discovered from the
session via `tool-catalog` and dispatched via `tool-dispatch`:

```typescript
gateway.use(
  mcpServerPlugin({
    sessionId: "default",
    path: "/mcp",
    include: ["search"], // optional: only expose these tools
    exclude: ["shell"], // optional: hide these tools
    resources: [
      /* ... */
    ],
    resourceTemplates: [
      /* ... */
    ],
  }),
);
```

Tools support MCP annotations (`readOnlyHint`, `destructiveHint`, `openWorldHint`)
via the `annotations` field on `ToolEntry`.

#### Per-Session Tool Filtering

Use `toolFilter` to customize tools per client based on the incoming HTTP
request (e.g., auth headers):

```typescript
gateway.use(
  mcpServerPlugin({
    sessionId: "default",
    path: "/mcp",
    toolFilter: async (tools, req) => {
      const token = req.headers.authorization?.replace("Bearer ", "");
      const user = await verifyToken(token);

      if (user.role === "admin") return tools;
      return tools.filter((t) => !t.name.startsWith("admin_"));
    },
  }),
);
```

When `toolFilter` is set, each MCP client handshake creates its own `McpServer`
with a filtered tool catalog. The filter receives the full pre-filtered catalog
(after `include`/`exclude`) and the raw `IncomingMessage`.

Session lifecycle is automatic — sessions are tracked by `mcp-session-id` header
and cleaned up on disconnect or plugin destroy.

#### Body Parsing Compatibility

When the gateway runs behind Express or other middleware that pre-parses request
bodies, the plugin automatically passes `req.body` to the MCP transport. This
prevents issues where the stream is already consumed before the transport reads it.

### OpenAI-Compatible

Serves `POST /v1/chat/completions` and `GET /v1/models`. Any OpenAI SDK client
can point at the gateway.

```typescript
import { openaiCompatPlugin } from "@agentick/gateway";

gateway.use(
  openaiCompatPlugin({
    pathPrefix: "/v1", // default: "/v1"
    modelMapping: {
      // optional: map model names → app IDs
      "gpt-4o": "coding",
      "gpt-4": "research",
    },
  }),
);
```

- `GET /v1/models` — lists gateway apps as OpenAI models
- `POST /v1/chat/completions` — streaming (SSE) and non-streaming responses
- Model→app routing via `modelMapping`, falls back to model name as app ID
- Session keyed by `x-session-id` header or auto-generated

### Logging

Structured logging for gateway lifecycle events (connections, sessions, errors)
using the kernel's `Logger` infrastructure (pino-based).

```typescript
import { loggingPlugin, loggingMiddleware } from "@agentick/gateway";

// Plugin — logs gateway events (connect, disconnect, session create/close, errors)
gateway.use(loggingPlugin());

// Middleware — morgan-style HTTP request logging for embedded mode (Express)
app.use(loggingMiddleware());
```

Configure logging level, transport, or provide a custom logger:

```typescript
import { Logger } from "@agentick/kernel";

gateway.use(
  loggingPlugin({
    logger: Logger.create({ level: "debug" }),
  }),
);
```

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:18789/v1", api_key="test")
for chunk in client.chat.completions.create(
    model="default",
    messages=[{"role": "user", "content": "hello"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")
```

## HTTP Endpoints

Gateway exposes these HTTP endpoints:

| Method | Path      | Description                   |
| ------ | --------- | ----------------------------- |
| GET    | `/events` | SSE stream for session events |
| POST   | `/send`   | Send message to session       |
| POST   | `/invoke` | Invoke custom method          |

### SSE Events Stream

```typescript
// Connect to events stream
const events = new EventSource("/events?sessionId=main&token=xxx");

// Execution events
events.addEventListener("content_delta", (e) => {
  console.log("Content:", JSON.parse(e.data).delta);
});

events.addEventListener("tool_use", (e) => {
  console.log("Tool:", JSON.parse(e.data).name);
});

events.addEventListener("message_end", () => {
  console.log("Response complete");
});

// Connection events
events.addEventListener("connected", (e) => {
  console.log("Connected:", JSON.parse(e.data));
});
```

### Send Message

```bash
curl -X POST http://localhost:3000/send \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"sessionId": "main", "message": "Hello!"}'
```

### Invoke Method

```bash
curl -X POST http://localhost:3000/invoke \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"method": "tasks:list", "params": {"sessionId": "main"}}'
```

## Lifecycle

```typescript
const gateway = createGateway({ ... });

// Start (standalone mode)
await gateway.start();

// Events
gateway.on("session:created", ({ sessionId }) => { ... });
gateway.on("session:closed", ({ sessionId }) => { ... });
gateway.on("client:connected", ({ clientId }) => { ... });
gateway.on("client:disconnected", ({ clientId }) => { ... });

// Graceful shutdown
await gateway.close();
```

## Client SDK

Use `@agentick/client` to connect to Gateway:

```typescript
import { createClient } from "@agentick/client";

const client = createClient({
  baseUrl: "http://localhost:3000",
  token: process.env.GATEWAY_TOKEN,
});

// Get session
const session = client.session("main");

// Send message and stream response
const handle = session.send("Hello!");
for await (const event of handle) {
  if (event.type === "content_delta") {
    process.stdout.write(event.delta);
  }
}

// Invoke custom method
const tasks = await session.invoke("tasks:list");
const newTask = await session.invoke("tasks:create", {
  title: "Buy groceries",
  priority: "high",
});
```

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                          GATEWAY                              │
│                                                               │
│  ┌─────────────────────────┐   ┌───────────────────────────┐ │
│  │    HTTP/WS Transport    │   │  Unix Socket Transport    │ │
│  │  (SSE + REST + WebSocket)│   │  (NDJSON over node:net)   │ │
│  └────────────┬────────────┘   └─────────────┬─────────────┘ │
│               │                               │               │
│       ┌───────┼───────┐              ┌────────┘               │
│       │       │       │              │                        │
│       ▼       ▼       ▼              ▼                        │
│   ┌──────┐ ┌──────┐ ┌──────┐  ┌──────────┐                  │
│   │Web UI│ │Mobile│ │ CLI  │  │  Daemon  │                   │
│   │Client│ │Client│ │Client│  │  Client  │                   │
│   └──────┘ └──────┘ └──────┘  └──────────┘                  │
│                                                               │
│  ┌──────────────────────┐   ┌──────────────────────────────┐ │
│  │  MCP Server Plugin   │   │  OpenAI-Compatible Plugin    │ │
│  │  /mcp (tools+resources│   │  /v1/chat/completions       │ │
│  └──────────┬───────────┘   └──────────────┬───────────────┘ │
│             │                               │                 │
│       ┌─────┘                       ┌───────┘                 │
│       ▼                             ▼                         │
│   ┌──────────┐                ┌──────────┐                   │
│   │MCP Client│                │OpenAI SDK│                   │
│   │(Cursor,  │                │(Python,  │                   │
│   │ Claude)  │                │ JS, etc.)│                   │
│   └──────────┘                └──────────┘                   │
│                                                               │
├───────────────────────────────────────────────────────────────┤
│                                                               │
│   ┌─────────────────────────────────────────────────────┐    │
│   │                    App Registry                      │    │
│   ├─────────────┬─────────────┬──────────────────────────┤   │
│   │   chat      │  research   │       coder              │   │
│   │   (app)     │   (app)     │       (app)              │   │
│   └──────┬──────┴──────┬──────┴───────────┬──────────────┘   │
│          │             │                  │                   │
│   ┌──────┴─────────────┴──────────────────┴──────┐           │
│   │              Session Manager                  │           │
│   │   ┌─────┐ ┌─────┐ ┌─────┐                    │           │
│   │   │sess1│ │sess2│ │sess3│  ...               │           │
│   │   └─────┘ └─────┘ └─────┘                    │           │
│   └──────────────────────────────────────────────┘           │
│                                                               │
│   ┌─────────────────────────────────────────────────────┐    │
│   │              Custom Methods                          │    │
│   │   tasks:list, tasks:create, admin:stats, ...        │    │
│   └─────────────────────────────────────────────────────┘    │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

## Standalone vs Embedded

| Feature            | Standalone                | Embedded                                |
| ------------------ | ------------------------- | --------------------------------------- |
| Config             | `port`, `host`            | `embedded: true`                        |
| Start              | `gateway.start()`         | N/A                                     |
| Request handling   | Built-in HTTP server      | `gateway.handleRequest(req, res)`       |
| Use case           | Dedicated gateway process | Integrate with Express/NestJS           |
| Framework packages | Not needed                | `@agentick/express`, `@agentick/nestjs` |

## Context Access

Custom methods run within Agentick's ALS (Async Local Storage) context:

```typescript
import { Context } from "@agentick/kernel";

methods: {
  "tasks:create": async (params) => {
    const ctx = Context.get();

    // User info (from auth)
    console.log(ctx.user?.id);
    console.log(ctx.user?.roles);
    console.log(ctx.user?.tenantId);

    // Request metadata
    console.log(ctx.metadata?.sessionId);
    console.log(ctx.metadata?.clientId);

    // Distributed tracing
    console.log(ctx.traceId);

    // Channel access (if session has channels)
    ctx.channels?.publish("notifications", { type: "task_created" });

    // Emit events (for devtools/subscribers)
    Context.emit("custom:task:created", { title: params.title });

    return todoService.create(params);
  },
}
```

## Exports

The gateway exports the protocol plugin factories alongside the core API:

```typescript
import {
  createGateway,
  method,
  mcpServerPlugin,
  openaiCompatPlugin,
  loggingPlugin,
  loggingMiddleware,
  type MCPServerPluginConfig,
  type MCPStaticResource,
  type MCPResourceTemplate,
  type McpToolEntry,
  type LoggingPluginConfig,
} from "@agentick/gateway";
```

## Related Packages

- [`@agentick/express`](../express) - Express middleware (thin adapter)
- [`@agentick/nestjs`](../nestjs) - NestJS module (thin adapter)
- [`@agentick/core`](../core) - JSX runtime for apps
- [`@agentick/client`](../client) - Client SDK
- [`@agentick/server`](../server) - SSE utilities
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) - MCP SDK (peer dependency for MCP server plugin)

## License

MIT
