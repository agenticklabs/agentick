# Gateway & Sessions

The Gateway manages multiple sessions, routes messages, and provides a method-based API for external access.

## Creating a Gateway

```tsx
import { createGateway } from "@agentick/gateway";

const gateway = createGateway({
  app,
  methods: {
    chat: {
      send: method({
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

```tsx
// Sessions are created via the app
const session = await app.session({ id: "user-123" });

// Each session has its own component tree, state, and timeline
await session.send({ messages: [...] });
```

## Methods

Gateway methods are typed RPC endpoints:

```tsx
methods: {
  namespace: {
    methodName: method({
      schema: z.object({ /* params */ }),
      handler: async (params) => {
        const ctx = Context.get();
        return { result: "value" };
      },
    }),
  },
}
```

Methods have Zod schema validation, access to the ALS context, and are callable from the client SDK.

## With Express

```tsx
import { createExpressMiddleware } from "@agentick/express";

const app = express();
app.use("/api", createExpressMiddleware({ gateway }));
```

This mounts SSE endpoints for streaming and method endpoints for RPC.
