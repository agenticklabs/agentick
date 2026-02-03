# @tentickle/express

Express middleware for Tentickle Gateway.

This is a **thin adapter** (~50 lines) that delegates all business logic to `@tentickle/gateway`. Use this when you want to integrate Tentickle into an existing Express application.

## Installation

```bash
npm install @tentickle/express
# or
pnpm add @tentickle/express
```

## Quick Start

```typescript
import express from "express";
import { createTentickleMiddleware } from "@tentickle/express";
import { createApp, Model, System, Timeline } from "@tentickle/core";

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

const tentickleApp = createApp(<AssistantAgent />);

// Create middleware
const tentickle = createTentickleMiddleware({
  apps: { assistant: tentickleApp },
  defaultApp: "assistant",
});

// Mount at /api
app.use("/api", tentickle);

// Start server
const server = app.listen(3000);

// Graceful shutdown - access gateway via .gateway property
process.on("SIGTERM", async () => {
  await tentickle.gateway.close();
  server.close();
});
```

## API

### createTentickleMiddleware(config, options?)

Creates an Express Router that delegates to an embedded Gateway.

Returns a `TentickleRouter` - an Express Router with an attached `.gateway` property for lifecycle management.

```typescript
import { createTentickleMiddleware, method } from "@tentickle/express";
import { z } from "zod";

const middleware = createTentickleMiddleware({
  // Required: Register your apps
  apps: {
    assistant: tentickleApp,
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

### TentickleRouter

The middleware returns a `TentickleRouter` which extends Express Router with:

```typescript
interface TentickleRouter extends Router {
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
interface TentickleMiddlewareOptions {
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
import { method } from "@tentickle/express";
import { z } from "zod";
import { Context } from "@tentickle/kernel";

const middleware = createTentickleMiddleware({
  apps: { assistant: tentickleApp },
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
          // Access Tentickle context
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
const tentickle = createTentickleMiddleware({ ... });
app.use("/api", tentickle);

const server = app.listen(3000);

const shutdown = async (signal: string) => {
  console.log(`${signal} received, shutting down...`);

  // Close gateway first (cleanly disconnects all sessions)
  await tentickle.gateway.close();

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

For convenience, the package re-exports common types from `@tentickle/gateway`:

```typescript
export {
  Gateway,
  method,
  type GatewayConfig,
  type MethodDefinition,
  type AuthConfig,
} from "@tentickle/gateway";
```

## Related Packages

- [`@tentickle/gateway`](../gateway) - Core gateway (used internally)
- [`@tentickle/core`](../core) - JSX runtime for agents
- [`@tentickle/client`](../client) - Browser/Node client SDK
- [`@tentickle/server`](../server) - SSE utilities

## License

MIT
