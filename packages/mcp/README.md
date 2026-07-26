# @agentick/mcp

**Bidirectional MCP harness** — exposes Agentick as both an MCP **client**
(connect a session to N MCP servers) AND an MCP **server** (serve
Agentick's tools / prompts / elicitation as MCP to remote clients).
One package, two subpaths, ~70% shared internals (transport plumbing,
era-codec, OAuth utilities, JSON-RPC framing, Standard-Schema bridge).

Targets the MCP `draft` spec going forward; supports the latest
official (`2025-11-25`) via an **era-codec** layer at the wire edge.

Private workspace package. Bundled into the `agentick` metapackage; not
published independently.

## Subpath map

| Import path                  | Purpose                                                                                         |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `@agentick/mcp`         | **Client** harness + `withMCP` extension. Outbound: Agentick → MCP servers.                     |
| `@agentick/mcp/server`  | **Server** harness. Inbound: MCP clients → Agentick.                                            |
| `@agentick/mcp/oauth`   | OAuth 2.1 utilities shared by both sides.                                                       |
| `@agentick/mcp/testing` | `runMcpConformance` — the executable conformance suite (loopback + real-peer + version matrix). |

Subpath isolation is deliberate — browser / edge bundles that only
consume the client subpath don't pull server-side Node `fs` / transport
code. See ADR 23 §6 (Package layout) and ADR 40 §1.

## Status

| Phase                                                                                    | Status      |
| ---------------------------------------------------------------------------------------- | ----------- |
| **Client** (outbound, `@agentick/mcp`)                                              |             |
| #1 Skeleton — OAuth + protocol utilities + in-memory transport                           | ✅          |
| #2 `McpClientHarness` — Transport / Auth / Protocol / Lifecycle                          | ✅          |
| #3 `withMCP` extension + ToolBridge integration                                          | ✅          |
| #4 ElicitationBridge — server→client `elicitation/create` routing                        | ✅          |
| #134a URL-mode elicit transport layer                                                    | ✅          |
| #134b OAuth-via-elicit — URL-mode elicit on auth-needed                                  | ✅          |
| #146 Client completeness — resources / prompts / completion / sampling / roots / logging | ✅ (Wave 2) |
| #154 `withMCP` auto-wires OAuth elicit via transport factory                             | ⏳          |
| **Server** (inbound, `@agentick/mcp/server`)                                        |             |
| #171a `@agentick/tool/transforms` subpath (transform primitives)                    | ✅          |
| #171b Server subpath + spec types + `McpServerHarness` skeleton                          | ✅          |
| #171c stdio + in-memory transport + tools projection + security pipeline                 | ✅          |
| #310 **Tools `list_changed`** emission on `ToolCatalog` mutations                        | ✅          |
| #171d.1 **Prompts projection** (`prompts/list` + `prompts/get` + `list_changed`)         | ✅          |
| #171d.2.1 **Elicitation `ctx.elicit.*` sugar** (form-mode basics)                        | ✅          |
| #171d.2.2 **Elicitation URL mode + `tryX` variants + `UrlElicitationRequired`**          | ✅          |
| #171d.2.3 Elicitation schema-flatness validation (`assertFlatSchema`, #271)              | ✅          |
| #171d.3 Tasks projection (`tasks/list` + `tasks/get` + notifications)                    | ✅          |
| #171e Streamable HTTP transport (client + server, OAuth-threaded)                        | ✅ (Wave 1) |
| #171f WebSocket transport                                                                | ⏳          |
| #171g Direct projection (`mcp://gateway/<name>` URL form)                                | ⏳          |
| #171h Embedded Authorization Server (optional)                                           | ⏳          |
| #171i Conformance suite + testing helpers                                                | ⏳          |

Phase numbering tracks ADR 40 §"Migration / rollout plan."

## Architecture

```
                         ┌──────────────────────────────────┐
                         │       @agentick/mcp         │
                         │                                  │
withMCP({ servers })─────┤  CLIENT (outbound)               │
  per-session            │   McpClientHarness               │
  ToolBridge             │     ├ McpTransport               │
  ElicitBridge           │     ├ McpAuth (None/Bearer/OAuth)│
                         │     ├ McpProtocol (JSON-RPC)     │
                         │     └ McpLifecycle (states)      │
                         │                                  │
gateway.mcpServers ──────┤  SERVER (inbound)                │
  per-gateway            │   McpServerHarness               │
  ToolsProjection        │     ├ stdio / HTTP / WS listener │
  PromptsProjection      │     ├ ConnectionGuard            │
  (elicit, tasks, ...)   │     ├ Authenticator              │
                         │     ├ Authorizer                 │
                         │     ├ RateLimiter                │
                         │     └ InputSanitizer             │
                         └──────────────────────────────────┘
```

### Client side — one harness per (session, server)

`withMCP` is a **SessionExtension**. Each agentick session owns its own
`McpClientHarness` for each connected server. Multi-tenant correct from
day one — MCP binds OAuth tokens, `Mcp-Session-Id`, and authorization
to the connection; sharing across users would be a wire violation.

Discovered tools register into the session's `ToolExecutor`; inbound
`elicitation/create` from the server routes through
`bridges.elicitation.elicit`. The elicit address is fixed at harness
construction — no slot, no cross-session race; the SDK's
request-response registry handles concurrent in-session elicits via
per-correlation-id Deferreds.

### Server side — one harness per `McpServerOptions` at GATEWAY scope

An MCP server is **multi-tenant infrastructure** — many unrelated
clients connect concurrently. The harness is hosted at gateway scope
(NOT session scope; binding it to a single session would destroy the
multi-tenant property). One `McpServerHarness` instance per entry in
`createGateway({ mcpServers })`.

Per-connection state:

- `ConnectionGuard` evaluated once at accept time (trusted transports
  like `stdio` / `in-memory` short-circuit to accept).
- `Authenticator → Authorizer → RateLimiter → InputSanitizer` pipeline
  runs **on every request**, against the live `McpRequestContext`.
- Tool / prompt projection filter + transforms re-apply on every
  list AND every call/get — a tool or prompt hidden from list MUST NOT
  be reachable via call/get either.

See ADR 40 §3 for the full per-connection projection model.

## Client quickstart

```ts
import { withMCP, streamableHttpTransport, StdioClientTransport } from "@agentick/mcp";
import { createApp } from "@agentick/app";

const app = createApp({
  extensions: [
    withMCP({
      servers: [
        // Each server is identified by a `serverId` (an alias YOU assign —
        // tool names are prefixed `<serverId>__<tool>`) and a `transport`.
        {
          serverId: "docs-server",
          transport: streamableHttpTransport({ url: "https://example.com/mcp" }),
        },
        {
          serverId: "filesystem",
          transport: new StdioClientTransport({
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
          }),
        },
      ],
    }),
  ],
});

// Discovered tools are now in the session's ToolExecutor — model can
// call them directly. Inbound elicits flow through ElicitationHarness.
```

**Model-narration opt-out.** MCP tools narrate by default (the framework
injects an optional `_summary` field into every model-facing tool schema so
the model can self-narrate a call — a per-tool + per-call token cost). Opt out
per-`withMCP` or per-server; a server-level `narrate` overrides the `withMCP`
default, and `undefined` at both levels leaves the framework default (ON):

```ts
withMCP({
  narrate: false, // every MCP tool here opts out of `_summary`
  servers: [
    { serverId: "docs", transport },
    { serverId: "fs", transport, narrate: true }, // …except this one, back ON
  ],
});
```

**Execution provenance.** Every discovered tool's declaration is stamped
`annotations.executedBy: "mcp:<serverId>"` (`mcpDeclaration`), so its
`ToolResultBlock.executedBy` is attributed to the MCP server rather than the
framework's default `"agentick"`. This is a server-side, in-process stamp; the
field is absent from `ClientToolAnnotations` and stripped at the wire fold, so
no remote client can spoof MCP provenance. See `ToolAnnotations.executedBy` and
the tool-executor README.

## Server quickstart

```ts
import { McpServerHarness, stdioTransport, bearerTokenAuth } from "@agentick/mcp/server";

const server = new McpServerHarness(scopeId, journal, bus, inbox, {
  name: "my-server",
  transports: [stdioTransport()],

  // Tools — accepts `CreatedTool[]` shorthand OR the projection-config
  // object. The array form is the 90% case; the config form adds
  // per-connection projection rules (filter + transforms).
  tools: [
    createTool({
      name: "echo",
      description: "Echo the input",
      handler: async ({ text }) => [{ type: "text", text }],
    }),
    /* ... more CreatedTool entries ... */
  ],

  // Prompts — declarative array shorthand. Server constructs the
  // Prompts source internally; lifecycle is owned by the server.
  prompts: [
    {
      name: "summarize",
      description: "Summarize a passage",
      arguments: [{ name: "text", required: true }],
      render: ({ text }) => [
        { kind: "message", role: "user", content: [{ type: "text", text: `Summarize: ${text}` }] },
      ],
    },
    { name: "translate", description: "Translate to French", template: "Translate to French." },
  ],

  // Auth — pluggable five-stage security pipeline (defaults are
  // transport-aware).
  auth: {
    authenticator: bearerTokenAuth({ tokens: { "secret-1": { id: "alice", roles: ["admin"] } } }),
  },
});

await server.ready;
await server.start();

// Runtime mutation — `server.prompts` exposes the resolved Prompts
// source regardless of which form constructed it. Register new prompts
// or update existing ones at any time after start:
await server.prompts!.register({
  declaration: { name: "rephrase", description: "Rephrase", template: "Rephrase." },
});
```

### The `tools` slot — accepted shapes

```ts
// Form A — array shorthand (the 90% case)
tools: [Calculator, Search, Translate];                 // each: CreatedTool

// Form C (inline) — config object: CreatedTool[] + projection rules
tools: {
  tools: [Calculator, Search],
  filter: (tool, ctx) => ctx.mcp.user?.roles?.includes("admin") || !tool.name.startsWith("admin_"),
  transforms: [prefix("v2_")],
}

// Form C (low-level escape hatch) — explicit registry + handler resolver
// for custom resolution (lookup tables, late-bound dispatch),
// dynamic registries, or projection-layer tests
tools: {
  registry: [/* ToolDeclaration[] */],
  resolveHandler: (handlerRef) => /* (input, ctx) => Promise<ContentBlock[]> */ null,
  filter, transforms,
}
```

**Form B (a `Tools` instance via `use:`) is intentionally absent** —
blocked on `DispatchInput.ctxOverride` spec evolution. The
`ToolExecutorProtocol.dispatch` path builds its own `ToolHandlerCtx`
and would clobber the MCP-server `transport: "mcp"` + `mcp.*` fields.
Filed as a follow-up. For now, adopters with an existing executor can
project its registry via the low-level form.

**Per-connection projection** — `filter` decides visibility; hidden
tools are invisible to BOTH `tools/list` AND `tools/call`. `transforms`
rewrites declarations (name/metadata/schema) per-connection — adopters
build with the helpers in `@agentick/tool/transforms`.

**Reactive `registry` — the `ToolCatalog` primitive** — the `registry`
field of the low-level form accepts EITHER a static `ToolDeclaration[]`
OR a live `ToolCatalog` from `@agentick/tool`. When an adopter
passes a catalog, the server subscribes to mutations at connection
accept and emits `notifications/tools/list_changed` to every connected
client, per MCP protocol. Post-notification `tools/list` sees the
updated set. Static arrays wrap internally as a no-op-subscribe
catalog — zero migration cost, no notifications ever fire.

```ts
import { createToolCatalog } from "@agentick/tool";

const catalog = createToolCatalog([Calculator.declaration]);
tools: { registry: catalog, resolveHandler: myResolver };

// Later — connected clients get `tools/list_changed` and refetch:
catalog.register(NewTool.declaration);
catalog.remove("old_tool");
catalog.setAll([...]);
```

Symmetric with the prompts `list_changed` path (#171d.1). Resources
`list_changed` is deferred to #123 (resource runtime does not yet exist).

### The `prompts` slot — three accepted shapes

```ts
// Form A — array shorthand (the 90% case)
prompts: [
  { name: "summarize", description: "...", render: ({ text }) => [...] },
]

// Form B — pre-built `Prompts` instance directly (no wrapper)
prompts: somePromptsInstance,

// Form C — config object: declarations OR a pre-built instance,
// plus per-connection visibility filter
prompts: {
  declarations: [/* ... */],   // OR
  use: somePromptsInstance,    // ← "use this prompts source"
  filter: (decl, ctx) => ctx.mcp.user !== null || decl.metadata?.visibility === "public",
}
```

**Lifecycle ownership:**

- Forms A and C-with-`declarations` → server constructs the source
  internally; `server.close()` closes it.
- Forms B and C-with-`use:` → adopter owns the source's lifecycle;
  `server.close()` leaves it alone (adopter must close it explicitly).

**Runtime access:** `server.prompts: Prompts | null` exposes the
resolved source for register / update / remove / reload regardless of
how it was constructed.

### The `instructions` slot — per-connection server guidance

`instructions` projects into the MCP `InitializeResult.instructions`
field — free-form guidance a client surfaces to its model on how to use
the server. A fixed `string`, or a `(ctx) => string | Promise<string>`
computed per `initialize` from the same request/auth context tool
handlers see (so the text can vary by the authenticated identity). The
function form is evaluated **once per connection** — never cached across
connections.

```ts
new McpServerHarness(scopeId, journal, bus, inbox, {
  name: "my-server",
  transports: [httpTransport({ port: 3000 })],
  auth: { authenticator: bearerTokenAuth({ tokens: { "tok-alice": { id: "alice" } } }) },

  // Static form:
  instructions: "Prefer the `search` tool before `fetch`. Cite sources.",

  // Or per-connection, identity-aware (v1 injects live user/company context here).
  // The authenticator resolves `ctx.mcp.user` before the fn runs, so a
  // function can greet the caller / scope guidance to their role:
  instructions: async (ctx) => {
    const who = ctx.mcp.user?.id ?? "guest";
    return `You are connected as ${who}. Use company-scoped tools only.`;
  },
});
```

Reads client-side as `client.getInstructions()`. Absent slot → no
`instructions` on the wire.

### Argument completion — prompts AND resource templates

The `completions` slot carries per-argument completion handlers, built
with the `complete*` sugar (`completeFromList`, `completeFromEnum`,
`completeDependent`, `completeFromAsync`, `completePrefixMatch`). Two
maps, same handler type:

- `prompts` — keyed by prompt name → argument name. Routed from a
  `completion/complete` request with `ref.type === "ref/prompt"`.
- `resources` — keyed by resource-template `uriTemplate` → variable
  name. Routed from `ref.type === "ref/resource"` (the request's
  `ref.uri` is the template uri).

```ts
import { completeFromList, completeDependent } from "@agentick/mcp/server";

completions: {
  prompts: {
    greet: { name: completeFromList(["Ada", "Alan", "Grace"]) },
  },
  resources: {
    "db://{table}/{row}": {
      table: completeFromList(["invoices", "projects", "contacts"]),
      // Dependent completion: needs a resolved sibling variable.
      row: completeDependent({ requires: ["table"] }, async (typed, { table }) => {
        const rows = await db.rows(table, typed);
        return rows.map((r) => r.id);
      }),
    },
  },
}
```

The `completions` capability is advertised when **either** map carries a
handler. An unknown prompt / template / argument resolves to an empty
value list (clients probe freely — no protocol error). Output is capped
at 100 values (spec-mandated); the sugar enforces it.

### Signalling step-up auth from a tool — `wwwAuthenticateMeta`

When a tool needs the caller to (re)authenticate mid-session, it can
attach an RFC 6750 `Bearer` challenge to its `CallToolResult._meta`
under the `mcp/www_authenticate` key. A host that understands the signal
triggers step-up auth without tearing the connection down.

```ts
import { wwwAuthenticateMeta } from "@agentick/mcp/server";

createTool({
  name: "post_invoice",
  handler: async (input, { ctx }) => {
    if (!ctx.mcp.user?.roles?.includes("billing")) {
      return {
        content: [{ type: "text", text: "Re-authentication required for billing." }],
        isError: true,
        _meta: wwwAuthenticateMeta({
          resourceMetadataUrl: "https://api.example.com/.well-known/oauth-protected-resource",
          scope: "invoices:write",
          error: "insufficient_scope",
        }),
      };
    }
    /* ... */
  },
});
```

`wwwAuthenticateMeta({ resourceMetadataUrl?, scope?, error? })` produces
`{ "mcp/www_authenticate": "Bearer …" }`; a bare `wwwAuthenticateMeta()`
yields `{ "mcp/www_authenticate": "Bearer" }`. It is **opt-in** — nothing
auto-invokes it. The underlying `buildWwwAuthenticate(...)` is the SAME
challenge builder the HTTP transport's `401` pre-gate uses, so the two
never drift.

### HTTP transports — listener vs. middleware door

Two server-side Streamable-HTTP shapes, both wrapping the SDK
`StreamableHTTPServerTransport` and sharing one session-routing core
(per-`Mcp-Session-Id` dispatch, SSE, DELETE teardown, RFC 9728 discovery
+ `401` pre-gate are identical between them):

- **`httpTransport({ port })`** — owns a listening socket (or attaches to
  a caller-supplied `http.Server` via `{ server }`). Use it when Agentick
  owns the HTTP endpoint.
- **`httpMiddlewareTransport()`** — owns NO socket. `listen()` merely
  captures the harness closures; the **host** drives requests through
  `handler(req, res, parsedBody?)` from inside its own middleware chain.
  Use it when the process already owns an express / Nest / Fastify server
  — appending a bare `server.on("request")` listener would be **shadowed**
  by the framework's catch-all 404 (express is listener #1 and answers
  first). A middleware door runs _inside_ the chain, so it is reached.

```ts
import { httpMiddlewareTransport } from "@agentick/mcp/server";

const mcp = httpMiddlewareTransport({ oauth: { metadata } });
const server = new McpServerHarness(scopeId, journal, bus, inbox, {
  name: "my-server",
  transports: [mcp],
  tools: [/* ... */],
  auth: { authenticator: bearerTokenAuth({ tokens }) },
});
await server.ready;
await server.start(); // captures the accept + pre-gate closures

// RFC 9728 discovery lives at the SERVER ROOT, outside the MCP mount.
// Wire it as a top-level middleware so `req.url` keeps the full path:
app.use((req, res, next) => {
  if (mcp.metadataHandler(req, res)) return; // served the metadata doc
  next();
});

// The MCP endpoint, mounted anywhere. `express.json()` may consume the
// body first — pass `req.body` so the SDK doesn't try to read the stream
// twice. Works with OR without a prior body parser.
app.use("/mcp", express.json(), (req, res) => {
  void mcp.handler(req, res, req.body);
});
```

Nest is the same shape — resolve the underlying Node `req`/`res` (e.g.
`@Req()` / `@Res()` with `express` under the hood, or Fastify's `.raw`)
and call `mcp.handler(req, res, body)` from the route handler. The `401`
pre-gate (RFC 6750 `WWW-Authenticate`) and session lifecycle behave
exactly as in the listening transport.

### Eliciting input from the user (`ctx.elicit.*`)

**Elicitation is ON by default.** Tool handlers receive `ctx.elicit`
whenever the connected client advertised the `elicitation` capability;
no server-side opt-in needed. Adopters with specific constraints can
disable it explicitly:

```ts
new McpServerHarness(..., {
  // ... other options
  elicit: false,  // forbid ctx.elicit on this server, period
})
```

Tool handlers MUST still check `ctx.elicit` for presence — clients
that didn't advertise the capability leave it `undefined`:

```ts
const handler = async (input, ctx) => {
  if (!ctx.elicit) {
    // Client didn't advertise elicitation capability — handle gracefully.
    return [{ type: "text", text: "Cannot prompt user — please supply input directly." }];
  }

  // Throws ElicitationDeclined / ElicitationCancelled on those outcomes.
  const name = await ctx.elicit.text("Your name?", { default: "Ada" });
  const role = await ctx.elicit.select("Role?", ["admin", "viewer"] as const);
  const confirmed = await ctx.elicit.confirm(`Apply as ${role}?`);

  return [{ type: "text", text: `OK ${name}, role=${role}, confirmed=${confirmed}` }];
};
```

**Form-mode methods** — `text` / `confirm` / `boolean` / `number` /
`select` / `multiSelect`. Decline and cancel surface as thrown
`ElicitationDeclined` / `ElicitationCancelled` (both `AgentickError`
subclasses under the `ElicitError` abstract intermediate, per ADR 41).

**`try*` variants** — `tryText`, `trySelect`, `tryMultiSelect`,
`tryConfirm`, `tryNumber`, `tryBoolean`, `tryUrl` — return an
`ElicitOutcome<T>` discriminated union instead of throwing. Use when
you want to handle decline/cancel as normal control flow:

```ts
const outcome = await ctx.elicit!.tryConfirm("Apply changes?");
if (outcome.status === "accept" && outcome.value) {
  // proceed
} else if (outcome.status === "decline") {
  return [{ type: "text", text: "User declined; no changes applied." }];
} else {
  return [{ type: "text", text: "Cancelled." }];
}
```

**URL mode** — `ctx.elicit!.url({ message, url })` directs the user
to an external URL for out-of-band consent (OAuth, payment,
credential entry). `accept` means the user CONSENTED to navigate;
actual flow completion arrives via a separate notification path. Use
`tryUrl(...)` for the non-throwing variant.

**Deferred auth** — `ctx.elicit!.requireUrls([...])` throws
`UrlElicitationRequired` (JSON-RPC code `-32042`) carrying one or
more URL specs. The canonical pattern for OAuth-style retry: the
tool handler detects "user must complete X first," packages the
URLs, and never returns. The client's tool wrapper recognizes the
-32042 code, walks the URLs, then retries the originating tool call.

```ts
// Inside a tool handler:
if (!hasGoogleToken) {
  ctx.elicit!.requireUrls([{ message: "Sign in to Google", url: oauthUrl }]);
  // unreachable
}
```

Note on MCP capability semantics: elicitation is a **client**
capability, not server. The server doesn't advertise it on the wire —
it just issues `elicitation/create` requests when the connected
client opted in. `ctx.elicit` is `undefined` when the client didn't
advertise; tool handlers must check for presence before use.

For introspection, `server.elicitEnabled: boolean` reports the
server's policy flag (`true` by default; `false` only when the
adopter explicitly opted out via `elicit: false`). This is the
server's intent — actual availability per request still depends on
the connected client's capability.

**Cross-transport portability (ADR 43).** The `ctx.elicit` surface
a tool handler sees inside an MCP-server projection is structurally
identical to the `ctx.elicit` an in-process tool handler sees, and
identical again to `session.elicit` exposed on
`SessionHarnessProtocol`. Same `Elicit` interface, same six form
methods + URL mode + tryX variants + `requireUrls` deferred-auth.
Adopter code is portable across all three call sites — write the
handler once, project to either transport. The unified
`ToolHandlerCtx` carries a `transport: "in-process" | "mcp"`
discriminator + an optional `mcp?: McpRequestExtras` sub-slot for
the MCP-wire identity material (`serverId`, `connectionId`,
`clientCapabilities`, `sendProgress`).

The same instance-or-config pattern (see ADR 42 — coming) propagates
to other harness-backed slots (`tools`, `skills`, `tasks`, ...) as
they migrate. Adopters should never need to type "Harness" anywhere
in their code — "Harness" is framework vocabulary.

### Standalone Mode A

For Mode A deployment (`npx agentick-mcp-server --config server.config.ts`),
use `spawnStandaloneMcpServer` — it synthesizes a minimal gateway
shell, mounts the same harness, and stays running until the transport
closes.

```ts
import { spawnStandaloneMcpServer } from "@agentick/mcp/server";

const handle = await spawnStandaloneMcpServer({
  name: "my-server",
  transports: [stdioTransport()],
  tools: {
    /* ... */
  },
});

// `spawnStandaloneMcpServer` already awaited `start()` — the process is
// now serving traffic over stdio. `handle` is `{ harness, close }`.
```

## Per-connection projection model

Every request that reaches a tool or prompt handler has been:

1. **Connection-guarded** (once, at accept) — origin / CIDR / glob
   allow-lists for HTTP/WS; stdio + in-memory short-circuit.
2. **Authenticated** — `Authenticator` populates `ctx.mcp.user`; HTTP/WS
   default-reject without explicit config, stdio defaults to allow-all.
3. **Authorized** — `Authorizer` gates the operation against `ctx.mcp.user`
   - the `OperationInfo` (type + name).
4. **Rate-limited** — per-principal budget (default: sliding window).
5. **Sanitized** — `InputSanitizer` runs on `tool_call` inputs only.

Then:

6. **Filtered** — `tools.filter` / `prompts.filter` evaluated against
   the post-auth `McpRequestContext`. Hidden entries are unreachable.
7. **Transformed** — `tools.transforms` rename/prefix/restrict/etc.
   the projected view (`prompts.transforms` lands later — see roadmap).

The `McpRequestContext` flowing into a handler carries `user`,
`clientInfo`, `clientCapabilities`, `clientRoots` (ADR 65, below),
`signal` (for cancellation), the universal `log` / `progress` signal
slots (ADR 64, below), and adopter `metadata`. See
[`spec/protocol/mcp-server-harness.ts`](../spec/src/protocol/mcp-server-harness.ts).

### Roots — both directions, composed not owned (ADR 65)

MCP **roots** are `file://` boundaries a _client_ exposes to a _server_
(advisory scoping — "operate within these dirs"; not enforced
containment, not content transfer — that is resources, ADR 62). Agentick
models roots as a **projection over existing primitives, NOT a
`RootsHarness`** (ADR 65): mount state stays owned by the sandbox, reads
by resources, and MCP is one projection of both.

**Outbound (we are a client → a remote server).** The client harness
takes a `roots` source (`McpRootsSource`): a static list, a provider fn,
or the sandbox adapter. The source is **pluggable — roots work standalone
with no sandbox**. The server pulls via `roots/list`; the client pushes
`notifications/roots/list_changed` via `notifyRootsListChanged()`. The
sandbox↔roots adapter (`sandboxRootsSource` / `bindSandboxRootsToClient`)
lives in `@agentick/sandbox/mcp` — the client core stays decoupled.

**Inbound (we are a server ← a connecting client).** When a client
advertises the `roots` capability, the server harness pulls its
`roots/list` after `initialize` and re-pulls on
`notifications/roots/list_changed`, surfacing the result on
`ctx.mcp.clientRoots`. This is **per-connection and isolated** —
connection A's roots never appear on connection B's ctx (structural, like
the `connectionScope` discipline for signals). It is fire-and-forget:
`clientRoots` is `undefined` when the client didn't advertise `roots` (or
before the first pull resolves), and a failed pull is never a control
path.

### Consuming a remote server's resources (ADR 62)

`withMCP` surfaces each connected server's **resources** into the
session's one `ResourcesHarness` (`session.resources` / `ctx.resource` /
`bridges.resources`). After tool discovery, for each server it pulls
`resources/list` + `resources/templates/list` and **proxy-registers**
every entry:

```
register("mcp://<alias>/<originalUri>", () => client.readResource(originalUri))
```

so the model reads them with the `resource_read` tool (from
`withResources()`), adopter code reads them via `session.resources`, and
our own MCP-server projection can re-expose them — all through one
interface (composition, not conflation). Re-surfaced on
`notifications/resources/list_changed`; unregistered on session close.
`withMCP` reaches the harness via `installer.resources` (the
AppHarness-wired single instance) — it does NOT construct one.

**Alias trust model (non-negotiable).** Every surfaced uri is keyed by
the **adopter alias** — the server's config `serverId`, assigned by
whoever wrote `withMCP({ servers })`. The convention is
`mcp://<alias>/<originalUri>` (alias = URI authority; original uri = the
path, round-tripped losslessly). The server's **self-reported name is an
UNTRUSTED display label** and is NEVER used for keying. A malicious or
buggy server that reports a name colliding with another server's alias
therefore cannot shadow that alias's namespace — tools
(`<alias>__<tool>`), resources (`mcp://<alias>/…`), and the server-info
projection all derive from the trusted alias alone.

### `mcpServerInfo` default projection (ADR 63)

The compiler surfaces one summary of connected servers into the model's
context, keyed by alias: display name/version (untrusted label),
connection state, and an advertised-capability summary
(tools/resources/prompts/…). It reads `bridges.mcp` **structurally** (no
`@agentick/mcp` import in the compiler binding — ADR 27), is lazy +
overridable (`<Project projectionKey="mcpServerInfo">`), and
provenance-tagged `default:mcpServerInfo`. The sync snapshot behind it is
`McpClientHarness.serverInfo` (`{ serverId, status, implementation,
capabilities }`).

### Runtime signals — `ctx.log` / `ctx.progress` are bus events, not sinks (ADR 64)

Wave 3a's `ctx.log` wrote the wire directly (`sendLoggingMessage`), so
a tool's log went nowhere unless it ran as an MCP server. ADR 64
reworks this. `ctx.log` / `ctx.progress` are now **universal
always-present** slots on every `ToolHandlerCtx`; each emits ONE
discrete bus event (`<surface>:signal:log` / `:progress`) scoped to the
connection. The MCP server side is now a **bus subscriber**:

- `installLogProjection({ sdkServer, state, bus, connectionScope })` —
  subscribes to `log` events for this connection and forwards to
  `notifications/message`, filtered by the client's `logging/setLevel`
  (installed only when the `logging` capability is advertised).
- `installProgressProjection({ sdkServer, bus, connectionScope })` —
  subscribes to `progress` events and forwards to
  `notifications/progress`. Progress is **not** capability-gated in the
  MCP spec (no `setLevel` equivalent), so it installs unconditionally
  per connection.

Both fire-and-forget and swallow send-on-closed. The old direct log
sink and the `McpRequestExtras.sendProgress` callback are retired — one
emit seam, projections subscribe.

**Client-token correlation (`ctx.mcp.progressToken`).** A `tools/call`
carrying `_meta.progressToken` surfaces that token on
`ctx.mcp.progressToken`. A handler passes it straight to
`ctx.progress(token, …)`; the progress projection echoes it verbatim
onto the wire, so the client SDK correlates the notification back to its
in-flight call (its `onprogress` fires). Only `tools/call` carries a
progress token in the MCP spec — `prompts/get` and
`completion/complete` have no `_meta.progressToken`, so the token is
threaded only on the tool-call path.

**Cross-connection isolation is structural.** Each connection's
projections subscribe with a `connectionScope` filter
(`{ mcpConnectionId, mcpServerId }`) and the per-request ctx stamps that
scope on every signal, so a tool's log/progress over connection A never
reaches connection B — the load-bearing multi-tenant guarantee.

Verified by:

- `src/server/__tests__/projection-completions-logging.spec.ts` — log
  round-trip + level filter.
- `src/server/__tests__/progress.spec.ts` — `ctx.progress` →
  `notifications/progress` correlated to the client's `_meta.progressToken`
  (explicit-token wire equality + real SDK `onprogress`).
- `src/server/__tests__/cross-connection-isolation.spec.ts` — two
  clients on one server; A's log + progress never reach B
  (mutation-checked: dropping the `connectionScope` filter makes B leak).
- `src/server/__tests__/below-level-log-bus-emit.spec.ts` — a below-level
  `debug` log is dropped by the MCP projection yet still observable on
  the bus (each projection applies its own threshold).

## Capability negotiation

The server's `initialize` response advertises only what's actually
wired. **No "we support X but it returns empty" lies on the wire.**

| Capability    | Advertised when                                                                                                                               |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools`       | `tools` slot set AND the resolved registry is non-empty                                                                                       |
| `prompts`     | `prompts` slot set (with `listChanged: true`)                                                                                                 |
| `resources`   | a Resources source is wired (ADR 62) — advertises `subscribe` + `listChanged`                                                                 |
| `elicitation` | client capability, never advertised server-side; the server issues `elicitation/create` when the client advertised it AND `elicit` is enabled |
| `tasks`       | at least one tool declares `taskSupport: "required" \| "supported"`                                                                           |
| `sampling`    | (wired with `SamplingHarness` — pending)                                                                                                      |

Adopter `options.capabilities` can opt **OUT** of an otherwise-wired
capability (`{ tools: false }` hides a populated tools registry) but
cannot opt IN to something that isn't wired.

## Conformance

`@agentick/mcp/testing` ships `runMcpConformance` — the executable
suite that drives every landed capability. Unlike the sibling harness
conformance suites (which validate a single implementation of a
protocol interface), MCP has TWO roles that must interoperate, so the
suite is organized in three parts. It is the finalizer/verifier track:
**adding a capability = adding a section**, never a rewrite.

```ts
// packages/mcp/src/testing/__tests__/conformance.spec.ts
import { runMcpConformance } from "@agentick/mcp/testing";
runMcpConformance();
```

- **Part A — LOOPBACK.** A real `McpServerHarness` ↔ a real
  `McpClientHarness` over the linked in-memory transport. Both roles
  live here; both wrap `@modelcontextprotocol/sdk`. Exercises OUR
  translation layers on both sides — no fakes (real transport, real
  harnesses, real substrate; only the "model" is scripted, via direct
  verb calls). Covers initialize + negotiation, tools (list / call /
  list_changed), prompts (list / get / list_changed), resources (list /
  read text+blob / templates / list_changed), completion (prompt-arg),
  logging (setLevel + `ctx.log` + level filter), elicitation (form + url
  round-trips through a client-side `ElicitationHarness`), and tasks
  (Pattern B: `callToolAsTask` → get / result / list / cancel).

  The suite imports NO concrete sibling harness — the caller injects
  `ResourcesHarness` / `PromptsHarness` / `ElicitationHarness` via
  `McpConformanceFactories` (the `runTimelineStoreConformance` pattern),
  so `@agentick/resources` stays a dev dependency instead of leaking
  into mcp-next's runtime graph.

- **Part B — REAL-PEER.**
  - **B1 (always on):** the raw SDK reference `Client` drives OUR server.
    It applies no agentick client-side normalization, so it exercises the
    pure wire shape and reaches verbs our client harness doesn't expose
    (`resources/subscribe` → `updated`, `unsubscribe`, `ping`, capability
    negotiation via `getServerCapabilities`).
  - **B2 (gated → skipped by default):** the SDK reference server
    `@modelcontextprotocol/server-everything` drives OUR client harness
    over stdio. This is the ONLY peer that catches wire-shape drift the
    shared-SDK loopback can't (both loopback sides share the SDK). Enable
    it by installing the package (auto-detected via `require.resolve`) or
    setting `MCP_REFERENCE_SERVER=1`. Run the official inspector against
    our server the same way:
    `npx @modelcontextprotocol/inspector node ./src/server/bin.ts`.
- **Part C — VERSION MATRIX.** Part A re-run against both `draft` and
  `2025-11-25` client eras via the era codec. Because `selectCodec`
  currently collapses every version to the `draft` passthrough, this is
  a forward guard: it proves the loopback is stable whichever era is
  configured and gives a real `2025-11-25` codec a landing spot with
  tests when it ships.

Skipped-by-design sections (each a `describe.skip` seam):
server→client **sampling** (no `SamplingHarness` yet) and the Part B2
reference-server round-trip (until the package is a dev dep).

## Verified by

### Client

- `src/__tests__/harness.spec.ts` — McpClientHarness lifecycle states
  (Idle → Initializing → Ready / Failed / Closed), tool discovery,
  callTool dispatch round-trip.
- `src/__tests__/with-mcp-e2e.spec.ts` — `withMCP` end-to-end through
  a session: tools discovered on session start, model-issued `callTool`
  routes through the harness.
- `src/integration/__tests__/resource-surface.spec.ts` — alias helpers
  round-trip; `surfaceRemoteResources` proxy-registers under
  `mcp://<alias>/<uri>` (read round-trips to `client.readResource` with
  the ORIGINAL uri), templates strip the alias, pagination drains,
  teardown unsubscribes. **ADVERSARIAL alias-trust (differential):** two
  servers advertise the SAME uri and one self-reports the other's alias
  as its name — reads under each alias route to that server, neither
  shadows the other (the trusted `serverId` governs, not the self-name).
- `src/__tests__/with-mcp-resources-e2e.spec.ts` — real MCP server
  resources surfaced under the alias, readable via `session.resources`
  AND the `resource_read` tool; `resources/list_changed` re-surfaces;
  session close unregisters.
- `@agentick/compiler-react` `default-projections.spec.tsx` — the
  `mcpServerInfo` projection surfaces servers keyed by alias
  (provenance `default:mcpServerInfo`, override suppresses), plus the
  adversarial server-info alias-trust differential (self-reported name
  is display-only, never a second/shadowing entry).
- `src/__tests__/elicit-bridge.spec.ts` — inbound `elicitation/create`
  → `ElicitationHarness.elicit` round-trip, accept/decline/cancel,
  schema validation.
- `src/__tests__/oauth-elicit.spec.ts` — `DefaultOAuthProvider` with
  `elicit` slot publishes URL-mode elicit when auth needed.
- `src/__tests__/task-bridge.spec.ts` — remote task fan-out (task
  notifications via shared LocalPubSub).
- `src/__tests__/task-codec.spec.ts` — wire codec for tasks
  (`taskSupport: "supported"` capability negotiation + per-call opt-in).
- `src/__tests__/skeleton.spec.ts` — every ported public export
  resolves; sanitization patterns; completion-builder 100-cap.
- `src/__tests__/wave2-client.spec.ts` — **Wave 2 (#146) client
  completeness** against a REAL in-memory SDK `Server`: `listResources`
  / `listResourceTemplates` / `readResource` (text + blob typing),
  `listPrompts` / `getPrompt` (embedded resource → resource block),
  `completePromptArgument` / `completeResourceTemplate`, sampling
  handler INVOKED on server-issued `sampling/createMessage` (+
  method-not-found when unconfigured), roots handler returns the
  configured list (+ provider re-evaluation), `setLoggingLevel` reaches
  the server and `notifications/message` surfaces via `onLogMessage`.
  Plus a `content-mapper` unit block: `structuredContent` / `isError` /
  embedded-resource-block preservation. **ADR 65 standalone roots** — a
  static list AND a provider fn served on `roots/list` with NO sandbox in
  the graph (the "roots works standalone" guarantee).

### Server

- `src/server/__tests__/end-to-end.spec.ts` — initialize handshake,
  `tools/list` projection (filter + transform), `tools/call` dispatch,
  handler errors surface as `isError: true` (NOT JSON-RPC protocol
  errors), multi-connection isolation, security-pipeline rejections.
- `src/server/__tests__/projection-prompts.spec.ts` — `prompts/list`,
  `prompts/get`, `notifications/prompts/list_changed` on
  register/update/remove, per-connection filter hides prompts from
  BOTH list AND get, `system → user` role flattening on the wire,
  unsubscribe-on-close prevents notification leak.
- `src/server/__tests__/projection-completions-logging.spec.ts` —
  argument completion (prompt AND resource-template: `ref/resource`
  routes by template uri → variable, unknown template/arg → empty,
  `context.arguments` reaches the handler, `completions` advertised on
  resource handlers alone, prompt + resource coexist) + logging
  projection: `ctx.log` → bus → `installLogProjection` →
  `notifications/message`, level filter via `logging/setLevel`,
  default-level emits everything, opt-out installs no projection (ADR 64
  re-sourcing of Wave 3a through the bus).
- `src/server/__tests__/instructions.spec.ts` — `instructions` projected
  into `InitializeResult.instructions` (read via `client.getInstructions()`):
  static string verbatim, function form evaluated per connection (not
  cached), async form, ctx-visible, and identity-visible over an
  authenticated HTTP crossing (`ctx.mcp.user` resolved before the fn).
- `src/server/transports/__tests__/http-middleware.spec.ts` —
  `httpMiddlewareTransport` mount door driven by a REAL host `http.Server`:
  full round-trip through `handler` with and without a prior body parser
  (`parsedBody` passthrough), the RFC 9728 `401` pre-gate firing through
  the door, `metadataHandler` serving discovery unauthenticated (+ `handler`
  serving it when forwarded), `Mcp-Session-Id` routing + DELETE teardown
  (stale-id → 404), foreign paths left to the host.
- `src/server/security/__tests__/www-authenticate.spec.ts` —
  `buildWwwAuthenticate` / `wwwAuthenticateMeta` challenge-string format:
  bare `Bearer`, `resource_metadata` parity with the pre-gate, `error` +
  `scope` params, ordering, and the `mcp/www_authenticate` `_meta` key.
- `src/server/__tests__/progress.spec.ts` — `ctx.progress` → bus →
  `installProgressProjection` → `notifications/progress` correlated to
  the client's `_meta.progressToken` (via `ctx.mcp.progressToken`):
  explicit-token wire equality + real SDK `onprogress` round-trip, and
  progress fires with logging opted out (no capability gate).
- `src/server/__tests__/cross-connection-isolation.spec.ts` — two
  clients on ONE server; a tool's `ctx.log` + `ctx.progress` over
  connection A reach NEITHER of connection B's notification handlers
  (mutation-checked against the `connectionScope` filter).
- `src/server/__tests__/inbound-roots-isolation.spec.ts` — **ADR 65
  inbound roots, per-connection isolation.** Two clients advertising
  DIFFERENT roots; a tool over connection A sees A's roots on
  `ctx.mcp.clientRoots` and NEVER B's (differential: positive presence AND
  negative absence); a `roots/list_changed` on A re-pulls A only, B
  untouched; a client that doesn't advertise `roots` leaves `clientRoots`
  undefined. Mutation-checked against a shared holder.
- `src/server/__tests__/below-level-log-bus-emit.spec.ts` — a
  below-level `debug` log the MCP projection drops (client set
  `warning`) is STILL observable by an independent bus subscriber; each
  projection applies its own threshold.
- `src/server/__tests__/skeleton.spec.ts` — `validateOptions`
  rejection paths (bad transports / tools / prompts shape) + connection
  tracking + lifecycle idempotency.
- `src/server/__tests__/spawn.spec.ts` — `spawnStandaloneMcpServer`
  wires the synthesized gateway + harness + transport correctly.
- `src/server/security/__tests__/pipeline.spec.ts` — every stage
  (ConnectionGuard / Authenticator / Authorizer / RateLimiter /
  InputSanitizer), transport-aware defaults, error mapping to JSON-RPC
  codes, `isMcpSecurityError` type guard against `McpServerError`
  subclasses.

## Connection lifecycle (client)

`withMCP` is a **SessionExtension** — one `McpClientHarness` per
(session, server). Each agentick session owns its own connection to
each MCP server. Multi-tenant correct from day one (MCP binds OAuth
tokens, `Mcp-Session-Id`, and authorization to the connection; sharing
across users is a wire violation). The elicit address is fixed at
harness construction; the SDK elicit handler routes inbound
`elicitation/create` via the substrate's inbox to that address. No
slot, no cross-session race, concurrent in-session elicits naturally
handled by the request-response registry's per-correlationId
Deferreds.

#### ⚠️ FUTURE OPTIMIZATION — connection pooling (track in coming weeks)

Per-session fan-out costs N×M connections for N sessions × M servers.
Acceptable for HTTP-remote streams; wasteful for stateless local stdio
servers (mcp-everything, filesystem) and for huge multi-tenant
deployments.

The follow-up is a **connection pool keyed by authentication
principal**:

- Pool holds open connections keyed by `(serverId, auth principal)`.
- Sessions **check connections out** for the duration of a tick / a
  callTool, and **check them back in** when done.
- Same principal → connection sharing (cheap). Different principals →
  isolation (correct).
- `Mcp-Session-Id` (Streamable HTTP) makes connections cleanly
  resumable across check-outs.

The pool sits **beneath** McpClientHarness — a
`connection: McpConnectionRef` indirection — so nothing above changes.
Defer until production load demands it; design space documented in
[`docs/proposals/v2/blueprint/23-mcp-as-harness.md`](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md).

## Roadmap & known gaps

### Client

- **Client protocol completeness (#146)** — **landed (Wave 2).**
  `McpClientHarness` now exposes `listResources` / `listResourceTemplates`
  / `readResource`, `listPrompts` / `getPrompt`, `completePromptArgument`
  / `completeResourceTemplate`, `setLoggingLevel` + `onLogMessage`, plus
  the inbound `samplingHandler` and `roots` seams (`notifyRootsListChanged`).
  Follow-ons: (a) the read verbs are declared as **addressable** commands,
  NOT `exposure: "wire"` — remote-grantee exposure needs a ratified
  verb-matrix row; (b) `roots` accepts a static list or provider fn, and
  the **sandbox-backed roots projection** (workspace + mounts, ADR 65) has
  **landed** in `@agentick/sandbox/mcp` (`sandboxRootsSource` /
  `bindSandboxRootsToClient`); (c) routing sampling
  to agentick's own executor by default is a Wave-3 ADR concern (the
  seam here takes an adopter-provided handler).
- **`#154 withMCP auto-wires OAuth elicit`** via transport factory
  pattern. Today adopters wire it manually through the OAuth provider
  slot.
- **Connection pool (deferred, coming weeks)** — see "Connection
  lifecycle (client)" above.
- **Streamable HTTP transport (client)** — **landed** (Wave 1).
  `streamableHttpTransport({ url, oauth })` (from the package root)
  builds the SDK `StreamableHTTPClientTransport` and threads the
  `DefaultOAuthProvider` (elicit + credentials + interactive) into its
  `authProvider`, so the SDK's 401 → authorize → `finishAuth` → retry
  flow is reachable. Drop it into `withMCP({ servers: [{ transport }] })`.
  Not yet exercised: a full end-to-end OAuth dance against a live IdP
  (needs an authorization server; the wiring + elicit-fire path are
  unit-verified).

### Server

- **Elicitation (`ctx.elicit.*`)** — **landed (#171d.2).** Adopter sugar
  on the request context for sending `elicitation/create` to connected
  clients (form + URL mode + `tryX` + `requireUrls` deferred-auth).
  Schema-flatness validation shipped via `assertFlatSchema` (#271).
- **Tasks projection (`tasks/list` + `tasks/get`)** — **landed (#171d.3).**
  Pattern B over the wire — a handler returning a `TaskHandle` routes
  through `tasks/get` / `tasks/result` / `tasks/cancel` / `tasks/list`
  with `notifications/tasks/status`; `tasks` advertised when any tool
  declares `taskSupport`.
- **Sampling (`ctx.sample.*`)** — server→client `sampling/createMessage`
  with v1's retry-loop sugar. Blocks on a `SamplingHarness` landing.
- **Inbound client roots (`ctx.mcp.clientRoots`)** — **landed (ADR 65).**
  Per-connection, isolated, pulled on initialize + re-pulled on
  `roots/list_changed`. Promotion to a unified cross-source mount registry
  (a `RootsHarness`) is gated on a real consumer for the inspectable view
  — see the `TODO(#237-4b / ADR-65)` seam markers + ADR 65 for the trigger.
- **Resources (`resources/list` + `resources/read`)** — **landed (ADR 62).**
  The server projects an adopter-supplied Resources source over
  `resources/list` / `resources/templates/list` / `resources/read`
  (text + blob), with `subscribe` / `updated` / `list_changed`;
  `resources` advertised when a source is wired.
- **Per-connection `instructions`** — **landed.** `instructions: string |
  ((ctx) => string | Promise<string>)` projects into
  `InitializeResult.instructions`; the function form is evaluated per
  `initialize` against the identity-resolved request context (never cached
  across connections).
- **Resource-template argument completion** — **landed.** `completions.resources`
  keyed by template uri → variable → `CompletionHandler` (same `complete*`
  sugar as prompts); `ref/resource` routes to it, unknown template/arg →
  empty. (Closes the former `TODO(phase-#123)` `ref/resource` no-op.)
- **`wwwAuthenticateMeta` step-up helper** — **landed.** Opt-in builder for
  the RFC 6750 `Bearer` challenge inside a `CallToolResult._meta`
  (`mcp/www_authenticate`), sharing the pre-gate's challenge-string
  construction (`buildWwwAuthenticate`). Never auto-invoked.
- **Streamable HTTP transport (server)** — **landed** (Wave 1).
  `httpTransport({ port })` (from `@agentick/mcp/server`) is a
  multi-connection Streamable-HTTP listener wrapping the SDK
  `StreamableHTTPServerTransport`; per-`Mcp-Session-Id` routing, ephemeral
  ports (`port: 0`), and mounting on a caller-supplied `http.Server`. The
  existing security pipeline runs for HTTP connections (`McpConnectionInfo`
  built from the request). **OAuth Resource Server** (protected-resource
  metadata, token introspection at the server edge) is still future.
- **HTTP middleware door (`httpMiddlewareTransport`)** — **landed.** A
  socket-less Streamable-HTTP shape for hosts that own their own server
  (express / Nest / Fastify): `listen()` captures the harness closures, the
  host drives requests through `handler(req, res, parsedBody?)` from inside
  its middleware chain (avoiding the shadowed-`server.on("request")` 404
  problem). Shares the listener's session-routing core, `401` pre-gate, and
  RFC 9728 discovery (`metadataHandler`); `parsedBody` threads a
  host-parsed body (e.g. `express.json()`) through to the SDK.
- **WebSocket transport** — #171f.
- **Direct projection** — `mcp://gateway/<name>` URL form lets
  in-process clients call the projection layer without serialization.
  Lands with #171g.
- **Embedded Authorization Server** — optional; can lag the
  Resource Server (#171e). Lands with #171h.
- **Conformance suite** — pluggable `runMcpServerConformance` for
  adopters' custom transports. Lands with #171i.

@see [ADR 23 — MCP as harness](../../docs/proposals/v2/blueprint/23-mcp-as-harness.md)
@see [ADR 40 — MCP server harness shape](../../docs/proposals/v2/blueprint/40-mcp-server-harness.md)
