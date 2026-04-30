# @agentick/mcp

Standalone, world-class [Model Context Protocol](https://modelcontextprotocol.io) server and client. Depends only on `@agentick/kernel` and `@agentick/shared` — no core, no gateway, no framework coupling. Drop it into any Node runtime.

> **Note:** If you're building a web/chat agent that already uses `@agentick/gateway`, the gateway's `mcpServerPlugin` wraps this package for you. You can still use this package directly to build standalone MCP servers (stdio for Claude Desktop, HTTP for web clients, in-process for tests).

## Installation

```bash
pnpm add @agentick/mcp
```

Peer dependencies are resolved automatically via the workspace. For external consumers, `@modelcontextprotocol/sdk` and `zod` are required runtime deps and come along with the install.

## What you get

- **`MCPServer`** — a per-session SDK `Server` pool with a shared registry, dynamic tool/resource/prompt registration, notification fan-out (`tools/list_changed`, `resources/list_changed`), structured error sanitization, and a fully pluggable security pipeline.
- **`MCPClient`** — a multi-server connection pool with tool, resource, and prompt caching; automatic cache invalidation on server-side list-changed notifications; progress callbacks; sampling, roots, logging, completions, and cancellation support.
- **Security pipeline** — `ConnectionGuard → contextProvider → Authenticator → Authorizer → RateLimiter → InputSanitizer`, fully pluggable with safe transport-aware defaults.
- **MCP Apps (local variant)** — `createMCPApp` wraps `@modelcontextprotocol/ext-apps`'s `AppBridge` + `PostMessageTransport`, enforces tool visibility from `_meta.ui.visibility`, and ships helpers for the iframe sandbox (`buildAllowAttribute`, `isToolVisibleToApps`, `getToolAppUri`).
- **158 tests** covering the server, client, security, protocol, transport integration, and full HTTP lifecycle.

## Quick Start — Server

### Stdio server (Claude Desktop / Cursor / Claude Code)

```typescript
import { MCPServer, toolResult } from "@agentick/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new MCPServer({
  name: "my-server",
  version: "1.0.0",
  tools: [
    {
      name: "greet",
      description: "Greet a user by name",
      inputSchema: z.object({ name: z.string() }),
      handler: async (input) => toolResult(`Hello, ${input.name}!`),
    },
  ],
});

await server.connect(new StdioServerTransport());
```

### HTTP server (web clients, Ernesto, external MCP clients)

```typescript
import http from "node:http";
import { MCPServer } from "@agentick/mcp";

const server = new MCPServer({
  name: "my-http-server",
  version: "1.0.0",
  tools: [
    /* ... */
  ],
  security: {
    authenticator: async (ctx) =>
      ctx.user?.id ? { authenticated: true } : { authenticated: false, reason: "missing user" },
  },
  contextProvider: async (extra) => {
    const token = extra.requestInfo?.headers?.authorization?.replace("Bearer ", "");
    const user = token ? await verifyJwt(token) : undefined;
    return { user };
  },
});

http
  .createServer(async (req, res) => {
    if (req.url === "/mcp") {
      await server.handleHTTPRequest(req, res);
    } else {
      res.writeHead(404).end();
    }
  })
  .listen(3000);
```

`handleHTTPRequest` is fully [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#streamable-http) compatible — it handles session initialization, event streaming, and reconnection using `mcp-session-id` headers.

### In-process server (for tests, embedded agents)

```typescript
import { MCPServer, MCPClient, InMemoryTransport } from "@agentick/mcp";

const server = new MCPServer({ name: "test", version: "1.0.0", tools: [...] });
const client = new MCPClient();

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect({
  serverName: "test",
  transport: "in-process",
  connection: { transport: clientTransport },
});
```

## Server API

### Tools

```typescript
import { MCPServer, toolResult, toolError } from "@agentick/mcp";
import { z } from "zod";

const server = new MCPServer({
  name: "search-server",
  version: "1.0.0",
  tools: [
    {
      name: "search",
      description: "Full-text search the knowledge base",
      inputSchema: z.object({
        query: z.string(),
        limit: z.number().optional().default(10),
      }),
      annotations: {
        title: "Search",
        readOnlyHint: true,
        idempotentHint: true,
      },
      handler: async (input, ctx) => {
        const results = await db.search(input.query, input.limit);
        if (results.length === 0) {
          return toolError("No matches");
        }
        return toolResult(JSON.stringify(results, null, 2));
      },
    },
  ],
});
```

**Input schema** accepts either a Zod schema or a raw JSON Schema object. Zod is converted via the SDK's `toJsonSchemaCompat`, which handles Zod v4 natively.

**Handler signature:**

```typescript
type MCPToolHandler = (
  input: Record<string, unknown>,
  ctx: MCPHandlerContext,
) => CallToolResult | Promise<CallToolResult>;

interface MCPHandlerContext {
  request: MCPRequestContext; // enriched context — user, session, client info
  extra: MCPHandlerExtra; // raw SDK extra — for low-level needs
  sessionId: string; // shortcut for request.session.sessionId
  signal: AbortSignal; // aborted on client cancellation
  sendProgress?: (progress: number, total?: number, message?: string) => Promise<void>;
}
```

**Result helpers:**

```typescript
import { toolResult, toolError, toMCPResult } from "@agentick/mcp";

toolResult("plain text"); // single text content block
toolError("something went wrong"); // { isError: true } tool result
toMCPResult({ content: [{ type: "text", text: "..." }] }); // normalize loose shapes into CallToolResult
```

For multi-block or non-text content, build `CallToolResult` directly:

```typescript
return {
  content: [
    { type: "text", text: "Here's the image:" },
    { type: "image", data: base64, mimeType: "image/png" },
  ],
};
```

### Static resources

```typescript
const server = new MCPServer({
  name: "docs-server",
  version: "1.0.0",
  resources: [
    {
      name: "readme",
      uri: "docs://readme",
      description: "Project README",
      mimeType: "text/markdown",
      read: async (ctx) => ({
        contents: [
          {
            uri: "docs://readme",
            mimeType: "text/markdown",
            text: await fs.readFile("./README.md", "utf8"),
          },
        ],
      }),
    },
  ],
});
```

### Resource templates (parameterized URIs)

```typescript
const server = new MCPServer({
  name: "db-explorer",
  version: "1.0.0",
  resourceTemplates: [
    {
      name: "table-schema",
      uriTemplate: "db://schema/{table}",
      description: "Schema definition for a database table",
      mimeType: "application/json",
      list: async (ctx) => ({
        resources: (await db.listTables()).map((name) => ({
          uri: `db://schema/${name}`,
          name: `${name} schema`,
          mimeType: "application/json",
        })),
      }),
      read: async (uri, variables, ctx) => {
        const schema = await db.describeTable(variables.table);
        return {
          contents: [{ uri, mimeType: "application/json", text: JSON.stringify(schema) }],
        };
      },
      complete: {
        table: async (prefix) => (await db.listTables()).filter((t) => t.startsWith(prefix)),
      },
    },
  ],
});
```

`complete` provides argument autocomplete for clients that support it — the MCP client surfaces `database-schema?table=<completion>` hints to the user.

### Prompts

```typescript
const server = new MCPServer({
  name: "reports",
  version: "1.0.0",
  prompts: [
    {
      name: "summarize",
      description: "Summarize a document",
      arguments: [
        { name: "document_id", description: "ID of the document", required: true },
        { name: "length", description: "Target length in words" },
      ],
      handler: async (args, ctx) => {
        const doc = await getDocument(args.document_id);
        return {
          description: `Summary prompt for ${doc.title}`,
          messages: [
            {
              role: "user",
              content: {
                type: "text",
                text: `Summarize in ${args.length ?? 200} words:\n\n${doc.text}`,
              },
            },
          ],
        };
      },
    },
  ],
});
```

### Argument completion (server-side)

Both prompts and resource templates accept a `complete` map keyed by
argument name. When the client calls `completion/complete` while the
user is typing, the matching handler returns suggestions. Per MCP spec
2025-11-25, responses are capped at 100 values — the sugar builders
enforce this automatically and set `hasMore: true` when truncated.

```typescript
import {
  completeFromList,
  completeFromEnum,
  completePrefixMatch,
  completeDependent,
  completeFromAsync,
} from "@agentick/mcp";
import { z } from "zod";

const Status = z.enum(["open", "closed", "in_progress", "on_hold"]);

const server = new MCPServer({
  name: "knowify",
  version: "1.0.0",
  prompts: [
    {
      name: "brief-me-on-project",
      description: "Generate a project briefing prompt",
      arguments: [
        { name: "tenant", required: true },
        { name: "projectId", required: true },
        { name: "status" },
      ],
      complete: {
        // Static list — prefix-filtered as the user types.
        status: completeFromEnum(Status),

        // Lazy loader — fetches every time, sugar prefix-matches.
        tenant: completePrefixMatch(async () => {
          const tenants = await db.tenants.list();
          return tenants.map((t) => t.id);
        }),

        // Depends on `tenant` having been entered first; sugar returns
        // empty values without invoking the loader if it isn't.
        projectId: completeDependent({ requires: ["tenant"] }, async (typed, { tenant }) => {
          const projects = await db.projects.find({ tenantId: tenant });
          return projects.map((p) => p.id);
        }),
      },
      handler: async (args) => ({
        messages: [{ role: "user", content: { type: "text", text: `brief ${args.projectId}` } }],
      }),
    },
  ],
  resourceTemplates: [
    {
      name: "table-schema",
      uriTemplate: "db://schema/{table}",
      complete: {
        // Static list of valid tables.
        table: completeFromList(["users", "projects", "invoices", "time_entries"]),
      },
      read: async (uri, vars) => ({
        contents: [{ uri, text: await db.describe(vars.table) }],
      }),
    },
  ],
});
```

**Sugar builders:**

| Builder                               | When to use                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `completeFromList(values)`            | Static array, prefix-filtered case-sensitively.                                                                    |
| `completeFromEnum(zodEnum)`           | Same, but extract from a Zod enum (or any `{ options }` shape).                                                    |
| `completePrefixMatch(loader)`         | Lazy loader returns full set; sugar prefix-matches.                                                                |
| `completeDependent({ requires }, fn)` | Loader needs sibling args; sugar gates on their presence and surfaces them as the second argument.                 |
| `completeFromAsync(fn)`               | Escape hatch — full control over `values`/`total`/`hasMore`. Receives `(value, ctx)` with `ctx.resolvedArguments`. |

The server only advertises the `completions: {}` capability when at
least one prompt or template carries a `complete` map. Without
handlers, the capability is omitted and `completion/complete` requests
hit `MethodNotFound`, signaling to clients that they shouldn't
auto-complete in this server's UI.

### MCP Apps (ui:// resources)

```typescript
const server = new MCPServer({
  name: "dashboard",
  version: "1.0.0",
  apps: [
    {
      name: "project-dashboard",
      uri: "ui://project-dashboard",
      description: "Interactive project dashboard",
      content: () => fs.readFile("./dashboards/project.html", "utf8"),
      csp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://cdn.example.com"],
      },
      permissions: ["clipboardWrite"],
      prefersBorder: true,
    },
  ],
  tools: [
    {
      name: "render_dashboard",
      description: "Show the project dashboard UI",
      inputSchema: z.object({ projectId: z.string() }),
      // Link this tool to the ui:// resource — clients that support MCP Apps
      // will render the iframe when this tool is called.
      ui: { resourceUri: "ui://project-dashboard", visibility: ["app"] },
      handler: async () => toolResult("Dashboard rendered"),
    },
  ],
});
```

Tool `visibility` controls which caller can invoke the tool:

- `["model"]` — only the LLM can call (default behavior — hidden from apps)
- `["app"]` — only the iframe can call (e.g., button clicks)
- `["model", "app"]` — both
- unset — visible to any caller

### Security pipeline

Every MCP request flows through a fixed pipeline:

```
ConnectionGuard → contextProvider → Authenticator → Authorizer → RateLimiter → InputSanitizer → handler
```

Each stage is independently pluggable. The `security` option in `MCPServerOptions` configures them:

```typescript
import {
  MCPServer,
  type ConnectionGuard,
  type Authenticator,
  type Authorizer,
  type RateLimiter,
  type InputSanitizer,
} from "@agentick/mcp";

const connectionGuard: ConnectionGuard = async (info) => {
  // Evaluated once per HTTP connection. Return false to reject.
  return info.remoteAddress === "127.0.0.1";
};

const authenticator: Authenticator = async (ctx) => {
  if (!ctx.user?.id) return { authenticated: false, reason: "No user" };
  return { authenticated: true };
};

const authorizer: Authorizer = async (ctx, op) => {
  // op.type: "tool_call" | "resource_read" | "resource_list" | "prompt_get" | "session_create"
  // op.name: the tool/resource/prompt name
  if (op.type === "tool_call" && op.name === "admin_reset") {
    const allowed = ctx.user?.roles?.includes("admin") ?? false;
    return allowed ? { allowed: true } : { allowed: false, reason: "admin only" };
  }
  return { allowed: true };
};

const rateLimiter: RateLimiter = async (ctx, op) => {
  const key = `${ctx.user?.id ?? "anon"}:${op.type}`;
  const allowed = (await redis.incr(key, { ttl: 60 })) < 100;
  return allowed ? { allowed: true } : { allowed: false, retryAfterMs: 60_000 };
};

const inputSanitizer: InputSanitizer = async (ctx, toolName, input) => {
  if (toolName === "read_file" && typeof input.path === "string") {
    // Strip traversal attempts
    input.path = input.path.replace(/\.\.\//g, "");
  }
  return input;
};

const server = new MCPServer({
  name: "hardened",
  version: "1.0.0",
  tools: [
    /* ... */
  ],
  security: { connectionGuard, authenticator, authorizer, rateLimiter, inputSanitizer },
  contextProvider: async (extra) => ({ user: extractUser(extra) }),
});
```

Defaults are transport-aware — safe out of the box:

| Transport                 | connectionGuard     | authenticator   |
| ------------------------- | ------------------- | --------------- |
| `streamable-http` / `sse` | `localOnlyGuard`    | `rejectAllAuth` |
| `stdio` / `in-process`    | (skipped — trusted) | `allowAllAuth`  |

**This means an HTTP server with no configured security will reject all requests until you provide an authenticator.** This is intentional.

Stage rejection throws `SecurityError` with an HTTP-style status code (`401` / `403` / `429`), which `MCPServer` converts into an appropriate JSON-RPC error or HTTP response.

### Production security stages

The package ships five ready-to-use stage factories that cover the 80% case. Each returns a plain function with the corresponding type signature — drop it into `security.*` and you're done.

#### `bearerTokenAuth`

```typescript
import { bearerTokenAuth } from "@agentick/mcp";

// Static tokens (dev / internal tools)
security: {
  authenticator: bearerTokenAuth({
    tokens: {
      "dev-token-123": { id: "alice", roles: ["user"] },
    },
  }),
},

// JWT verification (production)
security: {
  authenticator: bearerTokenAuth({
    verify: async (token) => {
      const claims = await verifyJwt(token);
      return { id: claims.sub, roles: claims.roles };
    },
  }),
},
```

Reads the Authorization header from `ctx.requestInfo?.headers` (populated automatically for HTTP transports) by default. Override via `extract` for non-HTTP transports or custom header locations.

#### `roleBasedAuthz`

```typescript
import { roleBasedAuthz } from "@agentick/mcp";

security: {
  authorizer: roleBasedAuthz({
    rules: {
      "tool_call:admin_reset": ["admin"],     // specific tool
      "tool_call:*": ["user", "admin"],       // any other tool
      "resource_read:*": [],                   // any authenticated user
      "session_create": [],                    // any authenticated user
    },
  }),
},
```

Specificity: `tool_call:name` beats `tool_call:*` beats `*`. Missing rule = implicit deny. Empty `roles: []` = any authenticated user. Override `getRoles` to source roles from somewhere other than `ctx.user.roles`.

#### `slidingWindowLimiter`

```typescript
import { slidingWindowLimiter } from "@agentick/mcp";

security: {
  rateLimiter: slidingWindowLimiter({
    windowMs: 60_000,
    max: 100,
    keyFn: (ctx, op) => `${ctx.user?.id ?? "anon"}:${op.name ?? op.type}`,
    onReject: (key, retryAfterMs) => metrics.inc("rate_limit.rejected", { key }),
  }),
},
```

In-memory sliding window. Tracks timestamps per key, rejects when the window count exceeds `max`. Returns `retryAfterMs` when rejected. For distributed rate limiting across multiple instances, replace with a Redis-backed limiter that implements the same `RateLimiter` signature.

#### `allowListGuard`

```typescript
import { allowListGuard } from "@agentick/mcp";

security: {
  connectionGuard: allowListGuard({
    origins: ["https://app.example.com", "https://*.example.com"],
    remoteAddresses: ["10.0.0.0/8", "127.0.0.1", "::1"],
    // requireBoth: true,  // uncomment to require BOTH origin AND IP match
  }),
},
```

Supports exact matches, glob wildcards for origins, and CIDR ranges for IPv4/IPv6. IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) are normalized. Either/or matching by default — set `requireBoth: true` to require both checks to pass.

#### `pathTraversalSanitizer`

```typescript
import { pathTraversalSanitizer } from "@agentick/mcp";

security: {
  inputSanitizer: pathTraversalSanitizer({
    fields: ["path", "filename"],             // optional — auto-detected by name if omitted
    allowedRoots: ["/workspace/", "/tmp/"],   // optional — reject paths outside these roots
    mode: "reject",                            // "reject" (default) or "strip"
  }),
},
```

Detects and rejects:

- Literal `..` path segments (`../etc/passwd`)
- URL-encoded traversal (`%2e%2e/etc/passwd`)
- Double-URL-encoded traversal (`%252e%252e/etc/passwd`)
- Backslash-style Windows traversal (`..\\..\\etc\\passwd`)
- Null-byte truncation (`safe.txt\0.exe`)

Auto-detects path-like fields by key name (anything containing `path`, `file`, `filename`, `dir`, or `directory` — case-insensitive). Set `fields` explicitly to override.

> **Note:** Path sanitization is defense-in-depth, not a substitute for real sandboxing. Use `@agentick/sandbox` or OS-level isolation (chroot, namespaces, containers) for hard boundaries.

### Security schemes (OAuth metadata)

Advertise authentication requirements to MCP hosts so they can trigger their OAuth UI:

```typescript
const server = new MCPServer({
  ...,
  securitySchemes: [{ type: "oauth2", scopes: ["read", "write"] }],
});
```

This emits `_meta.securitySchemes` on every tool in the `tools/list` response. Individual tools can override with their own `_meta.securitySchemes`. MCP hosts like ChatGPT and Claude use this to know which tools require authentication.

### Composing stages

Each factory returns a function — you can wrap, compose, or chain them yourself:

```typescript
// Multiple authenticators in sequence — try JWT first, fall back to API key
const jwtAuth = bearerTokenAuth({ verify: verifyJwt });
const apiKeyAuth = bearerTokenAuth({ tokens: staticKeys });

security: {
  authenticator: async (ctx) => {
    const jwt = await jwtAuth(ctx);
    if (jwt.authenticated) return jwt;
    return apiKeyAuth(ctx);
  },
},
```

### Request context

`contextProvider` is user-supplied; it runs before the security pipeline and shapes `MCPRequestContext`. After `contextProvider` runs, the server automatically enriches the context with session metadata, client identity, and SDK passthrough fields.

```typescript
const server = new MCPServer({
  ...,
  contextProvider: async (extra) => ({
    user: {
      id: extra.authInfo?.clientId ?? "anon",
      roles: extra.authInfo?.scopes ?? [],
    },
    metadata: { gatewayId: "prod-1" },
    signal: extra.signal,
  }),
});
```

**`MCPRequestContext` — the full shape:**

```typescript
interface MCPRequestContext {
  // Application-level (from contextProvider)
  user?: UserContext; // authenticated user identity
  metadata?: Record<string, any>; // arbitrary app metadata (tracing, provenance)
  signal?: AbortSignal; // cancellation

  // Client identity (auto-populated from SDK initialize handshake)
  clientInfo?: { name: string; version?: string }; // e.g. { name: "claude-desktop" }
  clientCapabilities?: Record<string, unknown>; // sampling, apps, etc.

  // Session (auto-populated from server session registry)
  session?: {
    sessionId: string;
    transportType: "in-process" | "streamable-http" | "sse" | "stdio";
    createdAt: number;
  };

  // SDK passthrough (auto-populated from RequestHandlerExtra)
  authInfo?: Record<string, unknown>; // OAuth/RFC 9728 token claims
  requestId?: string | number; // JSON-RPC request ID
  _meta?: Record<string, unknown>; // request-level metadata
  taskId?: string; // SDK task ID (long-running ops)
  requestInfo?: unknown; // original HTTP request info
}
```

The `contextProvider` has first say on all fields. The server fills in anything the provider didn't set — `session` from the session registry, `clientInfo`/`clientCapabilities` from the SDK handshake, and `authInfo`/`requestId`/`_meta`/`taskId`/`requestInfo` from the SDK's request extras.

Every handler (tool, resource, prompt) receives the enriched context via `ctx.request`:

```typescript
handler: async (input, ctx) => {
  const userId = ctx.request.user?.id;
  const transport = ctx.request.session?.transportType; // "in-process" | "streamable-http" | ...
  const client = ctx.request.clientInfo?.name; // "claude-desktop" | "cursor" | ...
};
```

### Tool filtering and transformation

`toolFilter` and `toolTransform` run per-request with the full `MCPRequestContext`, enabling per-session tool visibility and customization.

**`toolFilter`** — return `false` to hide a tool from a specific client or session:

```typescript
const server = new MCPServer({
  ...,
  toolFilter: (tool, ctx) => {
    // In-process agents (e.g., ernesto) never see the ask tool (prevents recursion)
    if (ctx.session?.transportType === "in-process") {
      return tool.name !== "ask_agent";
    }
    // Non-enterprise external clients don't get the premium tool
    if (!ctx.user?.isEnterprise) {
      return tool.name !== "ask_agent";
    }
    return true;
  },
});
```

`toolFilter` is also enforced at `tools/call` time — a client cannot invoke a tool that was filtered from its `tools/list`.

**`toolTransform`** — modify tool definitions per-session (e.g., inject user context into descriptions):

```typescript
const server = new MCPServer({
  ...,
  toolTransform: (tool, ctx) => {
    if (tool.name !== "query") return tool;
    return {
      ...tool,
      description: `${tool.description}\n\nCurrent user: ${ctx.user?.name}`,
    };
  },
});
```

Return `null` from `toolTransform` to remove a tool from the list (alternative to `toolFilter`).

### Dynamic registration

Tools, resources, and prompts can be added or removed at runtime. All connected clients receive `tools/list_changed` / `resources/list_changed` / `prompts/list_changed` notifications automatically.

```typescript
// Add a tool
server.addTool({
  name: "new_tool",
  description: "Added at runtime",
  inputSchema: z.object({ input: z.string() }),
  handler: async (input) => toolResult(`Got: ${input.input}`),
});

// Remove
server.removeTool("new_tool");

// Resources and prompts follow the same pattern
server.addResource({ ... });
server.removeResource(uri);
server.addPrompt({ ... });
server.removePrompt(name);
```

### Session management

Each connected MCP client gets its own SDK `Server` instance internally. Sessions are tracked by session ID with idle TTL:

```typescript
const server = new MCPServer({
  name: "my-server",
  version: "1.0.0",
  sessions: {
    idleTtlMs: 30 * 60_000, // evict after 30 min idle
    maxSessions: 1000, // hard cap
    cleanupIntervalMs: 60_000, // sweep interval
  },
});
```

Idle sweeps happen automatically. Active sessions are extended on every request. Eviction closes the SDK `Server` for that session gracefully.

### Lifecycle

```typescript
const server = new MCPServer({
  /* ... */
});

// For stdio / in-process — one Transport:
await server.connect(transport);

// For HTTP — no connect() call; routes pipe into handleHTTPRequest:
http.createServer((req, res) => server.handleHTTPRequest(req, res)).listen(3000);

// Events
server.on("session:created", (e) => console.log("new session", e.sessionId));
server.on("session:closed", (e) => console.log("session closed", e.sessionId));
server.on("tool:called", (e) => metrics.inc("tool.called", { tool: e.toolName }));
server.on("security:rejected", (e) => log.warn("rejected", e));

// Shutdown
await server.close();
```

### Roots — query the client's filesystem boundaries

`MCPServer.listRoots(sessionId, opts?)` fetches the client's declared
roots and caches the result per session. The cache is invalidated
automatically when the client emits `notifications/roots/list_changed`.

```typescript
import { MCPServer } from "@agentick/mcp";

const server = new MCPServer({
  /* ... */
});

// Fetch roots from a connected client
const roots = await server.listRoots(sessionId);
// → [{ uri: "file:///workspace/project-a", name: "project-a" }, ...]

// Force refresh (bypass cache)
const fresh = await server.listRoots(sessionId, { force: true });
```

**Behavior:**

- Returns `[]` when the client did not advertise the `roots` capability
  (no round-trip).
- Caches per session; subsequent calls within a session hit memory.
- Invalidated by `notifications/roots/list_changed`. Subscribers fire on
  every refresh.
- Per spec 2025-11-25, root URIs MUST be `file://`. The SDK rejects
  non-file URIs at parse time; our defensive filter (`isValidRootUri`)
  is exposed for direct callers of the type system.

**Sugar — `ctx.roots.*`** is always present on `MCPHandlerContext`.
Permissive default: with no roots declared, `assertWithin` and `isWithin`
pass. With roots declared, they enforce containment.

```typescript
import { MCPServer, toolResult } from "@agentick/mcp";
import { z } from "zod";

const server = new MCPServer({
  name: "fs",
  version: "1.0.0",
  tools: [
    {
      name: "read_file",
      inputSchema: z.object({ path: z.string() }),
      handler: async (input, ctx) => {
        // Reject paths outside the client's declared roots.
        await ctx.roots.assertWithin(input.path);
        const content = await fs.readFile(input.path, "utf8");
        return toolResult(content);
      },
    },
    {
      name: "scan_workspace",
      inputSchema: z.object({ pattern: z.string() }),
      handler: async (input, ctx) => {
        const roots = await ctx.roots.list();
        const matches = (await Promise.all(roots.map((r) => scan(r, input.pattern)))).flat();
        return toolResult(JSON.stringify(matches, null, 2));
      },
    },
    {
      name: "find_root",
      inputSchema: z.object({ path: z.string() }),
      handler: async (input, ctx) => {
        const root = await ctx.roots.rootContaining(input.path);
        return toolResult(root ? `belongs to ${root.name ?? root.uri}` : "outside roots");
      },
    },
    {
      name: "open_relative",
      inputSchema: z.object({ rel: z.string(), root: z.string().optional() }),
      handler: async (input, ctx) => {
        // Resolves against the first root by default; pass `name` for a
        // specific root.
        const abs = await ctx.roots.resolveRelative(input.rel, { name: input.root });
        return toolResult(`absolute path: ${abs}`);
      },
    },
  ],
});
```

**`ctx.roots` API:**

| Method                        | Purpose                                                         |
| ----------------------------- | --------------------------------------------------------------- |
| `list()`                      | Cached `Root[]`; `[]` when client lacks capability.             |
| `isWithin(path)`              | Boolean. Permissive (true) when no roots declared.              |
| `assertWithin(path)`          | Throws if path is outside all roots. No-op when none declared.  |
| `rootContaining(path)`        | Returns matching root (longest-prefix wins) or `null`.          |
| `resolveRelative(rel, opts?)` | Joins against first root (or named root). Throws when no roots. |
| `subscribe(listener)`         | Fires on `roots/list_changed`. Returns `unsubscribe`.           |

Both `isWithin` and `assertWithin` accept POSIX paths and `file://` URIs
interchangeably and honor URI percent-encoding. Sibling-name false
matches (`/workspace` vs `/workspace-other`) are rejected.

### Server-to-client requests

`MCPServer.request<T>(sessionId, method, params, opts?)` lets the server
issue a JSON-RPC request to a connected client and await its response.
This is the load-bearing primitive that powers sampling, elicitation,
roots, and any other bidirectional MCP feature.

```typescript
import { MCPServer, SessionNotFoundError } from "@agentick/mcp";
import { ListRootsResultSchema } from "@modelcontextprotocol/sdk/types.js";

// Inside a tool handler — `ctx.sessionId` identifies the calling client.
const server = new MCPServer({
  /* ... */
});

const tool = {
  name: "scan_workspace",
  inputSchema: z.object({ pattern: z.string() }),
  handler: async (input, ctx) => {
    // Ask the client which roots it has declared
    const { roots } = await server.request(
      ctx.sessionId,
      "roots/list",
      {},
      {
        resultSchema: ListRootsResultSchema,
        timeoutMs: 5_000,
      },
    );

    const matches = await scan(roots, input.pattern);
    return toolResult(JSON.stringify(matches, null, 2));
  },
};
```

**Options:**

| Option         | Default           | Purpose                                                                               |
| -------------- | ----------------- | ------------------------------------------------------------------------------------- |
| `resultSchema` | `z.unknown()`     | Zod schema validating (and typing) the response. Without it, the result is `unknown`. |
| `timeoutMs`    | SDK default (60s) | Hard timeout. Rejects with `RequestTimeout`.                                          |
| `signal`       | none              | `AbortSignal` for explicit cancellation. Pre-aborted signals reject immediately.      |

**Errors:**

- `SessionNotFoundError` — the requested `sessionId` is not currently
  connected. Distinct from JSON-RPC errors; never makes it onto the
  wire. Carries `.sessionId`.
- Timeout / abort errors propagate from the SDK with their original
  shape.
- Client-side handler errors are mapped to the JSON-RPC error response
  and surfaced as a clean (single-prefix) `MCP error <code>: <msg>`.

The Phase 4 (sampling) and Phase 5 (elicitation) sugar surfaces — the
forthcoming `ctx.sample.*` and `ctx.elicit.*` APIs — wrap this primitive
with typed shortcuts (`ctx.sample.text(prompt)`, `ctx.elicit.confirm(...)`,
etc.) and capability gating. Use `MCPServer.request` directly for any
bidirectional method not yet covered by sugar.

## Quick Start — Client

```typescript
import { MCPClient } from "@agentick/mcp";

const client = new MCPClient({
  name: "my-agent",
  version: "1.0.0",
});

await client.connect({
  serverName: "search",
  transport: "streamable-http",
  connection: { url: "https://mcp.example.com/mcp" },
  auth: { type: "bearer", token: process.env.MCP_TOKEN },
});

const tools = await client.listTools("search");
const result = await client.callTool("search", "search", { query: "ankane" });
```

## Client API

### Connection management

```typescript
// Single server
await client.connect({
  serverName: "github",
  transport: "streamable-http",   // or "sse" | "stdio" | "in-process"
  connection: { url: "https://mcp.github.com/mcp" },
  auth: { type: "bearer", token: "..." },
});

// Multiple servers — the client maintains a pool
await client.connect({ serverName: "linear", ... });
await client.connect({ serverName: "knowify", ... });

// Per-server health
client.getHealth("github");
// → { serverName, state: "connected", lastConnectedAt, lastErrorAt?, lastError? }

// Disconnect
await client.disconnect("github");
await client.disconnectAll();
```

**Automatic reconnection** — when a non-local connection drops unexpectedly, the client schedules a reconnect with exponential backoff. Reconnection state is observable via events:

```typescript
client.on("connection:state", ({ serverName, state }) => {
  // state: "connected" | "disconnected" | "reconnecting" | "degraded"
});
```

Stdio and in-process transports are NOT auto-reconnected (the process is gone or the transport is bound to a specific lifetime).

### Tools

```typescript
// Discover
const tools = await client.listTools("github");
// → DiscoveredTool[] — { name, description, inputSchema, annotations, serverName }

// Call with cancellation
const controller = new AbortController();
const result = await client.callTool(
  "github",
  "create_issue",
  {
    owner: "agenticklabs",
    repo: "agentick",
    title: "feat: something",
  },
  { signal: controller.signal },
);

// Call with progress
const result = await client.callTool("slow-server", "long_tool", input, {
  onProgress: (info) => console.log(`${info.progress}/${info.total}`, info.message),
});
```

The tool list cache is invalidated automatically when the server sends `notifications/tools/list_changed`. The `tools:changed` event fires:

```typescript
client.on("tools:changed", ({ serverName }) => {
  console.log(`${serverName} updated its tool list`);
});
```

### Resources

```typescript
// List
const resources = await client.listResources("knowify");
const templates = await client.listResourceTemplates("knowify");
const allResources = await client.listAllResources(); // every server
const allTemplates = await client.listAllResourceTemplates();

// Read
const contents = await client.readResource("knowify", "db://schema/projects");
// → ResourceContent[] — { uri, text?, blob?, mimeType? }

// Read by URI — picks the right server automatically
const contents = await client.readResourceByURI("db://schema/projects");

// Invalidate cache manually
client.invalidateResources("knowify");
client.invalidateResources(); // all servers

// Event when server sends resources/list_changed
client.on("resources:changed", ({ serverName }) => {
  /* ... */
});
```

### Prompts

```typescript
const prompts = await client.listPrompts("reports");
// → DiscoveredPrompt[] — { name, description, arguments, serverName }

const result = await client.getPrompt("reports", "summarize", {
  document_id: "doc-123",
  length: "150",
});
// → { description, messages: [...] }

client.invalidatePrompts("reports");
client.on("prompts:changed", ({ serverName }) => {
  /* ... */
});
```

### Completions

```typescript
// Prompt argument completion
const values = await client.completePromptArgument("reports", "summarize", "document_id", "doc-1");

// Resource template variable completion
const values = await client.completeResourceArgument(
  "knowify",
  "db://schema/{table}",
  "table",
  "proj",
);
```

### Sampling (server asks client's model to generate)

If the server uses `sampling/createMessage`, the client routes it to a handler you provide:

```typescript
import { MCPClient, type SamplingHandler } from "@agentick/mcp";

const samplingHandler: SamplingHandler = async (request) => {
  // request: { messages, modelPreferences?, systemPrompt?, temperature?, maxTokens, ... }
  const response = await myModel.generate(request);
  return {
    role: "assistant",
    content: { type: "text", text: response.text },
    model: "gpt-4o",
    stopReason: response.stopReason,
  };
};

const client = new MCPClient({ samplingHandler });
```

The `sampling` capability is automatically advertised during initialization when a handler is provided.

### Roots

```typescript
const client = new MCPClient({
  roots: [{ uri: "file:///workspace/project", name: "project" }, { uri: "file:///tmp/scratch" }],
});

// Notify servers when roots change
await client.sendRootsChanged("some-server");
```

### Logging

```typescript
const client = new MCPClient({
  logHandler: (message, serverName) => {
    console.log(`[${serverName}] ${message.level}: ${message.data}`);
  },
});

// Change server's log level
await client.setLogLevel("some-server", "debug");
```

### Other events

```typescript
client.on("connection:state", ({ serverName, state }) => {
  /* ... */
});
client.on("tools:changed", ({ serverName }) => {
  /* ... */
});
client.on("resources:changed", ({ serverName }) => {
  /* ... */
});
client.on("prompts:changed", ({ serverName }) => {
  /* ... */
});
client.on("error", (err) => {
  /* ... */
});
```

## MCP Apps (local variant)

`createMCPApp` wires a sandboxed iframe to a running `MCPClient` via [ext-apps](https://github.com/modelcontextprotocol/ext-apps)'s `AppBridge` + `PostMessageTransport`.

```typescript
import {
  createMCPApp,
  buildAllowAttribute,
  isToolVisibleToApps,
  getToolAppUri,
} from "@agentick/mcp/client";

// 1. Read the ui:// resource HTML from the server
const contents = await mcpClient.readResource("knowify", "ui://dashboard");
const html = contents[0].text;

// 2. Create the iframe with a sandbox
const iframe = document.createElement("iframe");
iframe.sandbox.add("allow-scripts");
iframe.allow = buildAllowAttribute({ clipboardWrite: true });
iframe.srcdoc = html;
document.getElementById("chat-log").appendChild(iframe);
await new Promise((r) => (iframe.onload = r));

// 3. Wire up the bridge
const app = await createMCPApp({
  mcpClient,
  serverName: "knowify",
  iframe,
  hostCapabilities: { displayMode: { supported: ["inline", "modal"] } },
  hostInfo: { name: "knowify-portal", version: "1.0.0" },
  enforceVisibility: true,
});

// 4. Clean up when the iframe is removed
await app.close();
```

Visibility enforcement is defense-in-depth — the bridge caches the server's tool list and rejects calls to tools whose `_meta.ui.visibility` doesn't include `"app"` before they hit the wire. The authoritative check still happens server-side in the `Authorizer`.

**This variant requires the `MCPClient` and the iframe to live in the same process** — it's suitable for Claude Desktop, Cursor, Electron apps, and browser extensions where the MCP connection and the UI are co-located. For cloud-agent + remote-browser topologies, a relay variant is planned (see [Deferred](#deferred) below).

## Gateway integration

`@agentick/gateway`'s `mcpServerPlugin` wraps `@agentick/mcp`'s `MCPServer` and exposes gateway tools, resources, and templates over an MCP HTTP endpoint. The plugin handles auth via gateway middleware — the embedded MCP server trusts the request context the plugin provides.

```typescript
import { createGateway, mcpServerPlugin } from "@agentick/gateway";

const gateway = createGateway({
  apps: { assistant: myAgent },
  defaultApp: "assistant",
  plugins: [
    mcpServerPlugin({
      path: "/mcp",
      serverName: "my-gateway",
      sessionId: "assistant:main",
      tools: [
        {
          name: "echo",
          description: "Echo input",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
          handler: async (args) => ({
            content: [{ type: "text", text: String(args.text) }],
          }),
        },
      ],
      resources: [
        /* MCPStaticResource[] */
      ],
      resourceTemplates: [
        /* MCPResourceTemplate[] */
      ],
      toolFilter: (tool, ctx) => !tool.name.startsWith("admin_") || isAdmin(ctx),
    }),
  ],
});
```

See `@agentick/gateway`'s README for the full plugin surface.

## Core integration

`@agentick/core` ships a thin adapter (`packages/core/src/mcp/client.ts`) that wraps `@agentick/mcp`'s `MCPClient` and preserves the existing core API surface (`MCPClient`, `MCPService`, `MCPTool`, `MCPResourceComponent`). Core consumers don't need to know `@agentick/mcp` exists:

```typescript
import { MCPClient, MCPService } from "@agentick/core/mcp";

const service = new MCPService(new MCPClient());
await service.discoverAndRegister(
  { serverName: "github", transport: "streamable-http", connection: { url: "..." } },
  componentContext,
);
```

Internally the core `MCPClient` is a type-mapping layer over `@agentick/mcp/client`. Same behavior, existing API, no migration needed.

## Transports

```typescript
import { InMemoryTransport } from "@agentick/mcp/transport";
// or directly from the SDK for stdio / HTTP:
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
```

| Transport         | Server                            | Client                         | Use case                                |
| ----------------- | --------------------------------- | ------------------------------ | --------------------------------------- |
| `in-process`      | `InMemoryTransport`               | `transport: "in-process"`      | Tests, embedded agents                  |
| `stdio`           | `StdioServerTransport` (from SDK) | `transport: "stdio"`           | Claude Desktop, Cursor, local CLI tools |
| `streamable-http` | `MCPServer.handleHTTPRequest`     | `transport: "streamable-http"` | Web clients, cloud agents               |
| `sse`             | (legacy SDK transport)            | `transport: "sse"`             | Legacy MCP clients                      |

## Error handling

Errors are never leaked to clients verbatim. `MCPServer` wraps uncaught handler errors in sanitized `McpError` responses with generic messages like "Resource unavailable" or "Tool execution failed". Stack traces and internal paths stay in server logs.

For explicit error results inside tool handlers:

```typescript
import { toolError } from "@agentick/mcp";

handler: async (input) => {
  if (!input.valid) return toolError("Invalid input");
  // ... happy path
};
```

Security pipeline rejections throw `SecurityError`:

```typescript
import { SecurityError } from "@agentick/mcp";

try {
  await server.handleHTTPRequest(req, res);
} catch (err) {
  if (err instanceof SecurityError) {
    res.writeHead(err.code, {
      ...(err.retryAfterMs && { "Retry-After": String(Math.ceil(err.retryAfterMs / 1000)) }),
    });
    res.end(err.message);
  }
}
```

`MCPServer.handleHTTPRequest` does this translation for you — direct error handling is only needed if you're invoking security stages manually.

## Deferred

The following are planned but not yet shipped. Nothing existing is removed — these are additive enhancements:

- **`createMCPAppRelay`** — a server-side variant of `createMCPApp` that routes iframe↔MCPClient traffic over a remote chat channel, for cloud agent + browser UI topologies (Ernesto + Knowify portal). Depends on the bidirectional channel architecture work (see `docs/channels-current-state.md` in the monorepo).
- **Kernel-level `RequestPipeline` primitive** — lifting the MCP security pipeline into `@agentick/kernel` so `@agentick/gateway` can consume the same stage factories (`bearerTokenAuth`, `roleBasedAuthz`, etc.). The stages already work standalone against the MCP pipeline today — this is about letting the gateway reuse them without reimplementing its own auth path.
- **JSX resources** — render agentick JSX components as MCP resources and instructions, compiled with `@agentick/core`'s compiler. This would let tool descriptions, server instructions, and resource content share composable components with agent identity prompts.

## Further reading

- [Model Context Protocol specification](https://modelcontextprotocol.io/specification)
- [MCP Apps extension](https://github.com/modelcontextprotocol/ext-apps)
- `docs/channels-current-state.md` in the monorepo — background on the architecture constraints affecting the relay variant
