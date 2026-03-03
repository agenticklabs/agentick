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

Plugins extend the gateway with methods, HTTP routes, and event handlers:

```typescript
const plugin: GatewayPlugin = {
  id: "my-plugin",
  async initialize(ctx) {
    // Register RPC methods
    ctx.registerMethod(
      "analyze",
      method({
        schema: z.object({ text: z.string() }),
        response: z.object({ sentiment: z.number() }),
        handler: async (params) => ({ sentiment: 0.8 }),
      }),
    );

    // Mount HTTP routes
    ctx.registerRoute("/webhook", async (req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });

    ctx.on("session:created", ({ sessionId }) => {
      console.log("New session:", sessionId);
    });
  },
  async destroy() {
    // Routes and methods are cleaned up automatically on plugin removal
  },
};

gateway.use(plugin);
```

Plugin methods appear alongside built-in and config methods in the schema
discovery response with `builtin: false`. Routes use longest-prefix matching —
`/v1` catches `/v1/models`, `/v1/chat/completions`, etc.

### Built-In Protocol Plugins

The gateway ships two protocol plugins that expose sessions via standard
interfaces:

**MCP Server** — any MCP client (Claude Desktop, Cursor, etc.) can connect and
use session tools:

```typescript
import { mcpServerPlugin } from "@agentick/gateway";

gateway.use(
  mcpServerPlugin({
    sessionId: "default",
    path: "/mcp",
    include: ["search", "read_file"], // optional: only expose these tools
    exclude: ["dangerous_tool"], // optional: hide these tools
  }),
);
```

Discovers tools at init via `tool-catalog`, registers each on an MCP `McpServer`
with `StreamableHTTPServerTransport`. Tool calls dispatch through the gateway's
`tool-dispatch` method.

For multi-user deployments, use `toolFilter` to customize tools per MCP client
based on the incoming HTTP request:

```typescript
gateway.use(
  mcpServerPlugin({
    sessionId: "default",
    path: "/mcp",
    toolFilter: async (tools, req) => {
      const user = await authenticate(req);
      return tools.filter((t) => user.allowedTools.includes(t.name));
    },
  }),
);
```

Each MCP client handshake creates its own `McpServer` with the filtered tool
set. Sessions are tracked by `mcp-session-id` header and cleaned up
automatically.

**OpenAI-Compatible** — any OpenAI SDK client can send chat completions:

```typescript
import { openaiCompatPlugin } from "@agentick/gateway";

gateway.use(
  openaiCompatPlugin({
    pathPrefix: "/v1",
    modelMapping: { "gpt-4o": "coding", "gpt-4": "research" },
  }),
);
```

Serves `POST /v1/chat/completions` (streaming + non-streaming) and
`GET /v1/models`. Model names route to gateway apps via `modelMapping`.
Unmatched names fall back to the gateway's default app.

## Configuration

The gateway has a built-in configuration system. Config is loaded from a JSON
file, validated, and made available to all plugins and application code.

### Config File

Create `agentick.config.json` in your project root:

```json
{
  "gateway": {
    "port": 8080,
    "host": "0.0.0.0"
  },
  "connectors": {
    "telegram": {
      "token": "${env:TELEGRAM_BOT_TOKEN}",
      "allowedUsers": [12345678]
    }
  }
}
```

### Loading Config

```typescript
import { loadConfig, bindConfig, createGateway } from "@agentick/gateway";

const configStore = await loadConfig({
  path: "./agentick.config.json",
  overrides: { gateway: { port: 9999 } }, // CLI flags, etc.
});
bindConfig(configStore);

const gateway = createGateway({
  apps: { myApp },
  defaultApp: "myApp",
  configStore, // pass to gateway
});
```

`loadConfig` returns a `ConfigStore` — it does not have side effects.
Call `bindConfig()` yourself to make it globally available.

### Reading Config

```typescript
import { getConfig } from "@agentick/gateway";

const port = getConfig().get("gateway")?.port; // typed
const telegram = getConfig().get("connectors")?.telegram; // typed if augmented
```

### Extending Config Types

Packages declare their config shape via module augmentation. This makes
`store.get()` fully typed without the gateway knowing about every consumer:

```typescript
// In your package:
declare module "@agentick/gateway" {
  interface FileConfig {
    myFeature?: {
      enabled: boolean;
      maxRetries?: number;
    };
  }
}
```

Connector plugins augment `ConnectorConfigs`:

```typescript
declare module "@agentick/gateway" {
  interface ConnectorConfigs {
    telegram?: {
      token: string;
      allowedUsers?: number[];
    };
  }
}
```

### Environment Variables and Secrets

String values matching `${env:VAR_NAME}` resolve from `process.env`.
String values matching `${secret:KEY}` resolve from a `SecretStore`.
Both are resolved before validation. Missing values throw
`ConfigValidationError`.

```json
{
  "connectors": {
    "telegram": {
      "token": "${env:TELEGRAM_BOT_TOKEN}",
      "apiKey": "${secret:MY_API_KEY}"
    }
  }
}
```

Secret-interpolated values are tracked internally. The `config` RPC method
returns a redacted version with secrets replaced by `"***"`.

### Schema Validation

Packages register schema fragments that validate their config section:

```typescript
import { registerConfigSchema } from "@agentick/gateway";

registerConfigSchema("myFeature", {
  parse: (data) => mySchema.parse(data),
  _output: {} as MyFeatureConfig,
});
```

Fragments are merged at startup. Keys without registered schemas pass through.

### Plugin Access

Plugins receive config via `PluginContext`:

```typescript
const plugin: GatewayPlugin = {
  id: "my-plugin",
  async initialize(ctx) {
    const myConfig = ctx.config.get("myFeature");
  },
};
```

### Protocol

The built-in `config` method returns the redacted configuration:

```typescript
// Client call:
const response = await client.call("config");
// { config: { gateway: { port: 8080 }, connectors: { telegram: { token: "***" } } } }
```

The `config:changed` event type is reserved for future hot-reload support.

## With Express

```typescript
import { createExpressMiddleware } from "@agentick/express";

const app = express();
app.use("/api", createExpressMiddleware({ gateway }));
```

This mounts SSE endpoints for streaming and method endpoints for RPC.
