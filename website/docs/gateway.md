# Gateway & Sessions

The Gateway manages multiple sessions, routes messages, and provides a
method-based API for external access. It exposes a
[JSON-RPC-like protocol](/docs/gateway-protocol) over WebSocket and HTTP/SSE
that any client in any language can consume.

## Creating a Gateway

```typescript
import { createGateway, method } from "@agentick/gateway";
import { z } from "zod";

const gateway = createGateway({
  apps: { myApp },
  defaultApp: "myApp",
  methods: {
    chat: {
      send: method({
        description: "Send a chat message",
        schema: z.object({
          message: z.string(),
          sessionId: z.string(),
        }),
        handler: async ({ message, sessionId }) => {
          const ctx = Context.get();
          const session = await ctx.session({ id: sessionId });
          return session.send({
            messages: [{ role: "user", content: message }],
          }).result;
        },
      }),
    },
  },
});
```

## Session Management

The gateway creates and manages sessions on demand:

```typescript
// Sessions are created via the app
const session = await app.session({ id: "user-123" });

// Each session has its own component tree, state, and timeline
await session.send({ messages: [...] });
```

## Custom Methods

Gateway methods are typed RPC endpoints with schema validation, role guards,
and ALS context:

```typescript
methods: {
  namespace: {
    methodName: method({
      description: "Do something useful",
      schema: z.object({ /* params */ }),
      response: z.object({ /* response */ }),
      roles: ["admin"],
      handler: async (params) => {
        const ctx = Context.get();
        return { result: "value" };
      },
    }),
  },
}
```

Both `schema` (params) and `response` accept Zod 3, Zod 4, or any Standard
Schema. They appear as JSON Schema in the [protocol's schema method](/docs/gateway-protocol#schema-discovery).

## Protocol & Schema Discovery

The gateway's `schema` method returns the complete protocol contract at
runtime — every method with full JSON Schema for params and response, every
event type with its category, and every error code. A client in any language
can build a full SDK from this single response.

See the [Gateway Protocol](/docs/gateway-protocol) reference for the full
specification.

## Plugins

Plugins extend the gateway with additional methods and capabilities:

```typescript
const plugin: GatewayPlugin = {
  id: "my-plugin",
  async initialize(ctx) {
    ctx.registerMethod("analyze", method({
      schema: z.object({ text: z.string() }),
      response: z.object({ sentiment: z.number() }),
      handler: async (params) => ({ sentiment: 0.8 }),
    }));

    ctx.on("session:created", ({ sessionId }) => {
      console.log("New session:", sessionId);
    });
  },
  async destroy() {},
};

gateway.use(plugin);
```

Plugin methods appear alongside built-in and config methods in the schema
discovery response with `builtin: false`.

## With Express

```typescript
import { createExpressMiddleware } from "@agentick/express";

const app = express();
app.use("/api", createExpressMiddleware({ gateway }));
```

This mounts SSE endpoints for streaming and method endpoints for RPC.
