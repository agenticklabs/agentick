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
  port?: number;              // Default: 18789
  host?: string;              // Default: "127.0.0.1"
  id?: string;                // Auto-generated if not provided

  // Apps
  apps: Record<string, AgentickApp>;
  defaultApp: string;

  // Mode
  embedded?: boolean;         // Skip transport init, use handleRequest()

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
  error.code;      // "GUARD_DENIED"
  error.guardType; // "role" or "custom"
}
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
┌────────────────────────────────────────────────────────────┐
│                        GATEWAY                              │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐ │
│  │                   HTTP Transport                       │ │
│  │              (SSE events + REST endpoints)             │ │
│  └───────────────────────┬───────────────────────────────┘ │
│                          │                                  │
│          ┌───────────────┼───────────────┐                 │
│          │               │               │                 │
│          ▼               ▼               ▼                 │
│    ┌──────────┐   ┌──────────┐   ┌──────────┐             │
│    │  Web UI  │   │   CLI    │   │  Mobile  │             │
│    │  Client  │   │  Client  │   │  Client  │             │
│    └──────────┘   └──────────┘   └──────────┘             │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────────────────────────────────────────────────┐  │
│   │                    App Registry                      │  │
│   ├─────────────┬─────────────┬─────────────────────────┤  │
│   │   chat      │  research   │       coder             │  │
│   │   (app)     │   (app)     │       (app)             │  │
│   └──────┬──────┴──────┬──────┴───────────┬─────────────┘  │
│          │             │                  │                 │
│   ┌──────┴─────────────┴──────────────────┴──────┐         │
│   │              Session Manager                  │         │
│   │   ┌─────┐ ┌─────┐ ┌─────┐                    │         │
│   │   │sess1│ │sess2│ │sess3│  ...               │         │
│   │   └─────┘ └─────┘ └─────┘                    │         │
│   └──────────────────────────────────────────────┘         │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐  │
│   │              Custom Methods                          │  │
│   │   tasks:list, tasks:create, admin:stats, ...        │  │
│   └─────────────────────────────────────────────────────┘  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
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

## Related Packages

- [`@agentick/express`](../express) - Express middleware (thin adapter)
- [`@agentick/nestjs`](../nestjs) - NestJS module (thin adapter)
- [`@agentick/core`](../core) - JSX runtime for apps
- [`@agentick/client`](../client) - Client SDK
- [`@agentick/server`](../server) - SSE utilities

## License

MIT
