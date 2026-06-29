# @agentick/mcp-next

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

| Import path                  | Purpose                                                                     |
| ---------------------------- | --------------------------------------------------------------------------- |
| `@agentick/mcp-next`         | **Client** harness + `withMCP` extension. Outbound: Agentick → MCP servers. |
| `@agentick/mcp-next/server`  | **Server** harness. Inbound: MCP clients → Agentick.                        |
| `@agentick/mcp-next/oauth`   | OAuth 2.1 utilities shared by both sides.                                   |
| `@agentick/mcp-next/testing` | In-memory transport + stub harnesses for tests.                             |

Subpath isolation is deliberate — browser / edge bundles that only
consume the client subpath don't pull server-side Node `fs` / transport
code. See ADR 23 §6 (Package layout) and ADR 40 §1.

## Status

| Phase                                                                            | Status               |
| -------------------------------------------------------------------------------- | -------------------- |
| **Client** (outbound, `@agentick/mcp-next`)                                      |                      |
| #1 Skeleton — OAuth + protocol utilities + in-memory transport                   | ✅                   |
| #2 `McpClientHarness` — Transport / Auth / Protocol / Lifecycle                  | ✅                   |
| #3 `withMCP` extension + ToolBridge integration                                  | ✅                   |
| #4 ElicitationBridge — server→client `elicitation/create` routing                | ✅                   |
| #134a URL-mode elicit transport layer                                            | ✅                   |
| #134b OAuth-via-elicit — URL-mode elicit on auth-needed                          | ✅                   |
| #154 `withMCP` auto-wires OAuth elicit via transport factory                     | ⏳                   |
| **Server** (inbound, `@agentick/mcp-next/server`)                                |                      |
| #171a `@agentick/tool-next/transforms` subpath (transform primitives)            | ✅                   |
| #171b Server subpath + spec types + `McpServerHarness` skeleton                  | ✅                   |
| #171c stdio + in-memory transport + tools projection + security pipeline         | ✅                   |
| #171d.1 **Prompts projection** (`prompts/list` + `prompts/get` + `list_changed`) | ✅                   |
| #171d.2.1 **Elicitation `ctx.elicit.*` sugar** (form-mode basics)                | ✅                   |
| #171d.2.2 Elicitation URL mode + `tryX` variants + `URLElicitationRequiredError` | ⏳                   |
| #171d.2.3 Elicitation schema-flatness validation + advanced shapes               | ⏳                   |
| #171d.3 Tasks projection (`tasks/list` + `tasks/get` + notifications)            | ⏳ (scoping pending) |
| #171e Streamable HTTP transport + OAuth Resource Server                          | ⏳                   |
| #171f WebSocket transport                                                        | ⏳                   |
| #171g Direct projection (`mcp://gateway/<name>` URL form)                        | ⏳                   |
| #171h Embedded Authorization Server (optional)                                   | ⏳                   |
| #171i Conformance suite + testing helpers                                        | ⏳                   |

Phase numbering tracks ADR 40 §"Migration / rollout plan."

## Architecture

```
                         ┌──────────────────────────────────┐
                         │       @agentick/mcp-next         │
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
import { withMCP } from "@agentick/mcp-next";
import { createApp } from "@agentick/app-next";

const app = createApp({
  extensions: [
    withMCP({
      servers: [
        { name: "linear", url: "https://mcp.linear.app" },
        {
          name: "filesystem",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        },
      ],
    }),
  ],
});

// Discovered tools are now in the session's ToolExecutor — model can
// call them directly. Inbound elicits flow through ElicitationHarness.
```

## Server quickstart

```ts
import { McpServerHarness, stdioServerTransport, bearerTokenAuth } from "@agentick/mcp-next/server";

const server = new McpServerHarness(scopeId, journal, bus, inbox, {
  name: "my-server",
  transports: [stdioServerTransport()],

  // Tools — registry + handler resolver, plus per-connection projection.
  tools: {
    registry: [
      /* ToolDeclaration[] */
    ],
    resolveHandler: (ref) => /* concrete async handler or null */ null,
    filter: (tool, ctx) => ctx.user?.roles?.includes("admin") || !tool.name.startsWith("admin_"),
  },

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
  filter: (decl, ctx) => ctx.user !== null || decl.metadata?.visibility === "public",
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

The sugar covers `text` / `confirm` / `boolean` / `number` / `select`
/ `multiSelect` for form-mode requests. Decline and cancel surface as
thrown `ElicitationDeclined` / `ElicitationCancelled` (`try*` variants
returning {@link ElicitOutcome} land with #171d.2.2). URL mode + the
`URLElicitationRequiredError` -32042 deferred-auth path land with
#171d.2.2 too.

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

> **Asymmetry with the in-process flow** — `session.elicit` (the
> in-process counterpart to `ctx.elicit`) doesn't exist yet. Today
> the in-process path exposes `session.elicitation:
ElicitationHarnessProtocol` (raw protocol) but no `Elicit` sugar.
> Tracked as a follow-up task; the goal is symmetric `Elicit`
> ergonomics regardless of where the tool handler runs.

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
import { spawnStandaloneMcpServer } from "@agentick/mcp-next/server";

const handle = await spawnStandaloneMcpServer({
  name: "my-server",
  transports: [stdioServerTransport()],
  tools: {
    /* ... */
  },
});

await handle.ready;
// process now serves traffic over stdio
```

## Per-connection projection model

Every request that reaches a tool or prompt handler has been:

1. **Connection-guarded** (once, at accept) — origin / CIDR / glob
   allow-lists for HTTP/WS; stdio + in-memory short-circuit.
2. **Authenticated** — `Authenticator` populates `ctx.user`; HTTP/WS
   default-reject without explicit config, stdio defaults to allow-all.
3. **Authorized** — `Authorizer` gates the operation against `ctx.user`
   - the `OperationInfo` (type + name).
4. **Rate-limited** — per-principal budget (default: sliding window).
5. **Sanitized** — `InputSanitizer` runs on `tool_call` inputs only.

Then:

6. **Filtered** — `tools.filter` / `prompts.filter` evaluated against
   the post-auth `McpRequestContext`. Hidden entries are unreachable.
7. **Transformed** — `tools.transforms` rename/prefix/restrict/etc.
   the projected view (`prompts.transforms` lands later — see roadmap).

The `McpRequestContext` flowing into a handler carries `user`,
`clientInfo`, `clientCapabilities`, `signal` (for cancellation),
`sendProgress` (when client supports it), and adopter `metadata`. See
[`spec/protocol/mcp-server-harness.ts`](../spec/src/protocol/mcp-server-harness.ts).

## Capability negotiation

The server's `initialize` response advertises only what's actually
wired. **No "we support X but it returns empty" lies on the wire.**

| Capability    | Advertised when                                             |
| ------------- | ----------------------------------------------------------- |
| `tools`       | `options.tools` set AND `options.tools.registry.length > 0` |
| `prompts`     | `options.prompts` set (with `listChanged: true`)            |
| `resources`   | (wired with #123 — pending)                                 |
| `elicitation` | (wired with #171d.2 — pending)                              |
| `tasks`       | (wired with #171d.3 — pending)                              |
| `sampling`    | (wired with `SamplingHarness` — pending)                    |

Adopter `options.capabilities` can opt **OUT** of an otherwise-wired
capability (`{ tools: false }` hides a populated tools registry) but
cannot opt IN to something that isn't wired.

## Verified by

### Client

- `src/__tests__/harness.spec.ts` — McpClientHarness lifecycle states
  (Idle → Initializing → Ready / Failed / Closed), tool discovery,
  callTool dispatch round-trip.
- `src/__tests__/with-mcp-e2e.spec.ts` — `withMCP` end-to-end through
  a session: tools discovered on session start, model-issued `callTool`
  routes through the harness.
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

- **`#154 withMCP auto-wires OAuth elicit`** via transport factory
  pattern. Today adopters wire it manually through the OAuth provider
  slot.
- **Connection pool (deferred, coming weeks)** — see "Connection
  lifecycle (client)" above.
- **Streamable HTTP transport** is the production transport. Today
  the client supports stdio + in-memory. Streamable HTTP lands
  alongside the server-side HTTP transport (#171e).

### Server

- **Elicitation (`ctx.elicit.*`)** — adopter sugar on the request
  context for sending `elicitation/create` to connected clients.
  Lands with #171d.2.
- **Tasks projection (`tasks/list` + `tasks/get`)** — per-connection
  task scoping decision pending. Lands with #171d.3.
- **Sampling (`ctx.sample.*`)** — server→client `sampling/createMessage`
  with v1's retry-loop sugar. Blocks on a `SamplingHarness` landing.
- **Roots (`ctx.roots.*`)** — workspace bridge (#124).
- **Resources (`resources/list` + `resources/read`)** — #123.
- **Streamable HTTP transport + OAuth Resource Server** — #171e. Today
  the server supports stdio + in-memory only. HTTP unlocks
  production deployment.
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
