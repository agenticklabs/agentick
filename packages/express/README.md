# @agentick/express

Express middleware for Agentick Gateway.

This is a **thin adapter** (~50 lines) that delegates all business logic to `@agentick/gateway`. Use this when you want to integrate Agentick into an existing Express application.

## Installation

```bash
npm install @agentick/express
# or
pnpm add @agentick/express
```

## Quick Start

```typescript
import express from "express";
import { createAgentickMiddleware } from "@agentick/express";
import { createApp, Model, System, Timeline } from "@agentick/core";

const app = express();
app.use(express.json());

// Define your agent
const AssistantAgent = () => (
  <>
    <Model model={gpt4} />
    <System>You are a helpful assistant.</System>
    <Timeline />
  </>
);

const agentickApp = createApp(<AssistantAgent />);

// Create middleware
const agentick = createAgentickMiddleware({
  apps: { assistant: agentickApp },
  defaultApp: "assistant",
});

// Mount at /api
app.use("/api", agentick);

// Start server
const server = app.listen(3000);

// Graceful shutdown - access gateway via .gateway property
process.on("SIGTERM", async () => {
  await agentick.gateway.close();
  server.close();
});
```

## API

### createAgentickMiddleware(config, options?)

Creates an Express Router that delegates to an embedded Gateway.

Returns a `AgentickRouter` - an Express Router with an attached `.gateway` property for lifecycle management.

```typescript
import { createAgentickMiddleware, method } from "@agentick/express";
import { z } from "zod";

const middleware = createAgentickMiddleware({
  // Required: Register your apps
  apps: {
    assistant: agentickApp,
    researcher: researchApp,
  },
  defaultApp: "assistant",

  // Optional: Authentication
  auth: {
    type: "custom",
    validate: async (token) => {
      const user = await verifyToken(token);
      return user ? { valid: true, user } : { valid: false };
    },
  },

  // Optional: Custom methods
  methods: {
    tasks: {
      list: method({
        schema: z.object({ sessionId: z.string() }),
        handler: async (params) => todoService.list(params.sessionId),
      }),
      create: method({
        schema: z.object({
          sessionId: z.string(),
          title: z.string().min(1),
        }),
        handler: async (params) => todoService.create(params),
      }),
    },
    health: async () => ({
      status: "ok",
      timestamp: new Date().toISOString(),
    }),
  },
});
```

### AgentickRouter

The middleware returns a `AgentickRouter` which extends Express Router with:

```typescript
interface AgentickRouter extends Router {
  /** The underlying Gateway instance for lifecycle management */
  gateway: Gateway;
}
```

Use `.gateway` for:

- Graceful shutdown: `await middleware.gateway.close()`
- Event subscriptions: `middleware.gateway.on('session:created', ...)`
- Direct method invocation (advanced)

### Options

```typescript
interface AgentickMiddlewareOptions {
  /**
   * Extract token from Express request.
   * By default, extracts from Authorization header.
   */
  getToken?: (req: Request) => string | undefined;
}
```

## Endpoints

The middleware exposes these HTTP endpoints:

| Method | Path      | Description                   |
| ------ | --------- | ----------------------------- |
| GET    | `/events` | SSE stream for session events |
| POST   | `/send`   | Send message to session       |
| POST   | `/invoke` | Invoke custom method          |

### SSE Events Stream

```typescript
// Client connects to events stream
const events = new EventSource("/api/events?sessionId=main&token=xxx");

events.addEventListener("content_delta", (e) => {
  const data = JSON.parse(e.data);
  console.log("Content:", data.delta);
});

events.addEventListener("tool_use", (e) => {
  const data = JSON.parse(e.data);
  console.log("Tool call:", data.name);
});

events.addEventListener("message_end", () => {
  console.log("Response complete");
});
```

### Send Message

```typescript
const response = await fetch("/api/send", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    sessionId: "main",
    message: "Hello!",
  }),
});
```

### Invoke Custom Method

```typescript
const response = await fetch("/api/invoke", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({
    method: "tasks:list",
    params: { sessionId: "main" },
  }),
});
```

## Custom Methods

Define methods using the `method()` helper for schema validation and guards:

```typescript
import { method } from "@agentick/express";
import { z } from "zod";
import { Context } from "@agentick/kernel";

const middleware = createAgentickMiddleware({
  apps: { assistant: agentickApp },
  defaultApp: "assistant",
  methods: {
    // Simple method - no schema
    ping: async () => ({ pong: true }),

    // With Zod schema - params are typed!
    tasks: {
      create: method({
        schema: z.object({
          title: z.string().min(1),
          priority: z.enum(["low", "medium", "high"]).optional(),
        }),
        handler: async (params) => {
          // Access Agentick context
          const ctx = Context.get();
          return todoService.create({
            title: params.title,
            priority: params.priority,
            userId: ctx.user?.id,
          });
        },
      }),

      // With role guards
      admin: {
        delete: method({
          roles: ["admin"],
          schema: z.object({ id: z.number() }),
          handler: async (params) => todoService.delete(params.id),
        }),
      },
    },
  },
});
```

## Authentication

```typescript
// Token auth
auth: {
  type: "token",
  token: process.env.API_TOKEN,
}

// JWT auth
auth: {
  type: "jwt",
  secret: process.env.JWT_SECRET,
}

// Custom auth with user hydration
auth: {
  type: "custom",
  validate: async (token) => {
    const decoded = await verifyJWT(token);
    return { valid: true, user: { id: decoded.sub } };
  },
  hydrateUser: async (authResult) => {
    const dbUser = await db.users.findById(authResult.user.id);
    return {
      id: dbUser.id,
      tenantId: dbUser.tenantId,
      roles: dbUser.roles,
    };
  },
}
```

## Graceful Shutdown

The middleware exposes the underlying Gateway for lifecycle management:

```typescript
const agentick = createAgentickMiddleware({ ... });
app.use("/api", agentick);

const server = app.listen(3000);

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down...`);

  // Close gateway first (cleanly disconnects all sessions)
  await agentick.gateway.close();

  // Then close HTTP server
  server.close(() => {
    console.log("Server closed");
    process.exit(0);
  });
};

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
```

## Re-exports

For convenience, the package re-exports common types from `@agentick/gateway`:

```typescript
export {
  Gateway,
  method,
  type GatewayConfig,
  type MethodDefinition,
  type AuthConfig,
} from "@agentick/gateway";
```

## Related Packages

- [`@agentick/gateway`](../gateway) - Core gateway (used internally)
- [`@agentick/core`](../core) - JSX runtime for agents
- [`@agentick/client`](../client) - Browser/Node client SDK
- [`@agentick/server`](../server) - SSE utilities

## License

MIT
